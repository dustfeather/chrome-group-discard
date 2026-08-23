import { beforeEach, describe, expect, it } from "vitest";
import { handleGroupUpdated, handleTabUpdated } from "../src/background/discard";
import * as storage from "../src/storage";
import type { GroupColor, Snapshot } from "../src/types";
import { installFakeChrome, type FakeChrome } from "./fake-chrome";

const snapshot: Snapshot = {
    media: [{ selector: "video", currentTime: 30, paused: false }],
    fields: [],
};

const group = (over: Partial<chrome.tabGroups.TabGroup> = {}): chrome.tabGroups.TabGroup =>
    ({ id: 1, title: "Work", color: "blue", collapsed: true, windowId: 1, ...over }) as chrome.tabGroups.TabGroup;

const complete: chrome.tabs.OnUpdatedInfo = { status: "complete" };
const tabOf = (over: Partial<chrome.tabs.Tab>) => over as chrome.tabs.Tab;

let fake: FakeChrome;

function withTabs(hostPermission = true): FakeChrome {
    return installFakeChrome({
        hostPermission,
        tabs: [
            { id: 10, url: "https://a.example/", groupId: 1 },
            { id: 11, url: "https://b.example/", groupId: 1 },
            { id: 12, url: "https://other.example/", groupId: 2 },
        ],
        groups: [{ id: 1, title: "Work", color: "blue", collapsed: true }],
    });
}

describe("handleGroupUpdated", () => {
    beforeEach(() => {
        fake = withTabs();
        fake.executeScript.mockResolvedValue([{ result: snapshot }]);
    });

    it("discards every tab in the collapsed group and nothing else", async () => {
        await handleGroupUpdated(group());

        expect(fake.tabs.find((t) => t.id === 10)?.discarded).toBe(true);
        expect(fake.tabs.find((t) => t.id === 11)?.discarded).toBe(true);
        expect(fake.tabs.find((t) => t.id === 12)?.discarded).toBeUndefined();
    });

    it("discards audible and pinned tabs too — nothing is skipped", async () => {
        fake.tabs[0] = { ...fake.tabs[0], ...{ audible: true, pinned: true } } as never;
        await handleGroupUpdated(group());
        expect(fake.tabs.find((t) => t.id === 10)?.discarded).toBe(true);
    });

    it("stores a snapshot per tab, keyed by the id discard() returned", async () => {
        await handleGroupUpdated(group());

        expect(await storage.getSnapshot(10)).toMatchObject({ tabId: 10, url: "https://a.example/" });
        expect(await storage.getSnapshot(11)).toMatchObject({ tabId: 11, url: "https://b.example/" });
    });

    it("does nothing on expand", async () => {
        await handleGroupUpdated(group({ collapsed: false }));
        expect(fake.tabs.every((t) => !t.discarded)).toBe(true);
    });

    it("ignores untitled groups entirely", async () => {
        await handleGroupUpdated(group({ title: undefined }));
        expect(fake.tabs.every((t) => !t.discarded)).toBe(true);
        expect(await storage.getGroupRecords()).toEqual({});
    });

    it("records the group even when it only got renamed", async () => {
        await handleGroupUpdated(group({ collapsed: false }));
        const records = await storage.getGroupRecords();
        expect(records[storage.groupKey("Work", "blue")]).toMatchObject({ groupId: 1, excluded: false });
    });

    it("skips a group the user opted out of", async () => {
        await storage.setGroupRecords({
            [storage.groupKey("Work", "blue")]: {
                groupId: 1,
                title: "Work",
                color: "blue" as GroupColor,
                excluded: true,
            },
        });

        await handleGroupUpdated(group());

        expect(fake.tabs.every((t) => !t.discarded)).toBe(true);
    });

    it("keeps the exclusion when the group is renamed while collapsing", async () => {
        await storage.setGroupRecords({
            [storage.groupKey("Work", "blue")]: {
                groupId: 1,
                title: "Work",
                color: "blue" as GroupColor,
                excluded: true,
            },
        });

        await handleGroupUpdated(group({ title: "Job" }));

        const records = await storage.getGroupRecords();
        expect(records[storage.groupKey("Job", "blue")].excluded).toBe(true);
        expect(fake.tabs.every((t) => !t.discarded)).toBe(true);
    });
});

describe("handleGroupUpdated — snapshot permission", () => {
    it("discards without snapshots when <all_urls> is not granted", async () => {
        fake = withTabs(false);
        fake.executeScript.mockResolvedValue([{ result: snapshot }]);

        await handleGroupUpdated(group());

        expect(fake.tabs.find((t) => t.id === 10)?.discarded).toBe(true);
        expect(fake.executeScript).not.toHaveBeenCalled();
        expect(await storage.getSnapshot(10)).toBeUndefined();
    });
});

describe("handleGroupUpdated — capture failures", () => {
    beforeEach(() => {
        fake = withTabs();
    });

    it("discards anyway when the page is unresponsive", async () => {
        fake.executeScript.mockRejectedValue(new Error("Frame not responding"));

        await handleGroupUpdated(group());

        expect(fake.tabs.find((t) => t.id === 10)?.discarded).toBe(true);
        expect(await storage.getSnapshot(10)).toBeUndefined();
    });

    it("stores nothing for an empty snapshot", async () => {
        fake.executeScript.mockResolvedValue([{ result: { media: [], fields: [] } }]);

        await handleGroupUpdated(group());

        expect(fake.tabs.find((t) => t.id === 10)?.discarded).toBe(true);
        expect(await storage.getSnapshot(10)).toBeUndefined();
    });

    it("never injects into an unscriptable scheme", async () => {
        fake.tabs[0].url = "chrome://settings/";
        fake.executeScript.mockResolvedValue([{ result: snapshot }]);

        await handleGroupUpdated(group());

        const targets = fake.executeScript.mock.calls.map((call) => call[0].target.tabId);
        expect(targets).not.toContain(10);
        expect(fake.tabs.find((t) => t.id === 10)?.discarded).toBe(true);
    });

    it("drops the snapshot when Chrome refuses to discard the tab", async () => {
        fake = installFakeChrome({
            tabs: [{ id: 10, url: "https://a.example/", groupId: 1, active: true }],
            groups: [{ id: 1, title: "Work", color: "blue", collapsed: true }],
            undiscardable: [10],
        });
        fake.executeScript.mockResolvedValue([{ result: snapshot }]);

        await handleGroupUpdated(group());

        expect(await storage.getSnapshot(10)).toBeUndefined();
    });
});

describe("handleTabUpdated", () => {
    beforeEach(async () => {
        fake = withTabs();
        fake.executeScript.mockResolvedValue([{ result: undefined }]);
        await storage.putSnapshot({ tabId: 10, url: "https://a.example/", snapshot, capturedAt: Date.now() });
    });

    it("replays the snapshot once the tab has reloaded, then consumes it", async () => {
        await handleTabUpdated(10, complete, tabOf({ id: 10, url: "https://a.example/" }));

        expect(fake.executeScript).toHaveBeenCalledTimes(1);
        expect(fake.executeScript.mock.calls[0][0].args).toEqual([snapshot]);
        expect(await storage.getSnapshot(10)).toBeUndefined();
    });

    it("waits for status complete", async () => {
        await handleTabUpdated(10, { status: "loading" }, tabOf({ id: 10, url: "https://a.example/" }));
        expect(fake.executeScript).not.toHaveBeenCalled();
        expect(await storage.getSnapshot(10)).toBeDefined();
    });

    it("drops the snapshot without injecting when the URL no longer matches", async () => {
        await handleTabUpdated(10, complete, tabOf({ id: 10, url: "https://unrelated.example/" }));

        expect(fake.executeScript).not.toHaveBeenCalled();
        expect(await storage.getSnapshot(10)).toBeUndefined();
    });

    it("does nothing for a tab with no snapshot", async () => {
        await handleTabUpdated(11, complete, tabOf({ id: 11, url: "https://b.example/" }));
        expect(fake.executeScript).not.toHaveBeenCalled();
    });

    it("consumes the snapshot even when injection throws", async () => {
        fake.executeScript.mockRejectedValue(new Error("No frame"));
        await handleTabUpdated(10, complete, tabOf({ id: 10, url: "https://a.example/" }));
        expect(await storage.getSnapshot(10)).toBeUndefined();
    });
});

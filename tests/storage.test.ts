import { beforeEach, describe, expect, it } from "vitest";
import * as storage from "../src/storage";
import type { GroupColor, Snapshot } from "../src/types";
import { installFakeChrome, type FakeChrome } from "./fake-chrome";

const emptySnapshot: Snapshot = { media: [], fields: [] };

let fake: FakeChrome;

beforeEach(() => {
    fake = installFakeChrome();
});

describe("group records", () => {
    it("defaults to an empty map", async () => {
        expect(await storage.getGroupRecords()).toEqual({});
    });

    it("round-trips", async () => {
        const records = {
            [storage.groupKey("Work", "blue")]: {
                groupId: 1,
                title: "Work",
                color: "blue" as GroupColor,
                excluded: true,
            },
        };
        await storage.setGroupRecords(records);
        expect(await storage.getGroupRecords()).toEqual(records);
    });
});

describe("snapshots", () => {
    it("keys by tab id", async () => {
        await storage.putSnapshot({ tabId: 3, url: "https://e.com/", snapshot: emptySnapshot, capturedAt: 10 });
        expect(await storage.getSnapshot(3)).toMatchObject({ tabId: 3, url: "https://e.com/" });
        expect(await storage.getSnapshot(4)).toBeUndefined();
    });

    it("deletes", async () => {
        await storage.putSnapshot({ tabId: 3, url: "https://e.com/", snapshot: emptySnapshot, capturedAt: 10 });
        await storage.deleteSnapshot(3);
        expect(await storage.getSnapshot(3)).toBeUndefined();
    });
});

describe("sweepSnapshots", () => {
    it("drops snapshots past the TTL and keeps fresh ones", async () => {
        const now = 1_000_000;
        await storage.putSnapshot({
            tabId: 1,
            url: "https://old.example/",
            snapshot: emptySnapshot,
            capturedAt: now - storage.SNAPSHOT_TTL_MS - 1,
        });
        await storage.putSnapshot({
            tabId: 2,
            url: "https://new.example/",
            snapshot: emptySnapshot,
            capturedAt: now - 5,
        });

        expect(await storage.sweepSnapshots(now)).toBe(1);
        expect(await storage.getSnapshot(1)).toBeUndefined();
        expect(await storage.getSnapshot(2)).toBeDefined();
    });

    it("leaves non-snapshot keys alone", async () => {
        await storage.setGroupRecords({});
        await storage.sweepSnapshots(Date.now());
        expect(Object.keys(fake.store)).toContain("groups");
    });

    it("drops malformed records", async () => {
        fake.store["snapshot:9"] = { tabId: 9 };
        expect(await storage.sweepSnapshots(1000)).toBe(1);
        expect(fake.store["snapshot:9"]).toBeUndefined();
    });
});

describe("clearAll", () => {
    it("removes everything", async () => {
        await storage.setGroupRecords({});
        await storage.putSnapshot({ tabId: 1, url: "https://e.com/", snapshot: emptySnapshot, capturedAt: 1 });
        await storage.clearAll();
        expect(Object.keys(fake.store)).toEqual([]);
    });
});

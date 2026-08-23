import { beforeEach, describe, expect, it } from "vitest";
import {
    AUTO_PAUSE_MENU_ID,
    PAUSE_MENU_ID,
    createMenus,
    handleMenuClick,
    refreshMenus,
} from "../src/background/menus";
import * as storage from "../src/storage";
import { installFakeChrome, type FakeChrome } from "./fake-chrome";

const WORK_KEY = storage.groupKey("Work", "blue");

const clickData = (menuItemId: string, checked?: boolean) =>
    ({ menuItemId, checked, editable: false, pageUrl: "https://e.example/" }) as chrome.contextMenus.OnClickData;

const tab = (over: Partial<chrome.tabs.Tab> = {}) => ({ id: 10, groupId: 1, ...over }) as chrome.tabs.Tab;

let fake: FakeChrome;

beforeEach(() => {
    fake = installFakeChrome({
        tabs: [{ id: 10, url: "https://a.example/", groupId: 1 }],
        groups: [{ id: 1, title: "Work", color: "blue", collapsed: false }],
    });
});

describe("createMenus", () => {
    it("creates both tab-context entries with auto-pause checked", async () => {
        await createMenus();
        expect(fake.createdMenus.map((m) => m.id)).toEqual([PAUSE_MENU_ID, AUTO_PAUSE_MENU_ID]);
        expect(fake.createdMenus.every((m) => m.contexts?.includes("tab"))).toBe(true);
        expect(fake.createdMenus[1]).toMatchObject({ type: "checkbox", checked: true });
    });
});

describe("refreshMenus", () => {
    it("checks auto-pause for a tracked group", async () => {
        await refreshMenus(tab());
        expect(fake.menuUpdates).toContainEqual([AUTO_PAUSE_MENU_ID, { enabled: true, checked: true }]);
    });

    it("unchecks auto-pause for an excluded group", async () => {
        await storage.setGroupRecords({
            [WORK_KEY]: { groupId: 1, title: "Work", color: "blue", excluded: true },
        });
        await refreshMenus(tab());
        expect(fake.menuUpdates).toContainEqual([AUTO_PAUSE_MENU_ID, { enabled: true, checked: false }]);
    });

    it("disables both entries for a tab outside any group", async () => {
        await refreshMenus(tab({ groupId: -1 }));
        expect(fake.menuUpdates).toContainEqual([PAUSE_MENU_ID, { enabled: false }]);
        expect(fake.menuUpdates).toContainEqual([AUTO_PAUSE_MENU_ID, { enabled: false, checked: true }]);
    });

    it("disables both entries for an untitled group", async () => {
        fake.groups[0].title = undefined;
        await refreshMenus(tab());
        expect(fake.menuUpdates).toContainEqual([PAUSE_MENU_ID, { enabled: false }]);
    });

    it("disables both entries when there is no tab", async () => {
        await refreshMenus(undefined);
        expect(fake.menuUpdates).toContainEqual([PAUSE_MENU_ID, { enabled: false }]);
    });
});

describe("handleMenuClick", () => {
    it("pause collapses the group, so the collapse handler does the work", async () => {
        await handleMenuClick(clickData(PAUSE_MENU_ID), tab());
        expect(fake.groups[0].collapsed).toBe(true);
    });

    it("unchecking auto-pause excludes the group", async () => {
        await handleMenuClick(clickData(AUTO_PAUSE_MENU_ID, false), tab());
        const records = await storage.getGroupRecords();
        expect(records[WORK_KEY]).toMatchObject({ groupId: 1, excluded: true });
    });

    it("re-checking auto-pause un-excludes it", async () => {
        await storage.setGroupRecords({
            [WORK_KEY]: { groupId: 1, title: "Work", color: "blue", excluded: true },
        });
        await handleMenuClick(clickData(AUTO_PAUSE_MENU_ID, true), tab());
        const records = await storage.getGroupRecords();
        expect(records[WORK_KEY].excluded).toBe(false);
    });

    it("ignores a click on a tab outside any group", async () => {
        await handleMenuClick(clickData(AUTO_PAUSE_MENU_ID, false), tab({ groupId: -1 }));
        expect(await storage.getGroupRecords()).toEqual({});
    });

    it("ignores a click on an untitled group", async () => {
        fake.groups[0].title = undefined;
        await handleMenuClick(clickData(PAUSE_MENU_ID), tab());
        expect(fake.groups[0].collapsed).toBe(false);
    });
});

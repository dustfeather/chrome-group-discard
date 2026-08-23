import { isExcluded, toLiveGroup, upsertGroupRecord } from "../groups";
import { groupKey } from "../storage";
import * as storage from "../storage";
import { NO_GROUP_ID, type LiveGroup } from "../types";

export const PAUSE_MENU_ID = "pause-group";
export const AUTO_PAUSE_MENU_ID = "auto-pause-group";

export async function createMenus(): Promise<void> {
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
        id: PAUSE_MENU_ID,
        title: "Pause this group",
        contexts: ["tab"],
    });
    chrome.contextMenus.create({
        id: AUTO_PAUSE_MENU_ID,
        title: "Auto-pause this group",
        type: "checkbox",
        checked: true,
        contexts: ["tab"],
    });
}

async function groupOfTab(tab: chrome.tabs.Tab | undefined): Promise<LiveGroup | null> {
    const groupId = tab?.groupId;
    if (groupId === undefined || groupId === NO_GROUP_ID) return null;
    try {
        return toLiveGroup(await chrome.tabGroups.get(groupId));
    } catch {
        return null;
    }
}

/**
 * Chrome has no `contextMenus.onShown` outside Firefox, so the checkbox state
 * is refreshed on `tabs.onActivated` instead — by the time a tab context menu
 * can be opened, that tab is the active one.
 */
export async function refreshMenus(tab: chrome.tabs.Tab | undefined): Promise<void> {
    const live = await groupOfTab(tab);
    if (!live) {
        await chrome.contextMenus.update(PAUSE_MENU_ID, { enabled: false });
        await chrome.contextMenus.update(AUTO_PAUSE_MENU_ID, { enabled: false, checked: true });
        return;
    }
    const records = await storage.getGroupRecords();
    await chrome.contextMenus.update(PAUSE_MENU_ID, { enabled: true });
    await chrome.contextMenus.update(AUTO_PAUSE_MENU_ID, {
        enabled: true,
        checked: !isExcluded(records, live),
    });
}

export async function handleMenuClick(
    info: chrome.contextMenus.OnClickData,
    tab: chrome.tabs.Tab | undefined,
): Promise<void> {
    const live = await groupOfTab(tab);
    if (!live) return;

    if (info.menuItemId === PAUSE_MENU_ID) {
        // Collapsing falls through to tabGroups.onUpdated, so manual pause and
        // auto-pause share one code path and can never visually disagree.
        await chrome.tabGroups.update(live.id, { collapsed: true });
        return;
    }

    if (info.menuItemId === AUTO_PAUSE_MENU_ID) {
        const records = upsertGroupRecord(await storage.getGroupRecords(), live);
        const key = groupKey(live.title, live.color);
        // `info.checked` is the state after the click: unchecked = opted out.
        records[key] = { ...records[key], excluded: info.checked === false };
        await storage.setGroupRecords(records);
    }
}

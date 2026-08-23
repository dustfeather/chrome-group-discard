import { handleGroupUpdated, handleTabUpdated } from "./discard";
import { createMenus, handleMenuClick, refreshMenus } from "./menus";
import { rebindGroupRecords, toLiveGroup, unbindGroupId } from "../groups";
import * as storage from "../storage";
import type { LiveGroup } from "../types";

// MV3 service workers are torn down between events, so every listener has to be
// registered synchronously at the top level — not inside an async bootstrap.

chrome.runtime.onInstalled.addListener(() => {
    void bootstrap();
});

chrome.runtime.onStartup.addListener(() => {
    void bootstrap();
});

chrome.tabGroups.onUpdated.addListener((group) => {
    void (async () => {
        await handleGroupUpdated(group);
        await refreshActiveTabMenus();
    })();
});

chrome.tabGroups.onRemoved.addListener((group) => {
    void (async () => {
        const records = await storage.getGroupRecords();
        await storage.setGroupRecords(unbindGroupId(records, group.id));
    })();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    void handleTabUpdated(tabId, changeInfo, tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
    void storage.deleteSnapshot(tabId);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
    void (async () => {
        try {
            await refreshMenus(await chrome.tabs.get(tabId));
        } catch {
            // Tab closed between activation and lookup.
        }
    })();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    void handleMenuClick(info, tab);
});

/**
 * Re-resolves every stored record against the groups that exist now. Group ids
 * are session-scoped, so all cached ids are stale after a restart.
 */
export async function bootstrap(): Promise<void> {
    await createMenus();

    const live: LiveGroup[] = [];
    for (const group of await chrome.tabGroups.query({})) {
        const resolved = toLiveGroup(group);
        if (resolved) live.push(resolved);
    }

    const records = await storage.getGroupRecords();
    await storage.setGroupRecords(rebindGroupRecords(records, live));
    await storage.sweepSnapshots(Date.now());
}

async function refreshActiveTabMenus(): Promise<void> {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        await refreshMenus(tab);
    } catch {
        // No focused window.
    }
}

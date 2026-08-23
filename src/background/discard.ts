import { captureSnapshot, isEmptySnapshot } from "../snapshot/capture";
import { restoreSnapshot } from "../snapshot/restore";
import { isExcluded, toLiveGroup, upsertGroupRecord } from "../groups";
import * as storage from "../storage";
import type { Snapshot } from "../types";

/** Schemes `chrome.scripting` is never allowed to touch. */
const UNSCRIPTABLE = /^(chrome|chrome-extension|chrome-untrusted|devtools|edge|about|view-source|file|blob|data):/i;

/**
 * Guards against a second collapse event landing while the first discard sweep
 * is still running. Resets when the service worker is torn down, which is
 * harmless — a sweep over already-discarded tabs is a no-op.
 */
const inFlight = new Set<number>();

export async function hasSnapshotPermission(): Promise<boolean> {
    try {
        return await chrome.permissions.contains({ origins: ["<all_urls>"] });
    } catch {
        return false;
    }
}

/**
 * Single entry point for `chrome.tabGroups.onUpdated`. The event fires for
 * collapse, rename and recolour alike, so this reconciles the record first and
 * only then acts on the collapse — which is why a rename can never lose an
 * exclusion while the browser is running.
 */
export async function handleGroupUpdated(group: chrome.tabGroups.TabGroup): Promise<void> {
    const live = toLiveGroup(group);
    if (!live) return; // untitled: out of scope

    const records = upsertGroupRecord(await storage.getGroupRecords(), live);
    await storage.setGroupRecords(records);

    if (!group.collapsed) return;
    if (isExcluded(records, live)) return;
    await discardGroup(live.id);
}

/** Discards every tab in the group, snapshotting each one first when permitted. */
export async function discardGroup(groupId: number): Promise<void> {
    if (inFlight.has(groupId)) return;
    inFlight.add(groupId);
    try {
        const tabs = await chrome.tabs.query({ groupId });
        const canSnapshot = await hasSnapshotPermission();
        await Promise.all(tabs.map((tab) => discardTab(tab, canSnapshot)));
    } finally {
        inFlight.delete(groupId);
    }
}

async function discardTab(tab: chrome.tabs.Tab, canSnapshot: boolean): Promise<void> {
    const sourceId = tab.id;
    if (sourceId === undefined || tab.discarded) return;

    const snapshot = canSnapshot ? await captureFor(sourceId, tab.url) : null;

    let discarded: chrome.tabs.Tab | undefined;
    try {
        discarded = await chrome.tabs.discard(sourceId);
    } catch {
        return; // active tab, or the tab went away mid-sweep
    }

    // Ids survive discard, but read the one Chrome hands back rather than
    // trusting the cached value.
    const tabId = discarded?.id;
    if (tabId === undefined || !snapshot || !tab.url) return;
    await storage.putSnapshot({ tabId, url: tab.url, snapshot, capturedAt: Date.now() });
}

async function captureFor(tabId: number, url: string | undefined): Promise<Snapshot | null> {
    if (!url || UNSCRIPTABLE.test(url)) return null;
    try {
        const [injection] = await chrome.scripting.executeScript({
            target: { tabId },
            func: captureSnapshot,
        });
        const snapshot = injection?.result as Snapshot | undefined;
        if (!snapshot || isEmptySnapshot(snapshot)) return null;
        return snapshot;
    } catch {
        // Unresponsive page, a policy-blocked host (the Web Store), a PDF —
        // discard anyway, just without a snapshot.
        return null;
    }
}

/**
 * Replays a snapshot once the discarded tab has reloaded. The snapshot is
 * consumed unconditionally: a stale one must never survive to land in an
 * unrelated tab that inherited its id after a restart.
 */
export async function handleTabUpdated(
    tabId: number,
    changeInfo: chrome.tabs.OnUpdatedInfo,
    tab: chrome.tabs.Tab,
): Promise<void> {
    if (changeInfo.status !== "complete") return;

    const record = await storage.getSnapshot(tabId);
    if (!record) return;
    await storage.deleteSnapshot(tabId);

    if (tab.url !== record.url) return; // id reuse across a restart
    if (!(await hasSnapshotPermission())) return;

    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            func: restoreSnapshot,
            args: [record.snapshot],
        });
    } catch {
        // Page navigated away again before we got there.
    }
}

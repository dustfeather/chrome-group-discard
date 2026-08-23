import type { GroupRecords, SnapshotRecord } from "./types";

const GROUPS_KEY = "groups";
const SNAPSHOT_PREFIX = "snapshot:";

/** Backstop only — snapshots are normally cleared on restore, mismatch or tab close. */
export const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * NUL separator: it cannot appear in a group title, so no title can forge a key
 * that collides with another title/colour pair.
 */
const KEY_SEP = "\u0000";

/** Durable key for a group. Ids are session-scoped, so `title + color` is the identity. */
export function groupKey(title: string, color: string): string {
    return `${title}${KEY_SEP}${color}`;
}

export async function getGroupRecords(): Promise<GroupRecords> {
    const got = await chrome.storage.local.get(GROUPS_KEY);
    return (got[GROUPS_KEY] as GroupRecords | undefined) ?? {};
}

export async function setGroupRecords(records: GroupRecords): Promise<void> {
    await chrome.storage.local.set({ [GROUPS_KEY]: records });
}

function snapshotKey(tabId: number): string {
    return SNAPSHOT_PREFIX + tabId;
}

export async function putSnapshot(record: SnapshotRecord): Promise<void> {
    await chrome.storage.local.set({ [snapshotKey(record.tabId)]: record });
}

export async function getSnapshot(tabId: number): Promise<SnapshotRecord | undefined> {
    const key = snapshotKey(tabId);
    const got = await chrome.storage.local.get(key);
    return got[key] as SnapshotRecord | undefined;
}

export async function deleteSnapshot(tabId: number): Promise<void> {
    await chrome.storage.local.remove(snapshotKey(tabId));
}

/** Drops snapshots older than `ttlMs`. Returns how many were removed. */
export async function sweepSnapshots(now: number, ttlMs: number = SNAPSHOT_TTL_MS): Promise<number> {
    const all = await chrome.storage.local.get(null);
    const stale: string[] = [];
    for (const [key, value] of Object.entries(all)) {
        if (!key.startsWith(SNAPSHOT_PREFIX)) continue;
        const capturedAt = (value as Partial<SnapshotRecord> | undefined)?.capturedAt;
        if (typeof capturedAt !== "number" || now - capturedAt > ttlMs) stale.push(key);
    }
    if (stale.length) await chrome.storage.local.remove(stale);
    return stale.length;
}

export async function clearAll(): Promise<void> {
    await chrome.storage.local.clear();
}

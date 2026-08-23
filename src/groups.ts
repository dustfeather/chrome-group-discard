import { groupKey } from "./storage";
import { NO_GROUP_ID, type GroupRecords, type LiveGroup } from "./types";

/**
 * Narrows a raw tab group to one we track. Untitled groups are out of scope:
 * they have no durable identity across a browser restart, so they are never
 * recorded and never auto-discarded.
 */
export function toLiveGroup(group: chrome.tabGroups.TabGroup): LiveGroup | null {
    if (!group.title) return null;
    return { id: group.id, title: group.title, color: group.color };
}

export function isExcluded(records: GroupRecords, group: LiveGroup): boolean {
    return records[groupKey(group.title, group.color)]?.excluded ?? false;
}

/**
 * Records the live state of `group`, carrying `excluded` across a rename or
 * recolour: `tabGroups.onUpdated` fires for those too, and the pre-rename
 * record is the one still pointing at this live `groupId`.
 *
 * Duplicate `title + color` collapses onto one record, so an exclusion applies
 * to every matching group. Exclusions therefore OR together — over-excluding is
 * the safe direction when auto-pause is globally on.
 *
 * Pure: returns a new object, does not touch storage.
 */
export function upsertGroupRecord(records: GroupRecords, group: LiveGroup): GroupRecords {
    const next: GroupRecords = { ...records };
    const key = groupKey(group.title, group.color);

    const renamed = Object.entries(next).find(([k, r]) => k !== key && r.groupId === group.id);
    if (renamed) delete next[renamed[0]];

    const excluded = (renamed?.[1].excluded ?? false) || (next[key]?.excluded ?? false);
    next[key] = { groupId: group.id, title: group.title, color: group.color, excluded };
    return next;
}

/** Forgets the live id of a group that went away, keeping its exclusion. */
export function unbindGroupId(records: GroupRecords, groupId: number): GroupRecords {
    const next: GroupRecords = { ...records };
    for (const [key, record] of Object.entries(next)) {
        if (record.groupId === groupId) next[key] = { ...record, groupId: NO_GROUP_ID };
    }
    return next;
}

/**
 * Re-resolves stored records against the groups that actually exist now,
 * matching on `title + color` and re-binding fresh ids. Run on startup, when
 * every id from the previous session is stale.
 *
 * Pure: returns a new object, does not touch storage.
 */
export function rebindGroupRecords(records: GroupRecords, liveGroups: LiveGroup[]): GroupRecords {
    const byKey = new Map<string, LiveGroup>();
    for (const group of liveGroups) byKey.set(groupKey(group.title, group.color), group);

    const next: GroupRecords = {};
    for (const [key, record] of Object.entries(records)) {
        const live = byKey.get(key);
        next[key] = { ...record, groupId: live ? live.id : NO_GROUP_ID };
    }
    for (const [key, group] of byKey) {
        if (next[key]) continue;
        next[key] = { groupId: group.id, title: group.title, color: group.color, excluded: false };
    }
    return next;
}

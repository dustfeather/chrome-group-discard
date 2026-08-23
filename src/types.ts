export type GroupColor = `${chrome.tabGroups.Color}`;

/** `chrome.tabGroups.TAB_GROUP_ID_NONE`, inlined so pure modules stay testable. */
export const NO_GROUP_ID = -1;

/**
 * A tab group we are willing to track: titled, with its colour resolved.
 * Untitled groups are out of scope and never produce one of these.
 */
export interface LiveGroup {
    id: number;
    title: string;
    color: GroupColor;
}

/**
 * Persisted per-group state. Keyed on `title + color` (see `groupKey`) because
 * tabGroups ids are unique within a browser session only — a group restored
 * after a restart comes back with a different id.
 */
export interface GroupRecord {
    /** Runtime cache of the live id, never the durable key. `NO_GROUP_ID` when unbound. */
    groupId: number;
    title: string;
    color: GroupColor;
    /** true = user opted this group out of auto-pause. */
    excluded: boolean;
}

export type GroupRecords = Record<string, GroupRecord>;

export interface MediaState {
    selector: string;
    currentTime: number;
    paused: boolean;
}

export type FieldState =
    | { selector: string; kind: "value"; value: string }
    | { selector: string; kind: "checked"; value: boolean }
    | { selector: string; kind: "multi"; value: string[] };

export interface Snapshot {
    media: MediaState[];
    fields: FieldState[];
}

export interface SnapshotRecord {
    /** The id read off the `Tab` that `discard()` resolved with. */
    tabId: number;
    /** Guards against Chrome reusing tab ids across a restart. */
    url: string;
    snapshot: Snapshot;
    capturedAt: number;
}

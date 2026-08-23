import { vi } from "vitest";
import type { GroupColor } from "../src/types";

type MenuUpdate = Omit<chrome.contextMenus.CreateProperties, "id">;

export interface FakeTab {
    id: number;
    url?: string;
    groupId: number;
    discarded?: boolean;
    active?: boolean;
}

export interface FakeGroup {
    id: number;
    title?: string;
    color: GroupColor;
    collapsed: boolean;
}

export interface FakeChromeInit {
    tabs?: FakeTab[];
    groups?: FakeGroup[];
    /** Tab ids that `discard()` refuses, mimicking Chrome's active-tab refusal. */
    undiscardable?: number[];
    /** Whether `<all_urls>` is granted. */
    hostPermission?: boolean;
}

export interface FakeChrome {
    store: Record<string, unknown>;
    tabs: FakeTab[];
    groups: FakeGroup[];
    executeScript: ReturnType<typeof vi.fn>;
    menuUpdates: Array<[string, MenuUpdate]>;
    createdMenus: chrome.contextMenus.CreateProperties[];
}

/**
 * Installs a `globalThis.chrome` covering only what this extension touches.
 * Returns handles so a test can inspect storage and the recorded calls.
 */
export function installFakeChrome(init: FakeChromeInit = {}): FakeChrome {
    const store: Record<string, unknown> = {};
    const tabs = init.tabs ?? [];
    const groups = init.groups ?? [];
    const undiscardable = new Set(init.undiscardable ?? []);
    const menuUpdates: Array<[string, MenuUpdate]> = [];
    const createdMenus: chrome.contextMenus.CreateProperties[] = [];

    const executeScript = vi.fn(async () => [{ result: undefined }]);

    const chromeMock = {
        storage: {
            local: {
                async get(keys: string | string[] | null) {
                    if (keys === null) return { ...store };
                    const list = Array.isArray(keys) ? keys : [keys];
                    const out: Record<string, unknown> = {};
                    for (const key of list) if (key in store) out[key] = store[key];
                    return out;
                },
                async set(items: Record<string, unknown>) {
                    Object.assign(store, structuredClone(items));
                },
                async remove(keys: string | string[]) {
                    for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
                },
                async clear() {
                    for (const key of Object.keys(store)) delete store[key];
                },
            },
        },
        tabs: {
            async query(info: { groupId?: number; active?: boolean }) {
                return tabs.filter((tab) => {
                    if (info.groupId !== undefined && tab.groupId !== info.groupId) return false;
                    if (info.active !== undefined && !!tab.active !== info.active) return false;
                    return true;
                });
            },
            async get(tabId: number) {
                const tab = tabs.find((t) => t.id === tabId);
                if (!tab) throw new Error(`no tab ${tabId}`);
                return tab;
            },
            async discard(tabId: number) {
                if (undiscardable.has(tabId)) throw new Error("Tab cannot be discarded");
                const tab = tabs.find((t) => t.id === tabId);
                if (!tab) throw new Error(`no tab ${tabId}`);
                tab.discarded = true;
                // Chrome keeps the id across a discard.
                return { ...tab };
            },
        },
        tabGroups: {
            TAB_GROUP_ID_NONE: -1,
            async get(groupId: number) {
                const group = groups.find((g) => g.id === groupId);
                if (!group) throw new Error(`no group ${groupId}`);
                return group;
            },
            async query() {
                return [...groups];
            },
            async update(groupId: number, props: { collapsed?: boolean }) {
                const group = groups.find((g) => g.id === groupId);
                if (!group) throw new Error(`no group ${groupId}`);
                if (props.collapsed !== undefined) group.collapsed = props.collapsed;
                return group;
            },
        },
        permissions: {
            async contains() {
                return init.hostPermission ?? true;
            },
        },
        scripting: { executeScript },
        contextMenus: {
            async removeAll() {
                createdMenus.length = 0;
            },
            create(props: chrome.contextMenus.CreateProperties) {
                createdMenus.push(props);
                return props.id ?? "";
            },
            async update(id: string, props: MenuUpdate) {
                menuUpdates.push([id, props]);
            },
        },
    };

    vi.stubGlobal("chrome", chromeMock);
    return { store, tabs, groups, executeScript, menuUpdates, createdMenus };
}

import "./options.scss";
import { rebindGroupRecords, toLiveGroup } from "../groups";
import * as storage from "../storage";
import { NO_GROUP_ID, type GroupRecord, type GroupRecords, type LiveGroup } from "../types";

const ALL_URLS: chrome.permissions.Permissions = { origins: ["<all_urls>"] };

/** Approximate Chrome's group palette so the list is scannable. */
const SWATCH: Record<string, string> = {
    grey: "#5f6368",
    blue: "#1a73e8",
    red: "#d93025",
    yellow: "#f9ab00",
    green: "#1e8e3e",
    pink: "#d01884",
    purple: "#9334e6",
    cyan: "#007b83",
    orange: "#fa903e",
};

function el<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) throw new Error(`missing element #${id}`);
    return node as T;
}

async function renderPermission(): Promise<void> {
    const granted = await chrome.permissions.contains(ALL_URLS);
    el("permission-state").textContent = granted
        ? "Granted — snapshots are being captured."
        : "Not granted — tabs are discarded without snapshots.";
    el<HTMLButtonElement>("grant").disabled = granted;
    el<HTMLButtonElement>("revoke").disabled = !granted;
}

function groupRow(record: GroupRecord, onToggle: (next: boolean) => void): HTMLLIElement {
    const row = document.createElement("li");

    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = SWATCH[record.color] ?? "#5f6368";
    row.append(swatch);

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = record.title;
    row.append(title);

    if (record.groupId === NO_GROUP_ID) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = "not open";
        row.append(badge);
    }

    const label = document.createElement("label");
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = !record.excluded;
    toggle.addEventListener("change", () => onToggle(toggle.checked));
    label.append(toggle, document.createTextNode(" auto-pause"));
    row.append(label);

    return row;
}

async function renderGroups(): Promise<void> {
    // Re-resolve first so the list shows which records map onto a live group.
    const live: LiveGroup[] = [];
    for (const group of await chrome.tabGroups.query({})) {
        const resolved = toLiveGroup(group);
        if (resolved) live.push(resolved);
    }
    const records: GroupRecords = rebindGroupRecords(await storage.getGroupRecords(), live);
    await storage.setGroupRecords(records);

    const list = el<HTMLUListElement>("groups");
    list.replaceChildren();

    const entries = Object.entries(records).sort(([, a], [, b]) => a.title.localeCompare(b.title));
    el("groups-empty").hidden = entries.length > 0;

    for (const [key, record] of entries) {
        list.append(
            groupRow(record, (autoPause) => {
                void (async () => {
                    const current = await storage.getGroupRecords();
                    if (!current[key]) return;
                    current[key] = { ...current[key], excluded: !autoPause };
                    await storage.setGroupRecords(current);
                })();
            }),
        );
    }
}

function wire(): void {
    // permissions.request() throws "This function must be called during a user
    // gesture" from a service worker, which is why this button lives here.
    el("grant").addEventListener("click", () => {
        void (async () => {
            await chrome.permissions.request(ALL_URLS);
            await renderPermission();
        })();
    });

    el("revoke").addEventListener("click", () => {
        void (async () => {
            await chrome.permissions.remove(ALL_URLS);
            await renderPermission();
        })();
    });

    el("clear").addEventListener("click", () => {
        void (async () => {
            await storage.clearAll();
            el("clear-state").textContent = "Cleared.";
            await renderGroups();
        })();
    });
}

wire();
void renderPermission();
void renderGroups();

import type { Snapshot } from "../types";

/**
 * Runs inside the page via
 * `chrome.scripting.executeScript({ func, args: [snapshot] })`.
 *
 * Self-contained for the same reason as `captureSnapshot` — it is serialised to
 * source. `snapshot` arrives as a structured clone of plain JSON.
 */
export function restoreSnapshot(snapshot: Snapshot): void {
    function notify(element: Element): void {
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
    }

    for (let i = 0; i < snapshot.fields.length; i++) {
        const field = snapshot.fields[i];
        let element: Element | null = null;
        try {
            element = document.querySelector(field.selector);
        } catch {
            continue;
        }
        if (!element) continue;

        if (field.kind === "checked") {
            (element as HTMLInputElement).checked = field.value;
        } else if (field.kind === "multi") {
            const select = element as HTMLSelectElement;
            for (let j = 0; j < select.options.length; j++) {
                select.options[j].selected = field.value.indexOf(select.options[j].value) !== -1;
            }
        } else {
            (element as HTMLInputElement | HTMLTextAreaElement).value = field.value;
        }
        notify(element);
    }

    for (let i = 0; i < snapshot.media.length; i++) {
        const state = snapshot.media[i];
        let element: HTMLMediaElement | null = null;
        try {
            element = document.querySelector(state.selector) as HTMLMediaElement | null;
        } catch {
            continue;
        }
        if (!element) continue;

        const apply = (media: HTMLMediaElement): void => {
            try {
                media.currentTime = state.currentTime;
            } catch {
                return;
            }
            // Resuming can be refused by the autoplay policy; that is fine, the
            // position is what matters.
            if (!state.paused) void media.play().catch(() => {});
        };

        // Seeking before metadata is available is ignored by the element.
        if (element.readyState >= 1) {
            apply(element);
        } else {
            const target = element;
            target.addEventListener("loadedmetadata", () => apply(target), { once: true });
        }
    }
}

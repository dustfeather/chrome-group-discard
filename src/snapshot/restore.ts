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

        const media = element;
        const readyEvents = ["loadedmetadata", "loadeddata", "canplay"];
        let applied = false;

        const detach = (): void => {
            for (let e = 0; e < readyEvents.length; e++) media.removeEventListener(readyEvents[e], apply);
        };

        function apply(): void {
            if (applied) return;
            try {
                media.currentTime = state.currentTime;
            } catch {
                return; // not seekable yet — a ready event will bring us back
            }
            // A seek issued before the resource is actually seekable is accepted
            // and then silently clamped back to 0, so confirm it stuck before
            // treating the restore as done.
            if (Math.abs(media.currentTime - state.currentTime) > 0.5) return;
            applied = true;
            detach();
            // Resuming can be refused by the autoplay policy; that is fine, the
            // position is what matters.
            if (!state.paused) void media.play().catch(() => {});
        }

        // Seeking before metadata is available is ignored by the element.
        if (media.readyState >= 1) apply();
        if (!applied) {
            for (let e = 0; e < readyEvents.length; e++) media.addEventListener(readyEvents[e], apply);
        }
    }
}

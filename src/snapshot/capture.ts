import type { FieldState, MediaState, Snapshot } from "../types";

/**
 * Runs inside the page via `chrome.scripting.executeScript({ func })`.
 *
 * That serialises the function to source, so it must be entirely
 * self-contained: no imports, no closure variables, no module-level helpers.
 * Everything it needs is declared inside the body. The `import type` above is
 * erased at compile time and is safe.
 *
 * This is the only capture window that exists — `beforeunload`, `pagehide` and
 * `unload` do not fire on discard.
 */
export function captureSnapshot(): Snapshot {
    /** Unique, restart-stable CSS path: tag + nth-of-type at every level. */
    function cssPath(element: Element): string {
        const parts: string[] = [];
        let node: Element | null = element;
        while (node && node !== document.documentElement) {
            const parent: Element | null = node.parentElement;
            if (!parent) break;
            let index = 1;
            for (let i = 0; i < parent.children.length; i++) {
                const child = parent.children[i];
                if (child === node) break;
                if (child.tagName === node.tagName) index++;
            }
            parts.unshift(node.tagName.toLowerCase() + ":nth-of-type(" + index + ")");
            node = parent;
        }
        return parts.length ? "html > " + parts.join(" > ") : "html";
    }

    /**
     * Types we never read. `password` and `hidden` are the security-relevant
     * ones; the rest carry no user-entered state worth restoring.
     */
    function isSkippedType(type: string): boolean {
        return (
            type === "password" ||
            type === "hidden" ||
            type === "file" ||
            type === "submit" ||
            type === "reset" ||
            type === "button" ||
            type === "image"
        );
    }

    /**
     * Honours the page's own opt-out: `autocomplete="off"` on the field or its
     * form, any `cc-*` token (payment fields), and `one-time-code`.
     */
    function isOptedOut(element: Element): boolean {
        const own = (element.getAttribute("autocomplete") || "").toLowerCase();
        const form = (element as HTMLInputElement).form;
        const formLevel = form ? (form.getAttribute("autocomplete") || "").toLowerCase() : "";
        const tokens = (own + " " + formLevel).split(/\s+/);
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            if (token === "off" || token === "one-time-code") return true;
            if (token.indexOf("cc-") === 0) return true;
        }
        return false;
    }

    const media: MediaState[] = [];
    const mediaElements = document.querySelectorAll("video, audio");
    for (let i = 0; i < mediaElements.length; i++) {
        const element = mediaElements[i] as HTMLMediaElement;
        const currentTime = element.currentTime;
        if (!isFinite(currentTime) || currentTime <= 0) continue;
        media.push({ selector: cssPath(element), currentTime, paused: element.paused });
    }

    const fields: FieldState[] = [];
    const fieldElements = document.querySelectorAll("input, textarea, select");
    for (let i = 0; i < fieldElements.length; i++) {
        const element = fieldElements[i] as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        if (element.disabled) continue;
        if (isOptedOut(element)) continue;

        const tag = element.tagName.toLowerCase();

        if (tag === "select") {
            const select = element as HTMLSelectElement;
            if (select.multiple) {
                const values: string[] = [];
                for (let j = 0; j < select.options.length; j++) {
                    if (select.options[j].selected) values.push(select.options[j].value);
                }
                fields.push({ selector: cssPath(select), kind: "multi", value: values });
            } else {
                fields.push({ selector: cssPath(select), kind: "value", value: select.value });
            }
            continue;
        }

        if (tag === "input") {
            const input = element as HTMLInputElement;
            const type = (input.type || "text").toLowerCase();
            if (isSkippedType(type)) continue;
            if (type === "checkbox" || type === "radio") {
                fields.push({ selector: cssPath(input), kind: "checked", value: input.checked });
                continue;
            }
            if (input.value === "") continue;
            fields.push({ selector: cssPath(input), kind: "value", value: input.value });
            continue;
        }

        const textarea = element as HTMLTextAreaElement;
        if (textarea.value === "") continue;
        fields.push({ selector: cssPath(textarea), kind: "value", value: textarea.value });
    }

    return { media, fields };
}

/** True when there is nothing worth persisting. */
export function isEmptySnapshot(snapshot: Snapshot): boolean {
    return snapshot.media.length === 0 && snapshot.fields.length === 0;
}

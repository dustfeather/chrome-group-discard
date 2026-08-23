import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureSnapshot, isEmptySnapshot } from "../src/snapshot/capture";
import { restoreSnapshot } from "../src/snapshot/restore";
import type { FieldState } from "../src/types";

function html(markup: string): void {
    document.body.innerHTML = markup;
}

function field(selectorSuffix: string, fields: FieldState[]): FieldState | undefined {
    return fields.find((f) => f.selector.endsWith(selectorSuffix));
}

beforeEach(() => {
    document.body.innerHTML = "";
});

describe("captureSnapshot — field filtering", () => {
    it("captures plain text, textarea and select values", () => {
        html(`
            <input id="a" type="text" value="hello">
            <textarea id="b">notes</textarea>
            <select id="c"><option value="x">x</option><option value="y" selected>y</option></select>
        `);
        const { fields } = captureSnapshot();
        expect(fields).toHaveLength(3);
        expect(fields.map((f) => f.value)).toEqual(expect.arrayContaining(["hello", "notes", "y"]));
    });

    it("never captures passwords or hidden fields", () => {
        html(`
            <input type="password" value="hunter2">
            <input type="hidden" value="csrf-token">
            <input type="text" value="visible">
        `);
        const { fields } = captureSnapshot();
        expect(fields).toHaveLength(1);
        expect(fields[0].value).toBe("visible");
    });

    it("never captures cc-* or one-time-code fields", () => {
        html(`
            <input type="text" autocomplete="cc-number" value="4111111111111111">
            <input type="text" autocomplete="shipping cc-exp" value="12/30">
            <input type="text" autocomplete="one-time-code" value="123456">
            <input type="text" autocomplete="email" value="a@b.c">
        `);
        const { fields } = captureSnapshot();
        expect(fields).toHaveLength(1);
        expect(fields[0].value).toBe("a@b.c");
    });

    it("honours autocomplete=off on the form and on the field", () => {
        html(`
            <form autocomplete="off"><input type="text" value="in-off-form"></form>
            <form><input type="text" autocomplete="off" value="own-off"></form>
            <form><input type="text" value="kept"></form>
        `);
        const { fields } = captureSnapshot();
        expect(fields).toHaveLength(1);
        expect(fields[0].value).toBe("kept");
    });

    it("skips disabled fields, file inputs and buttons", () => {
        html(`
            <input type="text" value="nope" disabled>
            <input type="file">
            <input type="submit" value="Send">
            <input type="button" value="Click">
            <input type="text" value="yes">
        `);
        const { fields } = captureSnapshot();
        expect(fields).toHaveLength(1);
        expect(fields[0].value).toBe("yes");
    });

    it("records checkbox and radio state, including unchecked", () => {
        html(`
            <input type="checkbox" id="one" checked>
            <input type="checkbox" id="two">
            <input type="radio" name="r" value="a" checked>
        `);
        const { fields } = captureSnapshot();
        expect(fields).toHaveLength(3);
        expect(fields.every((f) => f.kind === "checked")).toBe(true);
        expect(fields.map((f) => f.value)).toEqual([true, false, true]);
    });

    it("skips empty text fields but keeps empty selects", () => {
        html(`
            <input type="text" value="">
            <textarea></textarea>
            <select><option value="" selected></option></select>
        `);
        const { fields } = captureSnapshot();
        expect(fields).toHaveLength(1);
        expect(fields[0].kind).toBe("value");
    });

    it("captures every selected option of a multi-select", () => {
        html(`
            <select multiple>
                <option value="a" selected>a</option>
                <option value="b">b</option>
                <option value="c" selected>c</option>
            </select>
        `);
        const { fields } = captureSnapshot();
        expect(fields[0]).toMatchObject({ kind: "multi", value: ["a", "c"] });
    });
});

describe("captureSnapshot — selectors", () => {
    it("produces a selector that resolves back to the same element", () => {
        html(`
            <div><p>x</p><div><input type="text" value="deep"></div></div>
            <div><input type="text" value="sibling"></div>
        `);
        const { fields } = captureSnapshot();
        for (const f of fields) {
            const found = document.querySelector(f.selector) as HTMLInputElement | null;
            expect(found).not.toBeNull();
            expect(found?.value).toBe(f.value);
        }
    });

    it("distinguishes siblings of the same tag", () => {
        html(`<input type="text" value="one"><input type="text" value="two">`);
        const { fields } = captureSnapshot();
        expect(fields[0].selector).not.toBe(fields[1].selector);
    });
});

describe("captureSnapshot — media", () => {
    it("captures position and paused state, skipping untouched media", () => {
        html(`<video id="played"></video><video id="fresh"></video>`);
        const played = document.getElementById("played") as HTMLVideoElement;
        Object.defineProperty(played, "currentTime", { value: 91.5, configurable: true });
        Object.defineProperty(played, "paused", { value: false, configurable: true });

        const { media } = captureSnapshot();
        expect(media).toHaveLength(1);
        expect(media[0]).toMatchObject({ currentTime: 91.5, paused: false });
    });
});

describe("isEmptySnapshot", () => {
    it("is true only when nothing was captured", () => {
        expect(isEmptySnapshot({ media: [], fields: [] })).toBe(true);
        expect(isEmptySnapshot({ media: [], fields: [{ selector: "x", kind: "value", value: "a" }] })).toBe(false);
    });
});

describe("restoreSnapshot", () => {
    it("round-trips a captured form", () => {
        html(`
            <form>
                <input type="text" value="typed">
                <input type="checkbox" checked>
                <textarea>draft</textarea>
                <select><option value="x">x</option><option value="y" selected>y</option></select>
            </form>
        `);
        const snapshot = captureSnapshot();

        // Wipe every field, then replay.
        (document.querySelector("input[type=text]") as HTMLInputElement).value = "";
        (document.querySelector("input[type=checkbox]") as HTMLInputElement).checked = false;
        (document.querySelector("textarea") as HTMLTextAreaElement).value = "";
        (document.querySelector("select") as HTMLSelectElement).value = "x";

        restoreSnapshot(snapshot);

        expect((document.querySelector("input[type=text]") as HTMLInputElement).value).toBe("typed");
        expect((document.querySelector("input[type=checkbox]") as HTMLInputElement).checked).toBe(true);
        expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("draft");
        expect((document.querySelector("select") as HTMLSelectElement).value).toBe("y");
    });

    it("fires input and change so frameworks notice", () => {
        html(`<input type="text" value="">`);
        const input = document.querySelector("input") as HTMLInputElement;
        const seen: string[] = [];
        input.addEventListener("input", () => seen.push("input"));
        input.addEventListener("change", () => seen.push("change"));

        restoreSnapshot({
            media: [],
            fields: [{ selector: "html > body:nth-of-type(1) > input:nth-of-type(1)", kind: "value", value: "back" }],
        });

        expect(input.value).toBe("back");
        expect(seen).toEqual(["input", "change"]);
    });

    it("ignores selectors that no longer match", () => {
        html(`<div></div>`);
        expect(() =>
            restoreSnapshot({ media: [], fields: [{ selector: "input#gone", kind: "value", value: "x" }] }),
        ).not.toThrow();
    });

    it("survives a malformed selector", () => {
        html(`<div></div>`);
        expect(() =>
            restoreSnapshot({ media: [], fields: [{ selector: ")))", kind: "value", value: "x" }] }),
        ).not.toThrow();
    });

    it("seeks immediately when metadata is already loaded", () => {
        html(`<video></video>`);
        const video = document.querySelector("video") as HTMLVideoElement;
        Object.defineProperty(video, "readyState", { value: 1, configurable: true });
        video.play = vi.fn(() => Promise.resolve());

        restoreSnapshot({
            media: [
                {
                    selector: "html > body:nth-of-type(1) > video:nth-of-type(1)",
                    currentTime: 42,
                    paused: true,
                },
            ],
            fields: [],
        });

        expect(video.currentTime).toBe(42);
        expect(video.play).not.toHaveBeenCalled();
    });

    it("defers the seek until metadata arrives", () => {
        html(`<video></video>`);
        const video = document.querySelector("video") as HTMLVideoElement;
        Object.defineProperty(video, "readyState", { value: 0, configurable: true });
        video.play = vi.fn(() => Promise.resolve());

        restoreSnapshot({
            media: [
                {
                    selector: "html > body:nth-of-type(1) > video:nth-of-type(1)",
                    currentTime: 12,
                    paused: false,
                },
            ],
            fields: [],
        });

        expect(video.currentTime).toBe(0);
        video.dispatchEvent(new Event("loadedmetadata"));
        expect(video.currentTime).toBe(12);
        expect(video.play).toHaveBeenCalled();
    });

    it("swallows a rejected play() from the autoplay policy", () => {
        html(`<video></video>`);
        const video = document.querySelector("video") as HTMLVideoElement;
        Object.defineProperty(video, "readyState", { value: 1, configurable: true });
        video.play = vi.fn(() => Promise.reject(new Error("NotAllowedError")));

        expect(() =>
            restoreSnapshot({
                media: [
                    {
                        selector: "html > body:nth-of-type(1) > video:nth-of-type(1)",
                        currentTime: 3,
                        paused: false,
                    },
                ],
                fields: [],
            }),
        ).not.toThrow();
    });
});

describe("capture functions stay injectable", () => {
    // chrome.scripting.executeScript serialises these with
    // Function.prototype.toString and re-evaluates them in the page. Anything
    // they reference from module scope survives bundling but is undefined in
    // the page, and fails silently. These tests take that exact path.
    function reify<T>(fn: T): T {
        return new Function(`return (${String(fn)})`)() as T;
    }

    it("captureSnapshot works after a toString round-trip", () => {
        html(`
            <input type="text" value="typed">
            <input type="password" value="hunter2">
        `);
        const injected = reify(captureSnapshot);
        const snapshot = injected();
        expect(snapshot.fields).toHaveLength(1);
        expect(snapshot.fields[0].value).toBe("typed");
    });

    it("restoreSnapshot works after a toString round-trip", () => {
        html(`<input type="text" value="original">`);
        const snapshot = captureSnapshot();
        (document.querySelector("input") as HTMLInputElement).value = "";

        reify(restoreSnapshot)(snapshot);

        expect((document.querySelector("input") as HTMLInputElement).value).toBe("original");
    });

    it("reference no module-scope identifier", () => {
        for (const fn of [captureSnapshot, restoreSnapshot]) {
            const source = fn.toString();
            expect(source).not.toMatch(/\bisEmptySnapshot\b/);
            expect(source).not.toMatch(/\brequire\(/);
            expect(source).not.toMatch(/\bimport\b/);
        }
    });

    it("expose a captured field through a selector the restorer accepts", () => {
        html(`<input type="text" value="v">`);
        const snapshot = captureSnapshot();
        expect(field("input:nth-of-type(1)", snapshot.fields)).toBeDefined();
    });
});

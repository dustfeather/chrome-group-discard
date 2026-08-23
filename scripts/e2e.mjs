// End-to-end smoke test for Group Snooze against a real Chrome over CDP.
//
// Loads the built extension into a throwaway Chrome profile, then drives the
// extension's own service worker (which has full chrome.* access) to build a
// real tab group, collapse it, and verify the discard -> snapshot -> restore
// cycle. This is the only layer that exercises chrome.tabs.discard and
// chrome.tabGroups for real; the vitest suite runs against fakes.
//
//   node scripts/e2e.mjs             # shipped dist: pure discard, no host grant
//   node scripts/e2e.mjs --grant     # host access granted: snapshot + restore
//
// Requires a built dist/ (pnpm run build), a display (DISPLAY / WSLg), and a
// Chrome binary. Set CHROME=/path/to/chrome to override discovery.
// Not wired into CI: needs a real browser and a display.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const GRANT = process.argv.includes("--grant");
const LABEL = GRANT ? "granted" : "no-grant";
const PORT = Number(process.env.E2E_PORT ?? 8899);
const CDP_PORT = Number(process.env.E2E_CDP_PORT ?? 9333);
const ROOT = path.resolve(import.meta.dirname, "..");

function findChrome() {
    if (process.env.CHROME) return process.env.CHROME;

    // Prefer a Chrome-for-Testing build from the puppeteer/playwright caches:
    // system chromium is often a snap, whose confinement breaks --user-data-dir
    // in /tmp and --load-extension. Sort by parsed version, not by path string.
    const pools = [
        path.join(os.homedir(), ".cache/puppeteer/chrome"),
        path.join(os.homedir(), ".cache/ms-playwright"),
    ];
    const managed = [];
    for (const base of pools) {
        if (!fs.existsSync(base)) continue;
        for (const entry of fs.readdirSync(base)) {
            if (entry.includes("headless")) continue;
            for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
                const candidate = path.join(base, entry, rel);
                if (!fs.existsSync(candidate)) continue;
                const digits = (entry.match(/\d+/g) ?? ["0"]).map(Number);
                managed.push({ candidate, digits });
            }
        }
    }
    managed.sort((a, b) => {
        for (let i = 0; i < Math.max(a.digits.length, b.digits.length); i++) {
            const diff = (a.digits[i] ?? 0) - (b.digits[i] ?? 0);
            if (diff) return diff;
        }
        return 0;
    });
    if (managed.length) return managed.at(-1).candidate;

    for (const fixed of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"]) {
        if (fs.existsSync(fixed)) return fixed;
    }
    throw new Error(
        "no Chrome-for-Testing build found — run `npx puppeteer browsers install chrome`, or set CHROME=/path/to/chrome. " +
            "Snap chromium is deliberately not used: its confinement breaks --user-data-dir and --load-extension.",
    );
}

const CHROME = findChrome();

/**
 * permissions.request() needs a real user gesture and its consent bubble cannot
 * be driven over CDP, so the granted run uses a throwaway copy of the build
 * with <all_urls> promoted to a required permission. Nothing else differs.
 */
function extensionDir() {
    const dist = path.join(ROOT, "dist");
    if (!fs.existsSync(path.join(dist, "manifest.json"))) {
        throw new Error("dist/ not built — run `pnpm run build` first");
    }
    if (!GRANT) return dist;
    const out = path.join(ROOT, "dist-e2e");
    fs.rmSync(out, { recursive: true, force: true });
    fs.cpSync(dist, out, { recursive: true });
    const manifestPath = path.join(out, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.host_permissions = ["<all_urls>"];
    delete manifest.optional_host_permissions;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    return out;
}

const EXT_DIR = extensionDir();

const results = [];
const check = (name, pass, detail = "") => {
    results.push({ name, pass, detail });
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- test pages

/** 10s of silent 16-bit PCM so <audio>.currentTime is real and seekable. */
function silentWav(seconds = 10, rate = 8000) {
    const samples = seconds * rate;
    const data = Buffer.alloc(samples * 2);
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}

const WAV = silentWav();

const page = (n) => `<!doctype html><html><head><meta charset=utf-8><title>page ${n}</title></head><body>
<h1>page ${n}</h1>
<form>
  <input id="notes" type="text" name="notes">
  <textarea id="body"></textarea>
  <input id="agree" type="checkbox">
  <select id="pick"><option value="a">a</option><option value="b">b</option></select>
  <input id="secret" type="password" name="password">
  <input id="card" type="text" autocomplete="cc-number">
  <input id="otp" type="text" autocomplete="one-time-code">
</form>
<audio id="clip" src="/clip.wav" preload="auto"></audio>
</body></html>`;

const server = http.createServer((req, res) => {
    if (req.url === "/clip.wav") {
        // Byte-range support is mandatory: without it Chrome will not make the
        // resource seekable after the tab reloads, and every currentTime write
        // is clamped back to 0.
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
        if (range) {
            const start = range[1] ? Number(range[1]) : 0;
            const end = range[2] ? Number(range[2]) : WAV.length - 1;
            const slice = WAV.subarray(start, end + 1);
            res.writeHead(206, {
                "content-type": "audio/wav",
                "accept-ranges": "bytes",
                "content-range": `bytes ${start}-${end}/${WAV.length}`,
                "content-length": slice.length,
            });
            return res.end(slice);
        }
        res.writeHead(200, {
            "content-type": "audio/wav",
            "accept-ranges": "bytes",
            "content-length": WAV.length,
        });
        return res.end(WAV);
    }
    const n = req.url === "/2" ? 2 : 1;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(page(n));
});

// ----------------------------------------------------------------------- CDP

let nextId = 1;
class Cdp {
    constructor(ws) {
        this.ws = ws;
        this.pending = new Map();
        this.listeners = [];
        ws.addEventListener("message", (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
            } else {
                for (const fn of this.listeners) fn(msg);
            }
        });
    }
    on(fn) {
        this.listeners.push(fn);
    }
    send(method, params = {}, sessionId) {
        const id = nextId++;
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        this.ws.send(JSON.stringify(payload));
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            setTimeout(() => {
                if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
            }, 30000);
        });
    }
}

async function connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", reject, { once: true });
    });
    return new Cdp(ws);
}

async function fetchJson(url, tries = 40) {
    for (let i = 0; i < tries; i++) {
        try {
            const r = await fetch(url);
            if (r.ok) return await r.json();
        } catch {
            /* not up yet */
        }
        await sleep(250);
    }
    throw new Error(`no CDP endpoint at ${url}`);
}

// ---------------------------------------------------------------------- main

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "gs-e2e-"));
let chrome;

async function main() {
    await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

    chrome = spawn(
        CHROME,
        [
            `--user-data-dir=${profile}`,
            `--remote-debugging-port=${CDP_PORT}`,
            `--load-extension=${EXT_DIR}`,
            `--disable-extensions-except=${EXT_DIR}`,
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-search-engine-choice-screen",
            "--test-type",
            "about:blank",
        ],
        { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DISPLAY: ":0" } },
    );
    const chromeErr = [];
    chrome.stderr.on("data", (d) => chromeErr.push(String(d)));

    console.log(`[${LABEL}] chrome: ${CHROME}\n[${LABEL}] extension: ${path.relative(ROOT, EXT_DIR)}\n`);
    const version = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
    const cdp = await connect(version.webSocketDebuggerUrl);
    await cdp.send("Target.setDiscoverTargets", { discover: true });

    // --- the extension's service worker -----------------------------------
    let sw = null;
    for (let i = 0; i < 60 && !sw; i++) {
        const { targetInfos } = await cdp.send("Target.getTargets");
        sw = targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"));
        if (!sw) await sleep(250);
    }
    check("extension loaded (service worker target present)", !!sw, sw ? new URL(sw.url).host : chromeErr.join("").slice(-300));
    if (!sw) return;

    // MV3 service workers get torn down when idle, which invalidates the
    // attached execution context. Re-resolve + re-attach on demand rather than
    // caching one session for the whole run.
    const swErrors = [];
    let sessionId = null;

    const attachSW = async () => {
        for (let i = 0; i < 80; i++) {
            const { targetInfos } = await cdp.send("Target.getTargets");
            const t = targetInfos.find((x) => x.type === "service_worker" && x.url.startsWith("chrome-extension://"));
            if (t) {
                const { sessionId: sid } = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
                await cdp.send("Runtime.enable", {}, sid);
                await cdp.send("Log.enable", {}, sid).catch(() => {});
                // Wait for the chrome.* bindings to actually be installed.
                for (let j = 0; j < 40; j++) {
                    const probe = await cdp.send(
                        "Runtime.evaluate",
                        { expression: "typeof chrome !== 'undefined' && !!chrome.permissions && !!chrome.tabGroups", returnByValue: true },
                        sid,
                    );
                    if (probe.result?.value === true) return sid;
                    await sleep(100);
                }
                return sid;
            }
            await sleep(250);
        }
        throw new Error("extension service worker target never appeared");
    };

    cdp.on((msg) => {
        if (msg.sessionId !== sessionId) return;
        if (msg.method === "Runtime.exceptionThrown") {
            swErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
        }
        if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
            swErrors.push(msg.params.entry.text);
        }
    });

    sessionId = await attachSW();

    /** Evaluate an async expression inside the extension service worker. */
    const inSW = async (expr, attempt = 0) => {
        try {
            const r = await cdp.send(
                "Runtime.evaluate",
                { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true },
                sessionId,
            );
            if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "SW eval threw");
            return r.result.value;
        } catch (err) {
            const stale = /Cannot read properties of undefined|not defined|detached|Target closed|Session with given id|Inspected target/i.test(String(err.message));
            if (stale && attempt < 3) {
                // Nudge the worker awake, re-attach, retry.
                await sleep(400);
                sessionId = await attachSW();
                return inSW(expr, attempt + 1);
            }
            throw err;
        }
    };

    /** Attach to a page target by URL suffix and evaluate in the PAGE, not the extension. */
    const pageSession = async (suffix) => {
        for (let i = 0; i < 80; i++) {
            const { targetInfos } = await cdp.send("Target.getTargets");
            const t = targetInfos.find((x) => x.type === "page" && x.url.endsWith(suffix));
            if (t) {
                const { sessionId: sid } = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
                await cdp.send("Runtime.enable", {}, sid);
                return sid;
            }
            await sleep(250);
        }
        throw new Error(`no page target ending in ${suffix}`);
    };

    const inPage = async (sid, expr) => {
        const r = await cdp.send(
            "Runtime.evaluate",
            { expression: `(() => { ${expr} })()`, returnByValue: true, awaitPromise: true },
            sid,
        );
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "page eval threw");
        return r.result.value;
    };

    const hasHostPermission = await inSW(`return await chrome.permissions.contains({origins:["<all_urls>"]});`);
    console.log(`\n[${LABEL}] <all_urls> granted: ${hasHostPermission}\n`);

    // --- build a real tab group -------------------------------------------
    const tabIds = await inSW(`
        const a = await chrome.tabs.create({ url: "http://127.0.0.1:${PORT}/1", active: false });
        const b = await chrome.tabs.create({ url: "http://127.0.0.1:${PORT}/2", active: false });
        return [a.id, b.id];
    `);

    await inSW(`
        const want = ${JSON.stringify(tabIds)};
        for (let i = 0; i < 80; i++) {
            const tabs = await Promise.all(want.map((id) => chrome.tabs.get(id)));
            if (tabs.every((t) => t.status === "complete")) return true;
            await new Promise((r) => setTimeout(r, 250));
        }
        throw new Error("tabs never finished loading");
    `);

    // Type into each page over CDP — a real page context, no extension involvement,
    // so this works identically with and without the host grant.
    const FILL = (tag) => `
        document.getElementById("notes").value = "typed-${tag}";
        document.getElementById("body").value = "draft-${tag}";
        document.getElementById("agree").checked = true;
        document.getElementById("pick").value = "b";
        document.getElementById("secret").value = "hunter2";
        document.getElementById("card").value = "4111111111111111";
        document.getElementById("otp").value = "123456";
        const clip = document.getElementById("clip");
        clip.currentTime = 4.25;
        return { notes: document.getElementById("notes").value, clip: clip.currentTime };
    `;

    const pageSids = {};
    for (const [i, id] of tabIds.entries()) {
        const sid = await pageSession(`/${i + 1}`);
        pageSids[id] = sid;
        const filled = await inPage(sid, FILL(String(id)));
        if (i === 0) check("test page primed (typed text + media position)", filled.notes === `typed-${id}` && filled.clip > 4, JSON.stringify(filled));
    }

    const groupId = await inSW(`
        const gid = await chrome.tabs.group({ tabIds: ${JSON.stringify(tabIds)} });
        await chrome.tabGroups.update(gid, { title: "E2E", color: "blue" });
        await new Promise((r) => setTimeout(r, 400));
        return gid;
    `);
    check("tab group created and titled", typeof groupId === "number" && groupId > 0, `groupId=${groupId}`);

    const recordAfterTitle = await inSW(`
        const all = await chrome.storage.local.get("groups");
        return all.groups ?? null;
    `);
    check(
        "titled group recorded in storage",
        !!recordAfterTitle && Object.values(recordAfterTitle).some((r) => r.title === "E2E" && r.groupId === groupId),
        JSON.stringify(recordAfterTitle),
    );

    // --- collapse: the whole behaviour under test --------------------------
    await inSW(`await chrome.tabGroups.update(${groupId}, { collapsed: true }); return true;`);
    await sleep(2500);

    const discarded = await inSW(`
        const tabs = await Promise.all(${JSON.stringify(tabIds)}.map((id) => chrome.tabs.get(id)));
        return tabs.map((t) => ({ id: t.id, discarded: t.discarded, url: t.url }));
    `);
    check(
        "every tab in the collapsed group was discarded",
        discarded.every((t) => t.discarded),
        JSON.stringify(discarded.map((t) => `${t.id}:${t.discarded}`)),
    );

    const stored = await inSW(`
        const keys = ${JSON.stringify(tabIds)}.map((id) => "snapshot:" + id);
        const got = await chrome.storage.local.get(keys);
        return keys.map((k) => got[k] ?? null);
    `);

    if (hasHostPermission) {
        check("a snapshot was stored per tab", stored.every(Boolean), `${stored.filter(Boolean).length}/${stored.length}`);
        const first = stored[0];
        if (first) {
            const values = first.snapshot.fields.map((f) => f.value);
            check("snapshot captured the typed text", values.some((v) => String(v).startsWith("typed-")), JSON.stringify(values));
            check("snapshot captured media position", first.snapshot.media.some((m) => Math.abs(m.currentTime - 4.25) < 0.5), JSON.stringify(first.snapshot.media));
            const leaked = values.filter((v) => v === "hunter2" || v === "4111111111111111" || v === "123456");
            check("password / cc / otp were NOT captured", leaked.length === 0, leaked.length ? `LEAKED ${JSON.stringify(leaked)}` : "none");
            check("snapshot keyed to the captured url", first.url.startsWith(`http://127.0.0.1:${PORT}/`), first.url);
        }
    } else {
        check("no snapshots stored without host permission", stored.every((s) => s === null), JSON.stringify(stored.map(Boolean)));
    }

    // --- expand + wake the tab --------------------------------------------
    await inSW(`
        await chrome.tabGroups.update(${groupId}, { collapsed: false });
        await chrome.tabs.update(${tabIds[0]}, { active: true });
        for (let i = 0; i < 80; i++) {
            const t = await chrome.tabs.get(${tabIds[0]});
            if (!t.discarded && t.status === "complete") return true;
            await new Promise((r) => setTimeout(r, 250));
        }
        throw new Error("tab never woke up");
    `);
    await sleep(1500);

    const wokenSid = await pageSession("/1");

    const restored = await inPage(
        wokenSid,
        `return {
            notes: document.getElementById("notes").value,
            body: document.getElementById("body").value,
            agree: document.getElementById("agree").checked,
            pick: document.getElementById("pick").value,
            secret: document.getElementById("secret").value,
            clip: document.getElementById("clip").currentTime,
        };`,
    );

    if (hasHostPermission) {
        check("form text restored after wake", restored.notes === `typed-${tabIds[0]}`, JSON.stringify(restored.notes));
        check("textarea restored after wake", restored.body === `draft-${tabIds[0]}`, JSON.stringify(restored.body));
        check("checkbox restored after wake", restored.agree === true, String(restored.agree));
        check("select restored after wake", restored.pick === "b", restored.pick);
        check("password NOT restored (never captured)", restored.secret === "", JSON.stringify(restored.secret));
        check("media position restored after wake", Math.abs(restored.clip - 4.25) < 0.75, String(restored.clip));
    } else {
        check("nothing restored without host permission", restored.notes === "", JSON.stringify(restored.notes));
    }

    const leftover = await inSW(`
        const keys = ${JSON.stringify(tabIds)}.map((id) => "snapshot:" + id);
        const got = await chrome.storage.local.get(keys);
        return got["snapshot:${tabIds[0]}"] ?? null;
    `);
    check("snapshot consumed after restore", leftover === null, leftover ? "still present" : "cleared");

    // --- per-group opt-out --------------------------------------------------
    // Wake BOTH tabs first: tab 2 is still discarded from the collapse above,
    // and a leftover discarded tab would masquerade as a fresh discard.
    await inSW(`
        for (const id of ${JSON.stringify(tabIds)}) {
            await chrome.tabs.update(id, { active: true });
            for (let i = 0; i < 80; i++) {
                const t = await chrome.tabs.get(id);
                if (!t.discarded && t.status === "complete") break;
                await new Promise((r) => setTimeout(r, 250));
            }
        }
        return true;
    `);
    const beforeOptOut = await inSW(`
        const tabs = await Promise.all(${JSON.stringify(tabIds)}.map((id) => chrome.tabs.get(id)));
        return tabs.map((t) => t.discarded);
    `);
    check("both tabs awake before the opt-out check", beforeOptOut.every((d) => d === false), JSON.stringify(beforeOptOut));

    await inSW(`
        const all = await chrome.storage.local.get("groups");
        const groups = all.groups ?? {};
        for (const k of Object.keys(groups)) if (groups[k].title === "E2E") groups[k].excluded = true;
        await chrome.storage.local.set({ groups });
        return true;
    `);
    await inSW(`await chrome.tabGroups.update(${groupId}, { collapsed: true }); return true;`);
    await sleep(2500);
    const afterOptOut = await inSW(`
        const tabs = await Promise.all(${JSON.stringify(tabIds)}.map((id) => chrome.tabs.get(id)));
        return tabs.map((t) => t.discarded);
    `);
    check("excluded group is NOT discarded on collapse", afterOptOut.every((d) => d === false), JSON.stringify(afterOptOut));

    // --- untitled groups are inert -----------------------------------------
    await inSW(`await chrome.tabGroups.update(${groupId}, { collapsed: false }); return true;`);
    const untitled = await inSW(`
        const t = await chrome.tabs.create({ url: "http://127.0.0.1:${PORT}/1", active: false });
        for (let i = 0; i < 80; i++) { const x = await chrome.tabs.get(t.id); if (x.status === "complete") break; await new Promise((r) => setTimeout(r, 250)); }
        const gid = await chrome.tabs.group({ tabIds: [t.id] });
        await chrome.tabGroups.update(gid, { collapsed: true });
        await new Promise((r) => setTimeout(r, 2000));
        const after = await chrome.tabs.get(t.id);
        return { discarded: after.discarded };
    `);
    check("untitled group is never auto-discarded", untitled.discarded === false, JSON.stringify(untitled));

    check("no uncaught errors in the service worker", swErrors.length === 0, swErrors.slice(0, 3).join(" | "));
}

main()
    .catch((err) => {
        check("harness completed", false, String(err && err.message ? err.message : err));
    })
    .finally(async () => {
        try {
            chrome?.kill("SIGKILL");
        } catch {
            /* already gone */
        }
        server.close();
        fs.rmSync(profile, { recursive: true, force: true });
        const failed = results.filter((r) => !r.pass);
        console.log(`\n[${LABEL}] ${results.length - failed.length}/${results.length} checks passed`);
        process.exit(failed.length ? 1 : 0);
    });

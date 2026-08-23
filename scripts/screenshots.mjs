// Capture Chrome Web Store / GitHub Pages screenshots of the real options page.
//
//   node scripts/screenshots.mjs
//
// Loads dist/ into a throwaway Chrome profile, builds three real tab groups so
// the list is genuinely populated, then captures the options page at the exact
// pixel sizes the Web Store accepts. Needs a built dist/ and a display
// (DISPLAY / WSLg). Set CHROME=/path/to/chrome to override discovery.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const EXT_DIR = path.join(ROOT, "dist");
const OUT_DIR = path.join(ROOT, "docs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
    if (process.env.CHROME) return process.env.CHROME;
    // Snap chromium is deliberately excluded: confinement breaks
    // --user-data-dir in /tmp and --load-extension.
    const pools = [path.join(os.homedir(), ".cache/puppeteer/chrome"), path.join(os.homedir(), ".cache/ms-playwright")];
    const found = [];
    for (const pool of pools) {
        if (!fs.existsSync(pool)) continue;
        for (const entry of fs.readdirSync(pool)) {
            for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
                const candidate = path.join(pool, entry, rel);
                if (fs.existsSync(candidate)) found.push({ entry, candidate });
            }
        }
    }
    if (!found.length) throw new Error("no Chrome-for-Testing build found; set CHROME=/path/to/chrome");
    found.sort((a, b) => a.entry.localeCompare(b.entry, undefined, { numeric: true }));
    return found.at(-1).candidate;
}

async function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

class Cdp {
    constructor(ws) {
        this.ws = ws;
        this.id = 0;
        this.pending = new Map();
        ws.addEventListener("message", (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) reject(new Error(`${msg.error.message} (${msg.method ?? ""})`));
                else resolve(msg.result);
            }
        });
    }
    send(method, params = {}, sessionId) {
        const id = ++this.id;
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

async function fetchJson(url, tries = 60) {
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "gs-shots-"));
let chrome;
const written = [];

async function main() {
    if (!fs.existsSync(path.join(EXT_DIR, "manifest.json"))) throw new Error(`no build at ${EXT_DIR} — run pnpm run build`);
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const CHROME = findChrome();
    const CDP_PORT = await freePort();
    console.log(`chrome: ${CHROME}\nport:   ${CDP_PORT}\nprofile:${profile}`);

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
            "--force-color-profile=srgb",
            "--hide-scrollbars",
            "--test-type",
            "about:blank",
        ],
        { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, DISPLAY: process.env.DISPLAY || ":0" } },
    );
    const chromeErr = [];
    chrome.stderr.on("data", (d) => chromeErr.push(String(d)));
    chrome.on("exit", (code) => {
        if (code !== 0 && code !== null) console.error(chromeErr.join("").slice(-2000));
    });

    const version = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
    const cdp = await connect(version.webSocketDebuggerUrl);
    await cdp.send("Target.setDiscoverTargets", { discover: true });

    // --- extension service worker -------------------------------------------
    let swSession = null;
    let extId = null;
    for (let i = 0; i < 80 && !swSession; i++) {
        const { targetInfos } = await cdp.send("Target.getTargets");
        const t = targetInfos.find((x) => x.type === "service_worker" && x.url.startsWith("chrome-extension://"));
        if (t) {
            extId = new URL(t.url).host;
            const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
            await cdp.send("Runtime.enable", {}, sessionId);
            swSession = sessionId;
            break;
        }
        await sleep(250);
    }
    if (!swSession) throw new Error("extension service worker target never appeared");
    console.log(`ext id: ${extId}`);

    const inSW = async (body) => {
        const r = await cdp.send(
            "Runtime.evaluate",
            { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true },
            swSession,
        );
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "SW eval threw");
        return r.result.value;
    };
    for (let i = 0; i < 60; i++) {
        const ready = await inSW("return !!(chrome.tabGroups && chrome.tabs && chrome.storage);");
        if (ready) break;
        await sleep(100);
    }

    // --- seed: three real tab groups ----------------------------------------
    // Research is made real and then closed, so its record legitimately falls
    // back to "not open" on the next rebind rather than being faked.
    const seeded = await inSW(`
        const mk = async (title, color, urls) => {
            const ids = [];
            for (const url of urls) {
                const tab = await chrome.tabs.create({ url, active: false });
                ids.push(tab.id);
            }
            const gid = await chrome.tabs.group({ tabIds: ids });
            await chrome.tabGroups.update(gid, { title, color });
            return { gid, ids };
        };
        const work = await mk("Work", "blue", ["about:blank", "about:blank", "about:blank"]);
        const reading = await mk("Reading", "green", ["about:blank", "about:blank"]);
        const research = await mk("Research", "purple", ["about:blank", "about:blank"]);
        await new Promise((r) => setTimeout(r, 600));
        await chrome.tabs.remove(research.ids);
        await new Promise((r) => setTimeout(r, 600));
        // Opt Reading out so the screenshot shows both toggle states.
        const KEY_SEP = "\\u0000";
        const got = await chrome.storage.local.get("groups");
        const groups = got.groups ?? {};
        const key = "Reading" + KEY_SEP + "green";
        if (!groups[key]) groups[key] = { groupId: reading.gid, title: "Reading", color: "green", excluded: true };
        else groups[key] = { ...groups[key], excluded: true };
        await chrome.storage.local.set({ groups });
        return Object.keys(groups).map((k) => k.replace(KEY_SEP, " / "));
    `);
    console.log(`seeded records: ${JSON.stringify(seeded)}`);

    // --- options page --------------------------------------------------------
    const optionsUrl = `chrome-extension://${extId}/src/options/options.html`;
    const { targetId } = await cdp.send("Target.createTarget", { url: optionsUrl });
    const { sessionId: page } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, page);
    await cdp.send("Runtime.enable", {}, page);
    await cdp.send("DOM.enable", {}, page);

    const inPage = async (body) => {
        const r = await cdp.send(
            "Runtime.evaluate",
            { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true },
            page,
        );
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "page eval threw");
        return r.result.value;
    };

    const waitRendered = async () => {
        for (let i = 0; i < 80; i++) {
            const state = await inPage(`
                return {
                    rows: document.querySelectorAll("#groups li").length,
                    perm: document.getElementById("permission-state")?.textContent ?? "",
                    fonts: document.fonts ? document.fonts.status : "n/a",
                };
            `);
            if (state.rows >= 3 && !state.perm.startsWith("Checking")) return state;
            await sleep(150);
        }
        throw new Error("options page never rendered the seeded rows");
    };

    const setMedia = async (scheme) =>
        cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] }, page);

    const setViewport = async (width, height, dsf = 1) =>
        cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dsf, mobile: false }, page);

    const shot = async (file, { clip } = {}) => {
        const params = { format: "png", captureBeyondViewport: false, fromSurface: true };
        if (clip) {
            params.clip = clip;
            params.captureBeyondViewport = true;
        }
        const { data } = await cdp.send("Page.captureScreenshot", params, page);
        const out = path.join(OUT_DIR, file);
        fs.writeFileSync(out, Buffer.from(data, "base64"));
        written.push(out);
        return out;
    };

    await waitRendered();

    // The Web Store demands exactly 1280x800 / 640x400. Rather than let the
    // third card fall below the fold, measure the page at a 16:10 viewport and
    // pick the deviceScaleFactor that makes the whole thing land in frame.
    // Output pixels = viewport * dsf, so 1.6H x H at dsf 800/H is exactly
    // 1280x800 and 640x400 at dsf 400/H — same framing, two sizes.
    await setMedia("light");
    await setViewport(1280, 800);
    await sleep(300);
    const pageHeight = await inPage(`
        return Math.ceil(document.documentElement.scrollHeight);
    `);
    const H = Math.max(800, Math.ceil(pageHeight / 5) * 5);
    const W = H * 1.6;
    console.log(`page height ${pageHeight}px -> viewport ${W}x${H}, dsf ${(800 / H).toFixed(4)}`);

    // 1. 1280x800 light
    await setViewport(W, H, 800 / H);
    await sleep(400);
    await shot("screenshot-options-1280x800.png");

    // 2. 640x400 light — same composition, half scale
    await setViewport(W, H, 400 / H);
    await sleep(400);
    await shot("screenshot-options-640x400.png");

    // 3. 1280x800 dark
    await setMedia("dark");
    await setViewport(W, H, 800 / H);
    await sleep(400);
    await shot("screenshot-options-dark-1280x800.png");

    // --- verify PNG headers --------------------------------------------------
    for (const file of written) {
        const buf = fs.readFileSync(file);
        const w = buf.readUInt32BE(16);
        const h = buf.readUInt32BE(20);
        console.log(`${path.basename(file)}  ${w}x${h}  ${buf.length} bytes`);
    }
}

main()
    .then(() => {
        console.log("OK");
        process.exitCode = 0;
    })
    .catch((err) => {
        console.error(`FAIL: ${err.message}`);
        process.exitCode = 1;
    })
    .finally(async () => {
        // Not spawned detached, so the child shares our process group — a
        // negative-pid group kill would either miss or, worse, hit an unrelated
        // group. Kill the child directly; Chrome's helpers go with it.
        chrome?.kill("SIGKILL");
        await sleep(300);
        fs.rmSync(profile, { recursive: true, force: true });
    });

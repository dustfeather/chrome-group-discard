// Generates the extension icons and the Chrome Web Store listing icon.
//
//   node scripts/make-icons.mjs
//
// Writes public/icons/icon{16,48,128}.png (bundled into the extension by Vite's
// publicDir) and docs/icon.png (the 128x128 store + landing-page icon, which
// carries extra padding because the store renders it inside its own frame).
//
// Pure Node — no image dependency. Deliberately so: the icon is a handful of
// primitives, and a build-time dependency for that is not worth carrying.

import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/** Brand indigo, dark -> light down the tile. */
const BG_TOP = [0x4b, 0x5e, 0xd6];
const BG_BOTTOM = [0x33, 0x42, 0xa8];
const FG = [0xff, 0xff, 0xff];

/** Supersampling factor per axis; 4 means 16 samples per pixel. */
const SS = 4;

const crcTable = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(buf) {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixels) {
    const stride = size * 4 + 1;
    const raw = Buffer.alloc(size * stride);
    for (let y = 0; y < size; y++) {
        raw[y * stride] = 0; // filter: none
        pixels.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // colour type: RGBA
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

function inRoundedRect(x, y, w, h, r) {
    if (x < 0 || y < 0 || x > w || y > h) return false;
    const cx = Math.min(Math.max(x, r), w - r);
    const cy = Math.min(Math.max(y, r), h - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/**
 * A rounded tile carrying two pause bars — collapsing a group is the pause
 * gesture, so the toolbar icon and the store icon share one mark.
 *
 * `padding` is a fraction of the canvas left empty around the tile; the store
 * renders its icon inside a frame of its own, so it wants more breathing room
 * than the toolbar does.
 */
function render(size, padding = 0) {
    const pixels = Buffer.alloc(size * size * 4);
    const inset = size * padding;
    const tile = size - inset * 2;
    const radius = tile * 0.23;

    const barW = tile * 0.145;
    const barH = tile * 0.44;
    const gap = tile * 0.13;
    const barR = Math.min(barW / 2, tile * 0.05);
    const barTop = inset + (tile - barH) / 2;
    const barLeftX = inset + tile / 2 - gap / 2 - barW;
    const barRightX = inset + tile / 2 + gap / 2;

    const samples = SS * SS;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let tileHits = 0;
            let barHits = 0;
            for (let sy = 0; sy < SS; sy++) {
                for (let sx = 0; sx < SS; sx++) {
                    const px = x + (sx + 0.5) / SS;
                    const py = y + (sy + 0.5) / SS;
                    if (!inRoundedRect(px - inset, py - inset, tile, tile, radius)) continue;
                    tileHits++;
                    const left = inRoundedRect(px - barLeftX, py - barTop, barW, barH, barR);
                    const right = inRoundedRect(px - barRightX, py - barTop, barW, barH, barR);
                    if (left || right) barHits++;
                }
            }
            if (tileHits === 0) continue;

            const alpha = tileHits / samples;
            const barFraction = barHits / tileHits;
            const gradient = size > 1 ? y / (size - 1) : 0;
            const i = (y * size + x) * 4;
            for (let c = 0; c < 3; c++) {
                const bg = BG_TOP[c] + (BG_BOTTOM[c] - BG_TOP[c]) * gradient;
                pixels[i + c] = Math.round(bg * (1 - barFraction) + FG[c] * barFraction);
            }
            pixels[i + 3] = Math.round(alpha * 255);
        }
    }
    return encodePng(size, pixels);
}

function write(file, buffer) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buffer);
    console.log(`${path.relative(ROOT, file)}  ${buffer.length} bytes`);
}

for (const size of [16, 48, 128]) {
    write(path.join(ROOT, "public/icons", `icon${size}.png`), render(size));
}

// Store listing icon: 128x128 with padding, per the Web Store's icon guidance.
write(path.join(ROOT, "docs/icon.png"), render(128, 0.08));

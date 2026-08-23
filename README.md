# Group Snooze

Chrome extension that discards every tab in a tab group when you collapse the
group, and restores media position and form input when the tabs come back.

Collapsing a group is the pause gesture. Expanding it wakes the tabs up.

## How it works

`chrome.tabs.discard()` is the only real memory lever a Chrome extension has. A
discarded tab keeps its place in the strip and reloads from scratch when you
next click it.

Chrome's native discard already restores scroll offset and plain form fields via
the navigation entry. It does **not** restore media position, SPA state, or
JS-managed inputs. Group Snooze covers that gap with a snapshot taken in the one
window that exists — immediately before the discard call, since `beforeunload`,
`pagehide` and `unload` do not fire on discard.

There is no persistent content script and no continuous tracking. One function
is injected at discard time, and one at restore time.

## Behaviour

- Auto-pause is **on** for every titled group, with a per-group opt-out.
- Collapse discards the group immediately — no grace period, no debounce.
- Nothing is skipped: audible, pinned and recently-active tabs all go.
  Collapsing a group with music playing kills the audio. That is by design.
- **Untitled groups are never tracked** and never auto-discarded — they have no
  identity that survives a browser restart.

## Snapshots and privacy

Snapshotting needs host access, which is **optional** and off by default. Grant
it from the options page. Without it the extension still works as a pure
discarder.

Captured: `currentTime` / paused state of `<video>` and `<audio>`, plus form
field values. Never captured: passwords, hidden fields, `autocomplete="cc-*"`
payment fields, `one-time-code` fields, and anything in a form marked
`autocomplete="off"`.

Snapshots live in `chrome.storage.local`, are never transmitted anywhere, and
are dropped on restore, on a URL mismatch, on tab close, or after 24 hours.

## Install

### Build from source

Requires [Node.js](https://nodejs.org/) >= 22 and [pnpm](https://pnpm.io/) >= 10.

```bash
pnpm install
pnpm run build
```

The built extension is in `dist/`. Load it as an unpacked extension from
`chrome://extensions`.

## Usage

- **Collapse a group** — pauses it.
- **Right-click a tab → Pause this group** — same thing, from the menu.
- **Right-click a tab → Auto-pause this group** — uncheck to opt that group out.
- **Options page** — grant/revoke host access, review tracked groups, clear
  stored data.

## Development

```bash
pnpm run dev         # vite dev server with HMR
pnpm run typecheck   # tsc --noEmit
pnpm run test        # vitest, against fake chrome APIs
pnpm run build       # required before the e2e runs below
pnpm run e2e         # real Chrome: discard on collapse, no host grant
pnpm run e2e:grant   # real Chrome: snapshot capture + restore
```

The vitest suite runs against fakes. `scripts/e2e.mjs` is the only layer that
exercises `chrome.tabs.discard` and `chrome.tabGroups` for real: it loads the
built `dist/` into a throwaway Chrome profile, drives the extension's own
service worker over CDP to build and collapse a tab group, and asserts the
discard, the snapshot contents and the restore. It needs a display and a
Chrome-for-Testing build (`npx puppeteer browsers install chrome`, or set
`CHROME=`), so it is not wired into CI.

`e2e:grant` runs against a throwaway copy of the build with `<all_urls>`
promoted to a required permission — `permissions.request()` needs a real user
gesture and its consent bubble cannot be driven over CDP.

`pnpm install` points `core.hooksPath` at `.githooks`, so typecheck and tests
run on every commit.

See [DESIGN.md](DESIGN.md) for the full design and the release sequence.

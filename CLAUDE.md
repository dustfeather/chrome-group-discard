# CLAUDE.md

## Conventions

- All `chrome.storage.local` access goes through `src/storage.ts`. Group records
  are keyed on `title + color` (`groupKey`), never on `groupId` — tabGroups ids
  are unique within a browser session only.
- Pure logic (`src/groups.ts`, `src/snapshot/*`) takes plain arguments and
  returns plain values, so it is unit-testable without a chrome fake.
- Release version comes from git tags, not files. `package.json` and
  `src/manifest.json` on disk are dev placeholders; `release.yml` derives the
  next patch from the latest tag and injects it at build time (no commit back).

## Gotchas

- Service workers have no DOM (no `DOMParser`, no `document`).
- MV3 service workers are torn down between events — every listener must be
  registered synchronously at the top level of `service-worker.ts`.
- `captureSnapshot` / `restoreSnapshot` are serialised to source by
  `chrome.scripting.executeScript({ func })`. They must stay **entirely
  self-contained**: no imports, no closure variables, no module-level helpers.
  A `import type` is fine (erased at compile time); anything else silently
  breaks in the page.
- `permissions.request()` throws *"This function must be called during a user
  gesture"* from a service worker, including inside `contextMenus.onClicked`.
  That is why the grant button lives on the options page.
- Tab ids survive `discard()`, but read `.id` off the `Tab` the call resolves
  with, never a cached one. Chrome also *reuses* ids across a restart, which is
  why restore re-checks the URL before injecting.
- `beforeunload` / `pagehide` / `unload` do not fire on discard. The only
  capture window is immediately before the `discard()` call.
- Chrome has no `contextMenus.onShown` (Firefox only), so the auto-pause
  checkbox is refreshed on `tabs.onActivated`.

## Testing

- `pnpm run test` is vitest against fake chrome APIs; `pnpm run e2e` /
  `pnpm run e2e:grant` drive a real Chrome over CDP against a built `dist/`.
  Run the e2e pair after touching anything in `src/background/` or
  `src/snapshot/` — the fakes cannot catch discard/restore timing.
- The e2e harness deliberately refuses snap chromium: its confinement breaks
  `--user-data-dir` under /tmp and `--load-extension`, and the symptom is a
  useless "No tab with id: N" mid-run. It picks a Chrome-for-Testing build from
  the puppeteer/playwright caches by parsed version.
- The harness's own media server must serve HTTP byte ranges. Without
  `Accept-Ranges`/206 Chrome reports `seekable = [0,0]` on the reloaded tab and
  silently clamps every `currentTime` write to 0 — which looks exactly like a
  broken restore.
- MV3 service workers are torn down when idle, which invalidates an attached CDP
  execution context. `chrome.permissions` reads as `undefined` on a stale one;
  re-resolve the target and re-attach rather than caching one session.

## Project facts

- pnpm (not npm/yarn). Chrome only — no Firefox/AMO target.
- Per-repo ARC runner: `arc-df-chrome-group-discard`. It must exist in k3s
  before any workflow can run.
- `release.yml`'s `publish-chrome` job is **live**: every push to `main` cuts a
  release and publishes it to the Chrome Web Store. It passes
  `artifact-name: extension` because the shared workflow defaults to
  `extensions`. A missing `CHROME_*` secret makes it skip and exit 0 — a green
  run is not proof of a publish; grep the log for `uploadState: SUCCESS`.
- `release.yml` sets `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` — needed until
  `softprops/action-gh-release` ships v3.

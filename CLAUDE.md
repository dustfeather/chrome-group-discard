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

## Project facts

- pnpm (not npm/yarn). Chrome only — no Firefox/AMO target.
- Per-repo ARC runner: `arc-df-chrome-group-discard`. It must exist in k3s
  before any workflow can run.
- `release.yml` has the `publish-chrome` job commented out until the Chrome Web
  Store item exists — see the PAUSE checklist in `DESIGN.md` §7.
- `release.yml` sets `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` — needed until
  `softprops/action-gh-release` ships v3.

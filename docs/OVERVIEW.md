# chrome-group-discard

## Goal

"Group Snooze", a Chrome extension. When you collapse a tab group, it discards every tab in that group. When the tabs come back, it restores media position and form input. Collapsing a group pauses it and expanding it wakes the tabs up.

- Discard uses `chrome.tabs.discard()`, the only real memory lever an extension has. Discarded tabs keep their place in the tab strip and reload when clicked.
- Snapshot/restore fills the gap left by Chrome's native discard, which already restores scroll offset and plain form fields but not media position, SPA state or JS-managed inputs. The snapshot is taken immediately before the discard call, because `beforeunload`, `pagehide` and `unload` do not fire on discard.

## Stack

- TypeScript (`typescript` ^7.0.2), `type: module`.
- Vite ^8.3.0 with `@crxjs/vite-plugin` ^2.7.1 for the extension build. Sass for styles.
- `@types/chrome` ^0.3.0.
- Tests: Vitest ^4.1.11 with jsdom, run against fake Chrome APIs. Real-Chrome e2e via `scripts/e2e.mjs`, which drives the service worker over CDP on a Chrome-for-Testing build.
- Tooling: pnpm (README says >= 10; the latest CI commit takes pnpm 12 as a range) with settings in `pnpm-workspace.yaml`. Node.js >= 22.

## Repo

- `dustfeather/chrome-group-discard` (confirmed: `git@github.com:dustfeather/chrome-group-discard.git`). The package name is `group-snooze`, version 1.0.0.
- Layout: `src/background/` (service worker), `src/options/` (options page), `src/snapshot/` (injected capture/restore). `public/icons/`, `tests/` (vitest), `scripts/` (`e2e.mjs`, `screenshots.mjs`), `docs/`, and `DESIGN.md` (full design plus the release sequence).
- `.githooks/`: `pnpm install` sets `core.hooksPath` so typecheck and tests run on every commit.
- `.github/workflows/` (release workflow, shared-workflows callers, Dependabot auto-merge) and `.github/ISSUE_TEMPLATE/`.

## Deploy

A browser extension that runs in the user's Chrome. `pnpm run build` writes it to `dist/`, and you load that as an unpacked extension from `chrome://extensions`. A `release.yml` GitHub Actions workflow exists (README badge), and `DESIGN.md` documents the release sequence. There is no container or cluster manifest, so it is not hosted on the homelab.

## Status

active, v1.0.0. Recent work is CI and dependency maintenance:

- shared-workflows re-pinned @v5 → @v6 → @v7.
- pnpm settings moved to `pnpm-workspace.yaml`, and pnpm 12 is taken as a range.
- The interactive Claude job moved off the ARC pool.
- Dependabot bumps to vite, jsdom and @types/chrome.

## Notes

- Behaviour: auto-pause is on for every titled group, with a per-group opt-out through the right-click menu ("Auto-pause this group"). Collapsing discards the group immediately, with no grace period or debounce. Nothing is skipped: audible, pinned and recently active tabs all get discarded. This is by design.
- Untitled groups are never tracked or auto-discarded because they have no identity that survives a browser restart.
- No persistent content script and no continuous tracking. One function is injected at discard time and one at restore time.
- Privacy: host access is optional, off by default, and granted from the options page. Without it the extension works as a plain discarder. It captures only `<video>`/`<audio>` `currentTime`/paused state and form values. It never captures passwords, hidden fields, `cc-*` payment fields, `one-time-code` fields, or anything in forms marked `autocomplete="off"`. Snapshots stay in `chrome.storage.local` and are never transmitted. They are dropped on restore, on a URL mismatch, on tab close, or after 24h.
- Testing gap: only `scripts/e2e.mjs` exercises `chrome.tabs.discard`/`chrome.tabGroups` for real. It needs a display and Chrome-for-Testing, so it is not wired into CI. `e2e:grant` promotes `<all_urls>` to a required permission in a throwaway build copy, because the `permissions.request()` consent bubble cannot be driven over CDP.
- CI consumes [shared-workflows](https://github.com/dustfeather/shared-workflows/blob/main/docs/OVERVIEW.md).
- Area: Software Engineering

## Log

- **2026-09-29** — Note created from repo scan.

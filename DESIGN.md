# Group Snooze — design

Chrome MV3 extension. Discards every tab in a tab group when the group is
collapsed, and restores media position + form input when the tabs come back.

Repo/dir: `chrome-group-discard`. Manifest name: **Group Snooze**. Chrome only.

---

## 1. Core mechanism

`chrome.tabs.discard(tabId)` is the only real memory lever available to an
extension. A discarded tab keeps its strip entry and reloads from scratch on
next activation.

Chrome's native discard already restores scroll offset and plain form fields
via the navigation entry. It does **not** restore media position, SPA/JS-built
state, or JS-managed inputs. Our snapshot layer covers that gap.

`beforeunload` / `pagehide` / `unload` do **not** fire on discard, so the only
capture window is immediately before we call `discard()`.

## 2. Trigger

Auto-pause is **globally ON**, with per-group opt-out.

`chrome.tabGroups.onUpdated` → `collapsed: true` → discard immediately. No
grace period, no debounce. Collapsing a group is therefore a destructive-ish
gesture by design; an incidental collapse+expand costs a full group reload.

Manual pause collapses the group, which falls through to the same handler.
One code path, and paused/collapsed can never visually disagree.

## 3. Skip rules

Skip nothing. Audible tabs, pinned tabs and recently-active tabs are all
discarded. The only exception is Chrome's own refusal to discard the active
tab — and collapsing a group moves activation out of that group anyway, so in
practice the whole group goes.

Consequence, accepted: collapsing a group with music playing kills the audio.

## 4. Group identity

`tabGroups` ids are unique **within a browser session only**; a restored group
gets a new id. Records are therefore keyed on `title + color`.

Stored record: `{ groupId, title, color, excluded }`

- `groupId` is a runtime cache, never the durable key.
- `tabGroups.onUpdated` fires on title/color change → rewrite the record in
  place keyed by live `groupId`, carrying `excluded` across. This closes the
  rename hole completely while the browser is running.
- `runtime.onStartup` → re-resolve stored records against live groups by
  `title + color`, re-bind fresh ids.

**Untitled groups are out of scope**: not tracked, never auto-discarded.

Duplicate `title + color`: the exclusion applies to *all* matching groups. No
tiebreak heuristic — over-excluding is the safe direction under global-ON.

## 5. Snapshot layer

Captures **media timestamp + form data**. Tabs with unsaved input are
discarded and restored, not skipped.

**Capture on discard only.** No persistent content script, no continuous
tracking, no submit detection. `chrome.scripting.executeScript` injects one
function at discard time that returns media `currentTime`/`paused` plus
filtered field values; then we discard. If the page is unresponsive the
snapshot is skipped and we discard anyway.

This is what removes the whole AJAX/SPA submit-detection problem: data only
exists in the discard→restore window, so "was it submitted" never arises. No
MAIN-world injection, no fetch/XHR interception.

### Field filtering (strict allowlist posture)

Excluded from capture: `input[type=password]`, `type=hidden`,
`autocomplete="cc-*"`, `autocomplete="one-time-code"`, and fields inside a
form with `autocomplete="off"`.

### Storage and keying

`chrome.storage.local`, keyed `{ tabId, url, snapshot }`.

Tab ids **are** retained across discard (read `.id` off the `Tab` that
`discard()` resolves with, never a cached one), but Chrome *reuses* ids after
a restart. Restore therefore injects only if the reloaded tab's URL still
matches the captured URL — mismatch means silently drop the snapshot. This
closes the cross-tab leak where old form values land in an unrelated tab.

Cleared on: successful restore, URL mismatch, tab close. TTL sweep as backstop.

(`sessions.setTabValue()` is Firefox-only — not available to us.)

### Permission

`optional_host_permissions: ["<all_urls>"]`. Install prompt stays clean and
the extension works as pure discard with no grant. Snapshotting activates once
granted. Every discard path checks `permissions.contains()` first.

## 6. UI surfaces

**Tab context menu** (`contexts: ['tab']`, needs `contextMenus`):
- "Pause this group"
- "Auto-pause this group" — `type: 'checkbox'`, checked by default; unchecking
  writes `excluded: true`. Refreshed per-tab via `contextMenus.update` on
  `tabs.onActivated`.

No popup. No keyboard shortcut.

**Options page**: hosts the `permissions.request()` button for the optional
`<all_urls>` grant. Required because `permissions.request()` needs a real
user-gesture context and throws *"This function must be called during a user
gesture"* from an MV3 service worker, including inside
`contextMenus.onClicked`. Also the natural home for the record list and a
"clear stored data" control.

## 7. Stack and CI

Template: `filelist-ext`. pnpm + Vite + `@crxjs/vite-plugin` + TypeScript +
`@types/chrome`.

Tests: **Vitest with mocked chrome APIs**. Pure logic (group matching, rebind,
snapshot keying, field filtering) unit tested directly; event handlers tested
end-to-end against a fake `chrome.tabGroups` / `tabs` / `storage`.

Workflows copied from `filelist-ext`, all calling
`dustfeather/shared-workflows@v4`:

- `pr-checks.yml` — `node-test.yml` + `claude-code-review.yml`
- `release.yml` — version bump → inject into manifest → build → tag → zip →
  GitHub Release → `publish-chrome.yml`. **Chrome only**: drop the `.xpi`
  packaging and the AMO source-zip steps.
- `claude.yml`, `dependabot-auto-merge.yml`

### Release sequence

`publish-chrome.yml` can only *update* an existing Web Store item — it cannot
create one. The item ID does not exist until a human has uploaded a build
through the Developer Dashboard once. So the rollout is not continuous; it has
a hard manual break in the middle.

1. **ARC runner scale set** — every sibling repo uses a per-repo runner
   (`arc-df-filelist-ext`). Provision `arc-df-chrome-group-discard` in k3s
   before any workflow can run.
2. Scaffold repo, source, tests. `pr-checks.yml` green.
3. `release.yml` runs with the `publish-chrome` job **disabled** — builds,
   tags, zips, cuts a GitHub Release. Produces the first publishable
   `group-snooze-chrome-vX.Y.Z.zip` artifact.

---

#### ⏸️ PAUSE — manual, cannot be automated

Everything below step 3 blocks here until a human does this. Do not enable the
publish job before it is done; the job will fail with an item-not-found error.

- [ ] Download the Chrome zip from the GitHub Release of step 3.
- [ ] Chrome Web Store Developer Dashboard → **New item** → upload that zip.
      (One-time $5 developer registration if this account has never published.)
- [ ] Fill the listing: description, category, screenshots, icon.
- [ ] **Privacy tab** — this extension needs a real disclosure, not a
      boilerplate one. It requests `<all_urls>` and reads form input.
      Declare: optional host access, used solely to capture media position and
      filtered form values immediately before a tab is discarded and replay
      them on restore; stored locally in `chrome.storage.local`; never
      transmitted; password / hidden / `cc-*` / `one-time-code` fields
      excluded. Link a hosted privacy policy (siblings serve one from
      `docs/privacy.html` via GitHub Pages).
- [ ] Submit for review, or save as draft — either way the item now exists.
- [ ] Copy the **item ID** (32-char string in the dashboard URL).
- [ ] Confirm the CWS API secrets the shared workflow expects are set
      (`CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN`, or
      whatever `publish-chrome.yml@v4` names them) at org level, plus the item
      ID wired in as repo variable/secret.

Note: first review of an extension requesting `<all_urls>` and touching form
input is slower than a routine update, and is the most likely thing to bounce.

---

4. Enable the `publish-chrome` job in `release.yml`. From here every push to
   `main` bumps, builds, releases and publishes automatically.

## 8. Manifest permissions (draft)

```
permissions:              tabs, tabGroups, scripting, storage, contextMenus
optional_host_permissions: <all_urls>
```

## 9. Known accepted tradeoffs

- Immediate discard + global-ON: every incidental collapse costs a full group
  reload of every tab.
- Audio dies on collapse.
- Untitled groups are inert.
- A group renamed while the browser is closed loses its exclusion (rename
  while running is handled).
- Snapshot capture silently no-ops on unresponsive pages, `chrome://` pages,
  the Web Store, and PDFs.

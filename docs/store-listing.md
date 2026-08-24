# Chrome Web Store — privacy practices tab

Copy-paste text for the "Single purpose" and per-permission justification
fields. Kept in the repo so the wording matches what the code actually does.

## Single purpose description

Group Snooze has one purpose: free memory by discarding the tabs in a Chrome tab
group when the user collapses that group, and restore each tab's playback
position and form input when the group is expanded again.

Collapsing a tab group is the user's explicit "pause this work" gesture. Group
Snooze treats it as the trigger to call `chrome.tabs.discard()` on every tab in
that group, so the tabs keep their place in the tab strip but stop consuming
memory. Immediately before each discard it takes a one-shot snapshot of that
tab's `<video>`/`<audio>` position and form field values, and re-applies that
snapshot after the tab reloads — the state Chrome's own discard restore drops.

Everything the extension does serves that one flow: detect collapse/expand,
discard, snapshot, restore. There is no second feature, no persistent content
script, no browsing history collection, and no network communication of any
kind.

## Permission justifications

### `tabs`

Needed to enumerate and discard the tabs that belong to a collapsed group.

- `chrome.tabs.query({ groupId })` — list the tabs in the group the user just
  collapsed. This is the only way to know which tabs to discard.
- `chrome.tabs.discard(tabId)` — the actual memory-freeing action, and the
  extension's entire reason to exist.
- `chrome.tabs.onUpdated` — detect when a discarded tab has finished reloading,
  which is the only moment a snapshot can be re-applied.
- `chrome.tabs.get` / `chrome.tabs.onActivated` — read the active tab's group so
  the right-click menu item can show the correct per-group auto-pause state
  (Chrome has no `contextMenus.onShown` event to do this lazily).
- `chrome.tabs.onRemoved` — drop the stored snapshot for a tab the user closed.

Tab URLs are read only to verify that a reloaded tab is still the same page
before re-applying its snapshot. No URL, title or browsing history is stored,
transmitted or used for any other purpose.

### `tabGroups`

The extension is triggered by, and keyed on, tab groups.

- `chrome.tabGroups.onUpdated` — the collapse/expand event. This is the user
  gesture that starts a snooze; without it the extension has no trigger.
- `chrome.tabGroups.query` / `chrome.tabGroups.get` — read a group's title and
  color, which together form the stable key under which per-group settings and
  snapshots are stored. Group ids are unique only within a browser session, so
  title+color is what survives a restart.
- `chrome.tabGroups.onRemoved` — delete the stored record when the user deletes
  a group, so nothing is kept for groups that no longer exist.
- `chrome.tabGroups.update` — collapse a group when the user picks "Pause this
  group" from the right-click menu.

### `scripting`

Used to run exactly two short, bundled functions in a page — never a persistent
content script.

- Capture: injected once, in the moment immediately before
  `chrome.tabs.discard()`, to read the `currentTime`/paused state of `<video>`
  and `<audio>` elements and the values of form fields. This has to be an
  injection at that instant because `beforeunload`, `pagehide` and `unload` do
  not fire on discard — there is no other capture window.
- Restore: injected once, after the discarded tab has reloaded, to write those
  same values back.

Both functions are part of the extension package; no remote or dynamically
fetched code is executed. Injection only happens when the user has separately
granted the optional host permission, and never on `chrome://`, Chrome Web Store
or other restricted URLs.

### `storage`

`chrome.storage.local` holds the small amount of state the feature needs between
service-worker restarts and browser restarts:

- the per-group auto-pause opt-out flag, keyed on group title + color;
- the pending snapshot for a discarded tab (media positions and form values),
  which is deleted as soon as it is restored or the tab is closed.

Everything stays in `storage.local` on the user's own machine. Nothing is
written to `storage.sync`, and nothing is ever sent off the device — the
extension makes no network requests at all.

### `contextMenus`

Provides the extension's only user interface inside the browser. Right-clicking
a page adds two items:

- "Pause this group" — snooze the current tab's group on demand, without waiting
  for a collapse.
- "Auto-pause this group" — a checkbox to opt the current group out of automatic
  snoozing on collapse.

There is no other surface for these controls: the extension has no popup, and
Chrome does not let an extension add items to the tab group's own context menu.

### Optional host permission `<all_urls>`

Requested only from the options page, on an explicit button press, and revocable
from the same page. It is **not** requested at install time and the extension is
fully functional without it — it simply discards without snapshotting.

Host access is required because the capture and restore functions must run in
the page itself to read and write media positions and form values, and the user
can group tabs from any site, so no fixed list of hosts can be declared in
advance. The access is used only for those two one-shot injections at discard
and restore time. Page content is never read for any other purpose, and
passwords, hidden fields, `autocomplete="cc-*"` payment fields and
`one-time-code` fields are explicitly excluded from capture.

## Data use disclosures

- Does not collect or transmit any user data. No analytics, no telemetry, no
  remote endpoints — the extension makes zero network requests.
- No remote code: all executed code, including the injected capture/restore
  functions, ships inside the package.

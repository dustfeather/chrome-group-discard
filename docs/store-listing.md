# Chrome Web Store — privacy practices tab

Copy-paste text for the "Single purpose" and per-permission justification
fields. Each block is written for a human reviewer and kept under the 1000
character field limit. Kept in the repo so the wording matches what the code
actually does.

## Single purpose description

Group Snooze does one thing. When you collapse a Chrome tab group, it puts every
tab in that group to sleep so the memory they were using is released. When you
open the group again, each tab comes back the way you left it: video and audio
resume at the second you stopped, and text you had typed into a form is still
there. Collapsing a group is already how people say "I am done with this for
now", so that gesture is the signal to free the memory. Chrome's own tab
discarding keeps the scroll position but loses playback position and typed
input, and closing that gap is the extension's only feature. There is no second
purpose: no browsing history collection, no analytics, and no network requests of
any kind.

## tabs

This permission does the actual work. The extension needs it to find the tabs
inside the group you just collapsed and to put them to sleep; without it there is
no way to ask Chrome which tabs belong to a group, and no way to discard them, so
the extension would have nothing to do. It also needs it to notice when a
sleeping tab has woken and finished reloading, which is the only moment the saved
playback position and form text can be put back. Two smaller uses: reading which
tab is in front, so the right-click menu shows the correct on/off state for that
tab's group, and noticing when a tab is closed, so the saved state for it can be
thrown away. A tab's address is read only to confirm a reloaded tab is still the
same page before anything is restored into it. No addresses, titles or history
are stored, sent anywhere, or used for anything else.

## tabGroups

Tab groups are what the whole extension reacts to. This permission provides the
collapse and expand event, which is the gesture that starts and ends a snooze; it
is the trigger, and nothing happens without it. It is also used to read a group's
name and colour. That pairing is how settings are filed: Chrome discards its
internal group IDs when the browser restarts, so name plus colour is the only
identifier that survives, and it is what per-group preferences and saved tab
state are stored under. When you delete a group, the extension is notified and
deletes the stored record, so nothing is kept for groups that no longer exist.
Finally, when you choose "Pause this group" from the right-click menu, this
permission is what lets the extension collapse the group for you.

## scripting

Restoring where a video was and what you had typed can only be done from inside
the page, and this permission lets the extension run a small piece of its own
code there. It is used exactly twice per tab, never as an always-on content
script. The first run happens in the instant before the tab is put to sleep, and
reads two things: the playback position of any video or audio element, and the
current values of form fields. That timing is forced by Chrome, because the usual
page-is-closing events do not fire when a tab is discarded, so this is the only
chance to record anything. The second run happens after you reopen the group and
the tab has reloaded, and writes those values back. Both pieces of code ship
inside the extension package; nothing is fetched from a server or built at
runtime. Neither run happens unless you have separately turned on page access
from the options page.

## storage

This holds the few small values the feature has to remember from one moment to
the next. Chrome shuts the extension's background code down whenever it is idle,
so anything needed later must be written down first. Two things are stored: your
per-group preference for whether that group should sleep automatically, and the
temporary record of a sleeping tab's playback position and form contents. The
second is deleted as soon as it has been restored, or as soon as you close the
tab. Everything stays in local storage on your own computer. Nothing is written
to Chrome's sync storage, so none of it travels to your other devices or to a
Google account, and the extension makes no network requests at all, so nothing
leaves the machine.

## contextMenus

The right-click menu is the extension's only interface inside the browser window.
It adds two items. "Pause this group" puts the current tab's group to sleep
straight away, for when you want the memory back without collapsing the group
first. "Auto-pause this group" is a checkbox that exempts a particular group from
sleeping automatically, for a group you want left running. There is nowhere else
these controls could live: the extension deliberately has no toolbar popup, and
Chrome does not allow extensions to add items to a tab group's own right-click
menu, which is where they would otherwise belong.

## Host permission (all sites, optional)

This is not requested at install time. It is asked for only if you press the
button for it on the options page, and it can be withdrawn from the same page at
any time. The extension works without it and simply skips saving and restoring,
behaving as a plain tab sleeper. It is needed because the code that reads a
video's position and a form's contents has to run inside the page itself, and
people group tabs from any site they like, so no fixed list of sites can be
declared in advance. The access is used solely for the two brief moments
described above: once just before a tab sleeps, once just after it wakes. Page
content is never read for any other reason, and passwords, hidden fields,
credit-card fields and one-time-code fields are deliberately excluded from what
is saved.

## Data use disclosures

- Does not collect or transmit any user data. No analytics, no telemetry, no
  remote endpoints — the extension makes zero network requests.
- No remote code: all executed code, including the injected capture and restore
  functions, ships inside the package.

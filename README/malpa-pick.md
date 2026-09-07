# Malpa Pick

**A TamperMonkey userscript that replaces Canary7's picking screens with a scanner-first UI for Zebra TC51 handhelds.**

| | |
|---|---|
| Current version | **4.10.1** |
| File | `malpa-pick.user.js` (~4,650 lines, one file, pure ASCII) |
| Runs on | `https://*.canary7.com/*` — Firefox on Android (TC51), also works on desktop |
| Talks to | Canary7 WMS REST API at `stgauth.canary7.com` |
| Source of truth | GitHub: `zaynnev/malpa3pl` → `main` → `malpa-pick.user.js` |
| Auto-update | Yes — `@updateURL` points at the raw GitHub file. TamperMonkey polls it. |

---

## TL;DR — what it does

1. Injects a **"Malpa Pick"** item into C7's left sidebar.
2. Tapping it opens a new C7 tab with our own UI (C7's tabs keep working alongside it).
3. Picker selects a **profile** → C7 assigns them a **job** → they see a **summary** → tap **Accept**.
4. For every instruction: **hear/see the location** → **scan the item** → (enter qty if >1) → **scan the tote** → next instruction.
5. Special flows: **SIBP/MIBP** (grouped picks), **Cluster** (multiple totes by position), **LOCOD** (no tote scan, container auto-generated), **Short Pick** (check-digit scan → reason → API call).
6. Everything speaks aloud, chimes, vibrates, and recovers scanner focus after the device sleeps.

If you only read one thing: **the script is a state machine keyed on `State.screen`, and every barcode goes through `_onScan()` which routes based on that screen.**

---

## Install / update

**First install on a TC51:**
1. Install TamperMonkey in Firefox.
2. Open the raw GitHub URL in Firefox → TamperMonkey prompts to install.
3. Log into Canary7. "Malpa Pick" appears at the top of the sidebar.

**Ship a change:**
1. Edit `malpa-pick.user.js`.
2. Bump `// @version` in the header (line 4). **TamperMonkey only updates if the version number increases.**
3. Also bump `VERSION` in `window.__malpaPick` (~line 4603) — it's currently `'4.10.0'` and out of sync with the header; keep both the same going forward.
4. Push to `main`. Devices pick it up on their next update check (or tap TamperMonkey → "Check for updates").

**Keep the file pure ASCII.** No em-dashes, curly quotes, or emoji in source. Copy/paste on the TC51 mangles anything else. Use JS escapes for emoji (e.g. `'\uD83D\uDD0A'` for the speaker icon).

---

## File map (by line, v4.10.1)

The file is one big IIFE. Sections are marked with `// ----` comment banners. `Ctrl+F` the banner text.

| Lines | Banner | What lives here |
|---|---|---|
| 1–15 | header | TamperMonkey metadata. `@version`, `@updateURL`. |
| 17–1060 | `0. CONSTANTS` | `API_BASE`, `WAREHOUSE_ID`, and a ~1,000-line base64 MP3 (`_ERROR_B64`, currently unused). |
| 1061–1249 | `1. AUTH + API LAYER` | `getToken`, `captureSessionId`, `apiGet`, `apiPost`, `unassignJob`, resume-state save/load, session-expired banner. |
| 1250–1294 | `2. STATE STORE` | The `State` object and the `R` DOM-refs bag. **Read this first.** |
| 1295–2232 | `3. CSS INJECTION` | One `<style>` block. All classes prefixed `mpk-`. |
| 2233–2281 | `4. NAV INJECTION` | Puts the sidebar button in; kicks off background data prefetch. |
| 2282–2476 | `5. SHELL / TAB BUILD` | `measureHeight`, **tab co-existence** logic, `buildShell`. |
| 2477–2973 | `FRAGMENT 2` | Profile select, job number entry, job summary, `onAcceptJob`. |
| 2974–3314 | `FRAGMENT 3` | `Voice`, `Audio`, `renderPickScreen`, `_onScan` router, `setScanFeedback`. |
| 3315–3650 | `FRAGMENT 8` | Short pick (3 steps) + resume banner. |
| 3651–3728 | `FRAGMENT 5` | SIBP/MIBP: `loadGroupRecordIfNeeded`, `effectiveQty`, `displayQty`, `groupPerform`. |
| 3729–3764 | `FRAGMENT 6` | Cluster: multi-tote modal. |
| 3765–4448 | `FRAGMENT 4` | The core loop: `verifyItem`, `validateContainerLabel`, LOCOD flow, `performPick`, `onItemScan`, `renderContainerScan`, `onContainerScan`, qty numpad, job complete. |
| 4449–4480 | `FOCUS RECOVERY` | Keeps the hidden scanner input focused after sleep/notifications. |
| 4482–4576 | `6. CLOSE UI` / `7. KEYBOARD` | Teardown, Esc key. |
| 4578–4608 | `8. OPEN PICK` | Entry point + `window.__malpaPick` debug handle. |
| 4610–4648 | `9. BOOT` | Session pre-warm, sidebar injection retry, MutationObserver. |

The "Fragment" numbers are historical build order, not reading order. Don't reorder them — nothing depends on order, but line-number references in this README will drift.

---

## Core concepts

### `State` — the one object that matters

```js
State.screen           // which screen we're on — drives ALL routing
State.profile          // selected profile object (persists across jobs on purpose)
State.jobId
State.instruction      // the CURRENT instruction, fully expanded (has .fromLocation, .item, etc.)
State.groupRecord      // SIBP/MIBP only — holds the real pick qty in .units
State.containersByPosition  // cluster: { positionId: 'W999' }
State.scanCount        // how many units scanned so far on this instruction
State.pickProgress     // { current, total } for the progress bar
State.allInstructions  // cache of every instruction in the job (for next-instruction lookups)
State.containerPrefixes // ['W','R','O',...] valid tote prefixes
State.voiceEnabled     // persisted in sessionStorage 'mpk_voice'
State.reset()          // called on close + job complete. Does NOT clear profile or voiceEnabled.
```

### `State.screen` values

```
PROFILE_SELECT → JOB_NUM_ENTRY (method=2 only) → JOB_SUMMARY → PICK_ITEM
PICK_ITEM → QTY_MODAL (qty>1) → TRANSITIONING → SCAN_CONTAINER → PICK_ITEM (next) …→ JOB_COMPLETE
PICK_ITEM → SHORT_PICK_LOCATION → SHORT_PICK_REASON → TRANSITIONING → PICK_ITEM
NO_JOBS (queue empty)
```

`TRANSITIONING` is a 300–500ms lock so a double-fired scan can't leak into the next screen. Don't remove it.

### `R` — DOM references

Populated by each `render*()` function. `R.scanIn` is the hidden scanner input. `R.scanFb` is the feedback line. Also holds C7 tab refs (`R._tabBar`, `R._tabContent`, `R._prevActiveLi`, `R._tabObs`). Wiped to `{}` on close.

### The scan router

```js
function _onScan(barcode) {
  if (State.screen === 'TRANSITIONING') return;
  if (State.screen === 'PICK_ITEM')      onItemScan(barcode);
  if (State.screen === 'SCAN_CONTAINER') onContainerScan(barcode);
  if (State.screen === 'QTY_MODAL')      onQtyModalScan(barcode);
}
```

The scanner types into a 1×1px invisible `<input id="mpk-scan-in">` and presses Enter. `_onScanKeydown` catches Enter, runs `_normaliseScan()` (fixes `R$%^` → `R456` when Android has Shift stuck), then calls `_onScan`. Short pick uses a separate input `#mpk-sp-scan-in` with its own handler.

### Two quantity functions — don't mix them up

| Function | Returns | Use it for |
|---|---|---|
| `displayQty(instr)` | `quantity ÷ itemUnitOfMeasure.factor` | Anything the picker sees or hears |
| `effectiveQty(instr)` | raw `quantity` | `picking_qty` in API bodies |

Example: 18 eaches with factor 6 → screen says "3 Cartons", API receives `18`. For SIBP/MIBP both return `groupRecord.units`.

---

## The pick loop, end to end

```
onAcceptJob()
  └─ builds barcodeMap + containerPrefixes, loads group record if SIBP
  └─ renderPickScreen(instruction)
       └─ Voice.announceInstruction() fires 150ms later (AFTER render, never before)

scan item ─▶ onItemScan()
  ├─ verifyItem() fails → "Wrong item" (no API call)
  ├─ qty == 1  → fireItemVerification() [fire-and-forget]
  │              LOCOD?  → performLocodPick()        (no tote screen)
  │              else    → "Scan tote" → renderContainerScan()
  └─ qty > 1   → renderQtyModal()  (numpad + keep scanning; capped at required qty)

scan tote ─▶ onContainerScan()
  ├─ validateContainerLabel() fails → "Wrong tote" (no API call)
  ├─ cluster + tote already used elsewhere → showMultiToteModal()
  ├─ performPick() or groupPerform()   [retries once after 800ms on non-401 error]
  ├─ changeSequence()  [fire-and-forget, NOT on the final pick]
  ├─ savePickResumeState()
  └─ job_instruction === null ? renderJobComplete() : fetchNextInstruction() → renderPickScreen()
```

`fetchNextInstruction()` checks `State.allInstructions` first (no API call) because the `perform` response only returns a minimal stub with no `fromLocation` or `item`.

---

## API calls (all GET/POST to `API_BASE + path`)

`API_BASE` already ends in `?r=`, so **every param uses `&`, never `?`**. Headers: `Authorization: Bearer`, `x-warehouse-id: 10`, `x-session-id` (stolen from C7's own XHR at boot).

| Purpose | Path | Notes |
|---|---|---|
| Profiles | `shipment/shipment-picking-profile&expand=&per-page=100` | cached |
| Container types | `configuration/container-type&expand=&per-page=100` | cached → `containerPrefixes` |
| Reasons | `configuration/reason&expand=reasonClass&per-page=100` | short-pick reasons = `reason_class_id === 5` |
| First instruction | `shipment/shipment-picking-profile/get-job-instructions&id={profile}&expand=…` | **assigns the job to the user** as a side effect. Method=2 adds `&job_num=` with `##` encoded as `%23%23`. |
| All instructions | `job/job-instruction&job_id={id}&per-page=200` | fills `allInstructions` |
| Group record | `…/get-job-instruction-groups&id={groupId}` | SIBP/MIBP; need `.units` and `.updated_at` |
| Perform | `POST job/job-instruction/perform&id={instrId}` | see `performPick()` for body |
| Group perform | `POST job/job-instruction/group-perform&id={groupId}` | adds `group_id`, `last_updated_at` |
| Short pick | `POST job/job-instruction/pick-short&id={instrId}` | see gotchas below |
| Change sequence | `…/change-sequence&id={instrId}` | after every pick except the last |
| Unassign | `job/job/unassign-job&job_id={id}` | only when backing out before Accept |
| Item verification log | `configuration/item/process-log-item-verification&item_code=…&item_code_use=Yes|No` | fire-and-forget |
| LOCOD: existing container | `shipment/shipment-container/get-picking-container&shipmentNumber=…` | |
| LOCOD: new container | `shipment/shipment-container/auto-generate-container-number` | |
| LOCOD: label | `…/print-consignment-piece-label&job_instruction_id=…&item_id=…` | fire-and-forget |

---

## Gotchas that have bitten us (read before changing API bodies)

- **Short pick `container_no` must be `""`.** If you send a tote number C7 treats it as a successful pick and moves the shipment to pack-pending.
- **Short pick `picking_qty` is the full `instruction.quantity`, not 0.** C7 uses the endpoint, not the qty, to know it's a short.
- **Short pick `reason_code` is the string label** (`"Stock Not Present"`), not the numeric ID. Empty string if no reasons configured.
- **LOCOD perform needs `container_type_id: 38` and `selected_profile_id: 54`** or it 500s. LOCOD is hardcoded to profile ID 54.
- **`change-sequence` must not be called after the final instruction.**
- **Never call `Voice.cancel()` inside `renderPickScreen`** and never announce before render. Speech is async; the render's DOM work cancels it. Announce via `setTimeout(..., 150)` after render.
- **`verifyItem` only accepts barcodes from the instruction's own UoM.** Scanning an Each barcode when picking Cartons is rejected by design. Falls back to `item_code` only if that UoM has no references.
- **Don't hide other C7 tab panes with `style.display` unless we are the active tab, and restore them the moment we're not.** Angular only toggles `.active`; an inline `display:none` permanently kills the pane. See "TAB CO-EXISTENCE" comment block ~line 2300.
- **Job is NOT unassigned if the picker closes mid-pick.** State is saved to `sessionStorage['mpk_resume']` (8h TTL) and a Resume banner appears next open.
- **`get-job-instructions` with no `job_id` assigns a job immediately.** Don't call it casually.

---

## Voice & audio

- `Voice.speak(text)` — respects the 🔊/🔇 toggle. Rate is `utt.rate` in `Voice.speak` (~line 3015, currently `1.8`).
- `Voice.error(text)` — **ignores the toggle**. Used for "Wrong item", "Wrong tote", "Wrong check digit", "Error, try again".
- `Voice.announceInstruction(instr, prevInstr)` — says `"Go to A 11, B 8, S 11. Pick 3 Cartons Widget"`. Location segments matching the previous instruction are dropped (`A12-B24-S12` → `A12-B26-S11` says only "B 26, S 11"). Item text is `abc_category`, falling back to `description`.
- `Audio.chime(type)` — `item_done`, `container_ok`, `error` are all Web Audio tones. `error_donkey` is a placeholder.
- Vibration: `[30]` success, `[60,30,60]` error.

---

## Common edits — where to go

| I want to… | Edit |
|---|---|
| Change voice speed | `utt.rate` in `Voice.speak` (~3015) and `Voice.error` (~3051) |
| Change what's spoken per pick | `Voice.announceInstruction` (~3020) |
| Change what's shown on the pick screen | `renderPickScreen` HTML template (~3144) |
| Change the tote scan screen | `renderContainerScan` (~4066) |
| Add/change a field in the perform body | `performPick` (~3998), `groupPerform` (~3707), `performLocodPick` (~3910) |
| Change short pick body | `performShortPick` (~3320) — re-read the gotchas first |
| Add a profile-specific flow | Copy the `isLocod()` pattern (~3874); branch in `onItemScan`, numpad confirm, and `onQtyModalScan` |
| Change colours/spacing | `injectCSS` (~1299). Every class is `mpk-*`. |
| Change the profile colour dots | `profileColour` map (~2785) |
| Change how barcodes are validated | `verifyItem` (~3771), `validateContainerLabel` (~3826) |
| Change the summary screen rows | `renderJobSummary` (~2810) |
| Change scanner shift-key fix | `_SHIFT_NUMS` / `_normaliseScan` (~3259) |
| Point at production C7 | `API_BASE` (line 21) + `@match` in header |

**Every `render*()` function rebuilds `root.innerHTML` from scratch and re-attaches listeners.** There's no diffing. If you add a button, add its listener in the same function right after the template.

---

## Debugging on a device

Open Firefox devtools (or `about:debugging` remote) and use the handle the script exposes:

```js
__malpaPick.State           // inspect current state
__malpaPick.State.screen    // what screen do we think we're on?
__malpaPick.R               // DOM refs
__malpaPick.openPick()      // open / bring tab forward
__malpaPick.closeUI()
__malpaPick.hasToken()      // false → C7 auth not captured
__malpaPick.showOurs() / hideOurs() / syncTabs()   // tab co-existence
```

All console output is prefixed `[MalpaPick]`.

**Scanner "not working"** → almost always focus. Check `document.activeElement.id` — should be `mpk-scan-in` (or `mpk-sp-scan-in` on the short-pick screen). Focus recovery runs on `visibilitychange`, `window focus`, and a 2.5s poll.

**"Session expired" banner** → 401 from C7. Picker needs to re-login to C7; the script can't refresh the token.

**Voice not speaking** → check the toggle (🔇 = off), then confirm `Audio.init()` has run (needs a user tap — happens on Accept Job).

---

## Testing a change before pushing

There's no automated test suite. Minimum manual pass on a TC51 or desktop Firefox against staging:

1. Open tab, close tab — other C7 tabs still clickable afterwards.
2. Wholesale profile (method=2): enter shipment number, pick one qty=1 item and one qty>1 item, complete job.
3. SIBP profile: confirm the displayed qty matches `groupRecord.units`, not `1`.
4. Cluster profile: tote reuse across positions triggers the multi-tote modal; position strip visible on both pick and tote screens.
5. Short pick with a tote already assigned to that position → shipment must NOT go to pack-pending.
6. LOCOD: no tote screen appears, pick completes.
7. Sleep the device mid-pick, wake it, scan — must still register.
8. Syntax check before pushing: `node -e "new Function(require('fs').readFileSync('malpa-pick.user.js','utf8').replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\n/,''))"`

---

## Known gaps / not built

- Damage reporting — button removed from UI; needs a C7 HAR of the damage endpoint.
- `_DONKEY_B64` / `_ERROR_B64` — embedded MP3s are unused; `error` chime is a synthesized buzz.
- Script targets `stgauth.canary7.com`. Production cutover = change `API_BASE` + `@match`.
- `window.__malpaPick.VERSION` lags the header (`4.10.0` vs `4.10.1`).

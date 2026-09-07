# Malpa Receiving

**A TamperMonkey userscript that replaces Canary7's receiving screen with a scanner-first, single-page UI for Zebra TC51 handhelds.**

| | |
|---|---|
| Current version | **2.4.3** |
| File | `malpa-receiving.user.js` (~2,400 lines, one file, pure ASCII) |
| Runs on | `https://*.canary7.com/*` — Firefox on Android (TC51), also works on desktop |
| Talks to | Canary7 WMS REST API at `stgauth.canary7.com` (+ the `/inbound/` service) |
| Source of truth | GitHub: `zaynnev/malpa3pl` → `main` → `malpa-receiving.user.js` |
| Auto-update | Yes — `@updateURL` points at the raw GitHub file. TamperMonkey polls it. |
| Sibling script | `malpa-pick.user.js` — same house pattern, read `README/malpa-pick.md` too |

---

## TL;DR — what it does

1. Injects a **"Malpa Receiving"** item into C7's left sidebar.
2. Tapping it opens a new C7 tab with our own UI (C7's own tabs keep working alongside it).
3. Operator scans a **receipt number** → the script fetches the receipt **once** and caches every detail line.
4. Per item: **scan item barcode** → UoM auto-selected from the scanned reference → **type quantity** → (batch + expiry if the item is batch-tracked) → **check digit** on the suggested location, or **scan/type a location** if C7 suggested none.
5. **Check In** posts the receive, then **re-fetches the receipt from C7** so lines-completed / units-open are live for every operator on the same receipt.
6. A **History** button opens a scrollable table of everything already booked against this receipt — user, item, location, quantity, time.

If you only read one thing: **the script is a single-screen progressive form driven by `State.stage`, every render rebuilds the DOM from scratch, and the one primary button always performs whatever the current stage is.**

---

## Non-negotiables (these are why the script exists)

These were deliberate product decisions. Don't "simplify" them away.

- **Receipt items are fetched once**, at receipt declaration, and cached in `State.details`. C7's own screen re-fetches per scan; that is the thing we were fixing.
- **Always** post `label_quantity: 0` and `no_of_pieces: 0`.
- **Always** use the **Putaway** receiving profile (`PUTAWAY_PROCESS_ID = 3`). The operator never picks a profile.
- **The whole screen must fit with no scrolling** on a TC51. Any new field has to earn its vertical space, or collapse into an existing row.
- **No custom keyboard.** We use C7's / Android's native one. (An earlier build had one; it was removed.)
- **No screen reader / speech.** Removed in 2.4.0 — the mute button didn't work and nobody used it. The History panel replaced it.
- **Over-receiving keeps C7's type-`OVER` confirmation.** Don't turn it into a plain Yes/No.

---

## Install / update

**First install on a TC51:**
1. Install TamperMonkey in Firefox.
2. Open the raw GitHub URL in Firefox → TamperMonkey prompts to install.
3. Log into Canary7. "Malpa Receiving" appears in the sidebar.

**Ship a change:**
1. Edit `malpa-receiving.user.js`.
2. Bump `// @version` in the header. **TamperMonkey only updates if the version number increases.**
3. `node --check malpa-receiving.user.js`, then run the offline harnesses (see Testing).
4. Push to `main`. Devices pick it up on their next update check, or TamperMonkey → "Check for updates".

Or use the **`release-userscript`** skill, which does the bump / test / push / verify loop and confirms the raw URL is serving the new version.

**Keep the file pure ASCII.** No em-dashes, curly quotes or emoji in source — copy/paste onto the TC51 mangles anything else. Use JS escapes if you need a symbol.

---

## File map

One big IIFE, `'use strict'`, sixteen numbered `// ----` comment banners. `Ctrl+F` the banner text — line numbers drift, banner names don't.

| Banner | What lives here |
|---|---|
| `0. CONSTANTS` | `API_BASE`, `WMS_BASE`, `WAREHOUSE_ID`, page sizes, `PUTAWAY_PROCESS_ID`, `STORAGE_CLASS_ID`, `NO_LOCATION_TOKENS`, `DETAIL_KEYS`. **Start here.** |
| `1. AUTH + API LAYER` | `getToken`, session-id capture, `apiGet`, `apiPost`, error normalisation, the session-expired banner. |
| `2. STATE STORE` | The `State` object, `resetReceipt()`, `resetLine()`, and the `R = {}` DOM-refs bag. **Read this second.** |
| `3. CSS INJECTION` | One `<style>` block. Every class is `mrc-*`. Mirrors C7's own form tokens. |
| `4. NAV INJECTION` | Sidebar button + background prefetch. |
| `5. SHELL / TAB BUILD` | Height measurement, **C7 tab co-existence**, shell construction. |
| `6. RECEIPT LOOKUP` | Scan/declare a receipt, `fetchReceiptHeader`, cache the details. |
| `7. ITEM RESOLUTION` | Barcode → item + UoM, `openDetailForItem`, `itemIsComplete`. |
| `8. QUANTITY` | Entry, scan-to-count, **UoM factor divisibility check**. |
| `9. BATCH / EXPIRY` | Batch number + expiry date, stage-aware primary button. |
| `10. LOCATION` | Suggested location, `'NEW'` handling, Keep Location, check digit. |
| `11. CHECK-IN (WRITE)` | `doCheckin`, `sanitizeDetail`, the re-entrancy latch, the conditional retry. |
| `12. REFRESH` | `refreshReceipt` — re-pulls the header after every write. |
| `13. HISTORY` | `fetchReceiptLog`, `fetchUserNames`, `userName`, `_fmtWhen`, `renderHistoryOnly`. |
| `14. RENDER` | `render()` — rebuilds the form, re-attaches every listener, applies focus and lock state. |
| `15. FOCUS / KEYBOARD` | `focusIsOurs`, the `#mrc-catch` scan catcher, `visualViewport` keyboard sizing. |
| `16. BOOT` | Sidebar injection retry, MutationObserver, session pre-warm. |

---

## Core concepts

### The three host bases — and the trap

Canary7 runs **several services on one host**. Getting the base wrong is the single most common way to break this script.

```js
const API_BASE = 'https://stgauth.canary7.com/index.php?r=';   // legacy monolith
const WMS_BASE = 'https://malpa.canary7.com/inbound/api/wms/v1/';
```

- `API_BASE` already ends in `?r=`, so **every param uses `&`, never `?`**.
- `malpa.canary7.com` is a **static S3/CloudFront Angular app**. It serves the UI and it does proxy `/inbound/`, but it will **401/403 any other API path**. If you point a read at `https://malpa.canary7.com/logging/...` or `.../index.php?r=...` you get "not authorised" even though the user is perfectly authorised. That exact mistake cost us a debugging round on the History panel.
- Everything that isn't `/inbound/` goes on **`stgauth.canary7.com`**.
- When in doubt, **use the `malpa-canary7` MCP to confirm the route. Do not guess the host.**

### `State` — the one object that matters

```js
State.stage        // drives ALL routing and the primary button's action
State.receiptNum
State.receiptId
State.header       // the receipt header as C7 returned it
State.details      // CACHED copy of header.receiptDetails - the whole point of the script
State.detail       // the detail line we're currently receiving against
State.item
State.uom          // { id, code, factor } chosen from the scanned reference
State.qty          // what the operator typed, in UoM units (NOT base units)
State.batch, State.expiry
State.location, State.keepLocation
State.err          // banner text; must be cleared, it used to go sticky
State.resetReceipt()   // back to the receipt prompt
State.resetLine()      // keep the receipt, clear the line (used after a successful check-in)
```

### `State.stage` values

```
receipt -> item -> qty -> [batch] -> wait -> location -> checkdigit -> (check in) -> item
```

- `wait` is a short lock while the suggested location is being fetched, so a fast double-scan can't leak into the next stage.
- `location` is only entered when C7 suggested nothing usable; otherwise we go straight to `checkdigit`.
- **The primary button always performs the current stage.** There is one button, its label changes. If you add a stage you must add its case to the button handler *and* to `render()`.
- After a successful check-in: `resetLine()`, re-focus the item field, stay on the receipt. If the receipt is now closed, show that and drop back to `receipt`.

### `R` — DOM references

Populated by `render()`. `R` is wiped to `{}` on close. Also holds the C7 tab refs used by the co-existence logic.

### The render model

**`render()` rebuilds the form's `innerHTML` from scratch and re-attaches every listener.** There is no diffing. If you add a control, wire its listener in the same function immediately after the template. Completed stages collapse to a single summary line — that's how the whole flow fits on one screen.

`renderHistoryOnly()` exists because a full `render()` during an async history fetch **wiped whatever the operator was typing**. Use it for any async UI update that isn't a stage change.

---

## Quantity semantics — read this before touching any body

This is the most load-bearing rule in the script and it is counter-intuitive.

> **`quantity` on check-in is in BASE units. `item_unit_of_measure_id` merely names the UoM.**

A 100-each line received as **10 cartons** with **factor 6** posts `quantity: 60`. `open_quantity` goes 100 → 40.

Consequences:

- The operator types **UoM units**; the script multiplies by `factor` before posting.
- **A quantity that doesn't divide evenly by the factor is an error.** Factor 6 and the operator types 13 → reject, don't round. This check is in the `8. QUANTITY` section.
- `total` in the check-in **response** is the **receipt-wide** remaining open quantity, not the line's. Don't display it as a line figure.

---

## The receive loop, end to end

```
scan receipt -> fetchReceiptHeader()
  |- 404 code 1016 "No Open Receipt" -> receipt has nothing left to check in (see Gotchas)
  |- cache header.receiptDetails into State.details
  |- render() stage='item', focus the item field

scan item -> resolve barcode to item + UoM
  |- openDetailForItem(itemId)  // first line with open qty, ELSE the last line
  |- no line at all -> "not on this receipt"
  |- stage='qty'

type qty -> validate against factor
  |- qty > open qty -> require the operator to type OVER
  |- batch-tracked item? stage='batch' (batch number + expiry) else stage='wait'

stage='wait' -> fetch suggested location (per-page=200)
  |- suggestion is 'NEW' / blank / 'n/a' -> suggest NOTHING, blank field + red
  |                                         "no existing location" note, stage='location'
  |- Keep Location ticked -> override with the last location used
  |- otherwise stage='checkdigit'

Check In -> doCheckin()
  |- _writeInFlight latch (there is NO idempotency key on this endpoint)
  |- sanitizeDetail(detail) -> exactly the DETAIL_KEYS whitelist
  |- refreshReceipt()   // live counters for every operator on this receipt
  |- resetLine(), focus item field; receipt closed? -> resetReceipt()
  |- finally { _writeInFlight = false; render() }   // single exit, always unlocks
```

---

## The write path — invariants you must not break

Check-in has **no idempotency key**. A blind retry books stock twice. Both of the following were real bugs, found in review, introduced by fixes of mine:

1. **`_writeInFlight` is the re-entrancy latch.** It is cleared in exactly one place: the `finally` in `doCheckin`. That `finally` also calls `render()`, with a backstop that force-enables every input if `render()` throws — otherwise a thrown render leaves the handheld bricked with every field disabled, including the scan catcher.

2. **Never retry these:**
   - `code === 'SESSION_EXPIRED'` → rethrow, show the banner.
   - anything with a `c7Code` → these are C7 **business rejections that arrive as HTTP 500 with a numeric `code`** (e.g. `1087` "Multiple Items not allowed in this location"). They are deterministic. Retrying is pointless and dangerous.
   - **an over-receive** (`qty > openBefore`) → mark it `indeterminate` and tell the operator it "may or may not have been recorded". The "did the first POST land?" test compares `open_quantity`, and **C7 floors `open_quantity` at 0**, so on an over-receive the test can never pass — a retry there is a guaranteed double write.

3. `DETAIL_KEYS` / `sanitizeDetail()` exist because C7 wants **exactly** its 25 detail keys in `receipt_detail`. Passing extra keys through, or dropping one, gets you a 403 or a 500 rather than a helpful validation message. If you need a new field, add it to `DETAIL_KEYS`.

---

## The History panel

Reads `receiving/receipt-container`, **not** the inventory log service. The logging service is on `stgauth` (not `malpa`) *and* is role-gated — 200 for admin, 403 for floor users — so it was useless for operators. `receipt-container` is receipt-scoped, same host and auth as everything else, no role gate found.

```
GET index.php?r=receiving/receipt-container
      &receipt_header_id=<id>
      &expand=item,batch,toLocation,containerType
      &per-page=200&page=1
```

- Paginates up to `LOG_MAX_PAGES`, de-duplicated on row `id`, sorted newest first.
- `created_at` is **unix seconds** → `_fmtWhen()` renders `dd/mm HH:MM`. It tolerates milliseconds too (`n > 1e12`).
- `created_by` is a **user id**. `expand=createdBy` is **silently ignored** by C7, so we join client-side: `fetchUserNames()` GETs `configuration/user&per-page=500&page=1` **once** and caches `{id: name}` in `sessionStorage.mrc_users`. `userName(id)` falls back to `'User ' + id`.
  - `configuration/user` **ignores `id=` and `fields=`** and returns all ~130KB regardless. That's why it's fetch-once-and-cache.
- `_logReq` is a generation counter. Every guard around it exists because of a real bug: a slow fetch from a previous line painting rows under the wrong receipt, or a superseded fetch rendering a false "Nothing booked". Keep the counter checks.

**Known residual:** a slow history fetch started on a previous line can briefly show pre-write rows. The panel is locked and visibly busy while that's true, but it can look stale for a moment.

---

## Gotchas that have bitten us

- **A fully-satisfied receipt cannot be loaded at all.** `get-by-num` answers `404` with `code 1016 "No Open Receipt"` once the receipt has nothing left to check in. No client can bypass that. We only fixed the *mixed* case — see next item.
- **Receiving past a completed line is allowed.** `openDetailForItem` returns the first line with open quantity, **and falls back to the last line** if every line is closed. C7's own screen hard-blocks this; we route it through the type-`OVER` confirmation instead. Don't reinstate the block.
- **Counters must be refreshed from C7, not decremented locally.** `refreshReceipt()` after every write. Two operators on one receipt is normal.
- **Location code for "no home" is literally the string `'NEW'`.** See `NO_LOCATION_TOKENS`.
- **Token hygiene, and the order matters:** strip surrounding quotes **first**, then a leading `Bearer `. Doing it the other way round sends `Bearer Bearer ey...`.
- **The session-expired banner is latched only when it actually paints.** `_paintSessionExpired` returns a boolean and `_showSessionExpired` stores it. A boot-time 401 used to set the latch before `#mrc-root` existed, so the next unrelated render displayed a stale "Session expired" over a perfectly good session.
- **Don't hide other C7 tab panes with `style.display` unless we are the active tab, and restore them the instant we're not.** Angular only toggles the `.active` class; an inline `display:none` permanently kills the pane. Also handle the **one-tab case** — Angular won't repaint when ours is the only other tab. See `restoreC7Panels` / `enforceTabVisibility` and the new-tab observer (400ms net).
- **Focus discipline:** the script must not hijack the keyboard. `focusIsOurs` gates every focus call, `#mrc-catch` is the invisible scan catcher, and `_kbDismissed` remembers that the operator deliberately closed the keyboard. Don't add a bare `.focus()`.
- **Android keyboard sizing uses `window.visualViewport`.** `innerHeight` frequently does not change when the keyboard opens.
- **Batch dates were a dead end once:** setting the expiry then tapping out left the form unable to advance. The primary button is stage-aware for exactly this reason.
- **Buttons live at the bottom of the form, not pinned to the footer** — footer buttons sat under the Android keyboard and made it impossible to tap out of a field.

---

## Common edits — where to go

| I want to... | Edit |
|---|---|
| Make the quantity input bigger | `.mrc-fc.qty` in `3. CSS INJECTION` (`font-size:38px; min-height:64px`) |
| Restyle the history table | `.mrc-hist table` / `th` / `td` |
| Change only the history **quantity** size | `.mrc-hist td.q` (`font-size:24px`, `line-height:1.1` so the row doesn't stretch) |
| Change the history panel height | `.mrc-hist { max-height:38vh }` |
| Add a field to the check-in body | `DETAIL_KEYS` + `doCheckin` — **re-read the write-path invariants first** |
| Change the divisibility rule | `8. QUANTITY` |
| Change what counts as "no location" | `NO_LOCATION_TOKENS` |
| Change page sizes | `LOG_PAGE_SIZE`, `LOG_MAX_PAGES`, `LOCATION_PAGE_SIZE` |
| Add a stage | `State.stage` switch in `render()` **and** the primary button handler |
| Change colours / spacing | `3. CSS INJECTION`. Every class is `mrc-*`; the tokens mirror C7's (`.form-control` `.5rem .75rem`, border `#e1e6ef`, focus `#8ad4ee`, heading `#374767`). |
| Point at production C7 | `API_BASE` + `WMS_BASE` + `@match` in the header |

---

## Debugging on a device

All console output is prefixed `[MalpaRcv]`.

- **Scanner "not working"** → almost always focus. Check `document.activeElement.id`; it should be `mrc-catch` or the field for the current stage.
- **"Session expired" when you're not** → you pointed a read at `malpa.canary7.com` for a non-`/inbound/` path. See the three-host trap.
- **Every field disabled after a check-in** → the `_writeInFlight` latch didn't clear, or `render()` threw. Check the `finally` in `doCheckin`.
- **Counters look wrong** → `refreshReceipt()` didn't run or its `notFound` branch swallowed a real error.
- **Other C7 tabs went blank** → tab co-existence. An inline `display:none` was left on a C7 pane.

---

## Testing a change before pushing

There are offline jsdom harnesses (kept in scratch, not in the repo — rebuild them if you need them; they were quick to write and they caught two production-grade bugs):

| Harness | Covers |
|---|---|
| `harness.js` (24 tests) | receipt lookup, item resolution, quantity/factor |
| `harness2.js` (62 tests) | the full stage machine + write path |
| `sess.js` (16 tests) | token hygiene, session-expired latch |
| `host.js` (13 tests) | which base each endpoint goes to |
| `cont.js` (22 tests) | history: pagination, dedupe, unix time, user join, row render |

Minimum before pushing:

1. `node --check malpa-receiving.user.js`
2. Open the tab, close it — **other C7 tabs still clickable afterwards**, including when ours is the only other tab.
3. Receive a non-UoM item. Then a factor-6 item as cartons — confirm `open_quantity` drops by `qty * 6`.
4. Type a non-divisible quantity → must be rejected.
5. An item whose line is fully received → must reach the type-`OVER` path, not a roadblock.
6. An item whose suggested location is `NEW` → blank field, red note, no suggestion.
7. Tick Keep Location, receive two items → second one uses the first's location.
8. A batch-tracked item → batch + expiry, and the primary button advances.
9. Open History → user name, item code, location, quantity, readable time. Close and re-open it.
10. Whole flow with **no scrolling**, keyboard open and closed.

**Writes are production.** There is no safe sandbox. Use **MA-TRL (company 46)** for test receipts, and **warehouse 10 (Darra) only — never warehouse 9**. Confirm before writing.

---

## Known gaps / not built

- A fully-closed receipt can't be opened at all (C7 `1016`). Nothing to fix client-side.
- History can briefly show pre-write rows during a locked, busy state (see above).
- No `window.__malpaRcv` debug handle like `malpa-pick` has — worth adding.
- No `VERSION` constant; the `@version` header is the only version marker.
- Script targets `stgauth.canary7.com`. Production cutover = `API_BASE` + `WMS_BASE` + `@match`.

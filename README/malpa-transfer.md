# Malpa Transfer — how it works and how to change it

A Tampermonkey userscript that adds a **stock transfer screen** to Canary7 for the Zebra TC51
handhelds. It replaces the native Inventory Adjustment → Transfer flow, which took too many taps.

**What the operator does:** scan a FROM bin → tick the SKUs to move → scan a TO bin → press
TRANSFER.

If you've never touched this file before, read sections 1–4. If you're about to edit it, read 5–7.

---

## 1. The 60-second mental model

Canary7 is a normal web app (Angular) at `https://malpa.canary7.com`. This script is **not** part of
Canary7 — Tampermonkey injects it into the page after Canary7 loads, and it then does three things:

1. **Adds a link to Canary7's sidebar** ("Malpa Transfer", with the animated Brazil-flag text).
2. **Adds a tab** to Canary7's own tab bar and draws our screen inside it, so it looks native.
3. **Calls Canary7's API directly** using the login token already sitting in the browser.

There is no server, no build step, no dependencies. One file, plain JavaScript. Editing it means
editing this file and pushing it to GitHub.

**A transfer is one API call.** Everything else in the file is UI, validation, and safety rails:

```
POST https://stgauth.canary7.com/index.php?r=inventory/inventory/adjust
{ adjustment_type_id: "7",     ← 7 means "Transfer"
  item_id, item_unit_of_measure_id, item_unit_of_measure_to_id,
  location_from_id, location_to_id,
  quantity,                    ← see Rule 1 below. This is the dangerous one.
  inventory_status, reason_code, comment,
  batch_no }                   ← only when the stock has a batch
```

---

## 2. Installing and running it

1. The handheld needs a browser that supports Tampermonkey (Kiwi or Firefox — stock Chrome for
   Android cannot run extensions).
2. Open the script's raw GitHub URL on the device; Tampermonkey offers to install it.
3. **Log into Canary7 first.** The script borrows the token from the logged-in session — it has no
   credentials of its own. If you open the screen while logged out you get a red
   "Not logged in to Canary7" banner.
4. Tap **Malpa Transfer** in the Canary7 sidebar.

To test a change without touching the fleet, paste the edited file into Tampermonkey's editor on one
device (Dashboard → the script → paste → save) instead of pushing to GitHub.

---

## 3. Words you need (Canary7 vocabulary)

| Term | Means |
|---|---|
| **Bin / location** | A shelf position, e.g. `A10-B02-S01`. Every one has a numeric `id` the API uses. |
| **Item / SKU** | A product, e.g. `WBT-001`. |
| **UOM** and **factor** | Unit of measure. A "Carton" with **factor 6** means one carton = 6 eaches. Canary7 treats each UOM as a separate stock record. |
| **Base units** | The count in eaches, ignoring UOM. 2 cartons of factor 6 = **12 base units**. |
| **Batch** | A batch/lot number, with an optional expiry. Only some items use them. |
| **LP (licence plate)** | A pallet/tote label. Stock can sit "on" an LP inside a bin. |
| **Allocated** | Stock already promised to an order. **Cannot be moved.** |
| **Warehouse 10** | Darra — the only live warehouse. Warehouse 9 (Carole Park) is not used. |
| **MA-TRL (company 46)** | The test company. Use it for any trial move. |

**There is no test system.** Every transfer this script performs moves real stock in the live
warehouse immediately.

---

## 4. What happens when the operator uses it

1. **Scan FROM.** `loadFrom()` resolves the code to a bin, then reads that bin's stock and calls
   `groupRows()` to turn raw inventory records into the rows you see on screen.
2. **The rows.** One row per *movable thing* — same SKU in two UOMs is two rows; same SKU in two
   batches is two rows. Quantity pre-fills to what's on hand. Tapping the quantity opens an in-panel
   keypad (`openQtyPad()`), not the Android keyboard, because the Android keyboard covers the row
   you're editing.
3. **Warnings.** Rows with allocated stock go red and are capped. Rows whose stock sits on several
   LPs are merged into one row with a warning (see Rule 4).
4. **Scan TO.** `checkTo()` resolves it and refuses if it's the same bin as FROM.
5. **TRANSFER.** `doTransfer()` re-validates every ticked row, then posts one `adjust` call per row,
   **one at a time**. Then it re-reads the destination bin to confirm what actually landed, and shows
   a green / amber / red banner. On full success both fields clear for the next move; on any failure
   they stay loaded so the operator can retry.

---

## 5. Map of the file

Sections are numbered in banner comments. **Line numbers drift as you edit — search for the banner
text instead** (e.g. `// 6. DATA`).

| Section | Lines | What's in it | Edit this when… |
|---|---|---|---|
| Metadata header | 1–14 | `@version`, `@match`, `@updateURL` | you ship a new version |
| Confirmed API behaviour | 16–91 | Notes from live probing — **read before changing anything API-related** | you learn something new about the API |
| `0. CONSTANTS` | 96–109 | API base, warehouse, adjustment type, `VERSION` | rarely |
| `1. AUTH + API LAYER` | 111–160 | `getToken`, `mkHeaders`, `apiGet`, `apiPost` | you add an endpoint |
| `2. STATE` | 162–178 | `State` (from/to/rows/busy) and `R` (DOM refs) | you add a new piece of screen state |
| `3. AUDIO` | 180–232 | success / error / scan / warn chimes, vibration | you change the sounds |
| `4. LOG` / `4b. STATUS BANNER` | 234–272 | `Log` → browser console only. `Status` → the coloured banner the operator sees | you change what the operator is told |
| `5. UTIL` | 274–295 | HTML escaping, scanner stuck-Shift repair | see Rule 3 |
| `6. DATA` | 297–483 | **The brain.** Location lookup, stock reading, row grouping, validation, the transfer body | most real changes |
| `7. CSS` | 485–720 | All styling, including the Brazil wave on the sidebar label | you change appearance |
| `8. NAV INJECTION` | 722–762 | Adds the sidebar link | rarely |
| `9. SHELL` | 764–856 | Builds the Canary7 tab (falls back to a full-screen panel if the current screen has no tab bar) | rarely |
| `9b. TAB CO-EXISTENCE` | 858–950 | Sharing the tab bar with Canary7's own tabs | **read Rule 5 before touching** |
| `10. RENDER` | 959–1199 | `renderMain` (the layout), `renderRows` (the row list), `refreshGo` (the button) | you change the screen |
| `11. ACTIONS` | 1201–1534 | The keypad, field clearing, `loadFrom`, `checkTo`, `doTransfer` | you change behaviour |
| `12. FOCUS RECOVERY` | 1536–1560 | Keeps the scanner pointed at the right field after the device sleeps | rarely |
| `13. OPEN / CLOSE / KEYBOARD` | 1562–1642 | Opening, closing, Esc, and the visible red crash box | rarely |
| `14. DEBUG HANDLE` | 1644–1657 | `window.__malpaTransfer` — see section 8 | you add something you want to test |
| `15. BOOT` | 1659–1683 | Retries injecting the sidebar link until Angular has drawn the sidebar | rarely |

### The important data shape

`groupRows()` turns Canary7's inventory records into "rows". Every row is one object, and almost
every function takes one:

```javascript
{ itemCode: 'WBT-001', description: 'Waterbottle 1L',
  itemId, iuomId,              // the two ids the API needs
  uomName: 'Carton', factor: 6,
  batchNo, batchExpiry, status: 'available',
  onHand: 60,                  // BASE units
  allocated: 12, suspended: 0, // cannot be moved
  lps: ['o7282','or7'],        // licence plates merged into this row
  qty: 60,                     // what the operator wants to move, BASE units
  checked: false }
```

---

## 6. The five rules you must not break

Each of these was a real bug. They're the reason the file is as careful as it is.

### Rule 1 — Quantity is in two different units

`onHand` is in **base units**. The `quantity` you POST is in **the record's own UOM**.

Sending `quantity: 1` against a Carton record with factor 6 moves **6 base units**. So:

```javascript
quantity = qty / factor        // buildTransferBody()
```

and it must divide evenly — `validateRow()` rejects anything that doesn't. If you change how
quantities are entered or stored, re-check both places.

### Rule 2 — The API's response lies

The `adjust` call returns HTTP 200 with the source record **as it was before the move** — stale
quantity, stale timestamp. It looks like nothing happened.

Never confirm success from the response. `doTransfer()` re-reads the destination bin instead. Keep it
that way.

### Rule 3 — Location search is a prefix match, and `%` is a wildcard

`configuration/location&location_code=A10-B02` returns `A10-B02-S01`, `-S02`, `-S11`… So
`resolveLocation()` **demands an exact code match**. Remove that check and a half-read scan silently
moves stock to the wrong bin.

`%` is a SQL `LIKE` wildcard — `%B02-S0%` works — so operators use it to search. That's why `%` is
deliberately **absent** from the `_SHIFT_NUMS` repair table in section 5, even though every other
shifted symbol (`$`→`4` etc.) is repaired there. Don't "tidy up" that omission.

### Rule 4 — Licence plates can't be targeted

The `adjust` body has no LP field. If one bin holds the same SKU/UOM/batch under several LPs,
Canary7 takes from the **oldest** and the destination stock carries no LP. Confirmed live.

So `groupRows()` merges those records into one row and warns. Don't split them back out into separate
rows — you'd be offering a choice the API cannot honour.

### Rule 5 — Never leave an inline `display:none` on Canary7's tabs

Angular switches tabs by toggling the `.active` **class**. An inline `style.display` beats a class, so
a Canary7 tab you hide that way can **never be shown again** — dead until the page reloads. This
shipped twice (in this script and in Malpa Pick).

The fix in section 9b: only touch another panel's inline display while our tab is the active one,
record the old value on the element itself (`dataset.mtrPrevDisplay`), and restore every one of them
the moment we're not active — including on close. A `MutationObserver` on the tab bar means whoever
Canary7 activates wins.

---

## 7. How to make common changes

**Change the wording the operator sees.**
`Status.show('ok' | 'err' | 'warn', title, [detail lines])`. Search for `Status.show` — there are
about a dozen. `Log.*` goes to the browser console only; operators never see it.

**Change a sound.** `Audio.chime()` in section 3, four cases: `ok`, `scan`, `warn`, `error`.

**Add a column or badge to a row.** `renderRows()` in section 10. Badges use the local `tag()`
helper. Add the data in `groupRows()` (section 6) first so it's on the row object.

**Add a validation rule.** `validateRow(g)` in section 6 — return a plain-English string to block,
or `null` to allow. It's used in three places automatically (the row list, the keypad, and
`doTransfer`), so one edit covers all of them.

**Change what quantity pre-fills to.** In `groupRows()`: `rows.forEach(g => { g.qty = g.onHand; })`.
For example `g.qty = movableQty(g)` would pre-fill the movable amount instead of on-hand.

**Change the sidebar label or its colours.** `injectNav()` (section 8) for the text and icon;
`#mtr-nav .mtr-nav-label` in section 7 for the Brazil gradient. The wave speed is the `3.6s` in
`mtr-brazil-wave`. Note the `@supports` fallback below it: the label is transparent text filled by a
gradient, so **without that fallback a browser that can't clip a background to text renders the label
invisible**. Keep it.

**Add a new API call.** Add a function in section 6 next to `searchLocations` / `readLocationStock`,
using `apiGet('module/endpoint&param=value')`. Note the `&` — the base URL already ends in `?r=`, so
every extra parameter is joined with `&`, never `?`.

**Change the styling.** All CSS is one string in section 7. Every class is prefixed `mtr-` so it
can't collide with Canary7 or another Malpa script. Keep the prefix.

---

## 8. Testing before you ship

The script exposes its internals so it can be driven from the browser console on the device:

```javascript
__malpaTransfer.hasToken()                 // is a login token visible?
__malpaTransfer.apiBase()                  // which API host
__malpaTransfer.State                      // current from/to/rows
__malpaTransfer.validateRow({ ... })       // try a row shape
await __malpaTransfer.resolveLocation('A10-B02-S01')
__malpaTransfer.open() / .close()
```

There is also an **offline test harness** (`test-malpa-transfer.js`) that runs the real script under
Node with a fake DOM and a stubbed API — no browser, no Canary7. Run `node test-malpa-transfer.js`.
It covers the five rules above, the wildcard picker, the keypad, the tab behaviour and a full
transfer end to end. **Get it green before shipping**; if you add behaviour, add an assertion.

`node --check malpa-transfer.user.js` catches syntax errors, but is not a substitute.

---

## 9. Shipping it

Pushing this file to the repo root **deploys it to every TC51 automatically** — `@updateURL` means
Tampermonkey pulls the new version on its own. There is no staging and no rollback except another
push.

Before you push:

1. **Bump `@version`** (line 4). Tampermonkey ignores a push whose version didn't change — this is
   the classic "I pushed it but the devices still have the old one".
2. **Keep `const VERSION` (line 100) in step with it.**
3. Run the harness.
4. Prefer shipping when pickers are off the floor.

To force an update on one device: Tampermonkey dashboard → the script → **Check for updates**.

To undo a bad release: restore the old code, bump the version **up** again (e.g. 2.6.1 broke → ship
2.6.2 containing 2.6.0's code). Never revert the file at the same version — devices end up on mixed
versions.

---

## 10. Known issues in this copy

- **`@version` is `2.6.1` but `const VERSION` is `'2.6.0'`.** Harmless to operators (the constant is
  only used in a console line and the debug handle) but it makes "which version is on this device?"
  unanswerable. Set both to the same value.
- **The update URLs point at `Malpa-3PL/Warehouse-Scripts`, while `@homepageURL` and `@supportURL`
  still point at `zaynnev/malpa3pl`.** If the repo has moved, update the other two so a maintainer
  who follows the link lands in the right place.
- **Overlay fallback is untested on-device.** If a Canary7 screen has no tab bar, `buildShell()`
  draws a full-screen panel instead. It exists so the script never silently does nothing, but it
  hasn't been exercised on a handheld.
- **`readLocationStock` caps at 300 rows** (`MAX_ROWS`) with no "there may be more" warning. Fine for
  a pick face, potentially not for a bulk bin.

---

## 11. If it doesn't work

| Symptom | Cause |
|---|---|
| No "Malpa Transfer" in the sidebar | The script isn't running at all. Check Tampermonkey is enabled for the page and that the URL matches `https://*.canary7.com/*`. The sidebar link is the "is it running?" indicator. |
| Red "Not logged in to Canary7" | Log into Canary7 in that tab, then reopen. |
| "Location X not found" on a code you can see in Canary7 | It's in warehouse 9, inactive, or the scan was partial (Rule 3). Try typing it with a `%` to search. |
| A Canary7 tab is blank and won't come back | Rule 5. Reload the page; then find what changed in section 9b. |
| Transfer says a line failed | Read the red banner — it carries Canary7's own message per line. Business rejections come back as HTTP 500 with a real reason; they are not worth retrying blindly. |
| Everything 401s | The Canary7 session expired. Log in again. |

---

*Naming note: this is `malpa-transfer.README.md` rather than `README.md`, since the repo holds
several scripts and the root `README.md` slot is shared. Rename it if you'd rather it be the repo
readme.*

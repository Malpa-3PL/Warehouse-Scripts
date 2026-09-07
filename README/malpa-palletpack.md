# Malpa Pallet Pack — README

**File:** `malpa-palletpack.user.js` · **Version:** 1.9.1 · **~3,000 lines, one file, no build step.**

---

## TL;DR

A Tampermonkey userscript that bolts a **blind pack-verification screen** onto the Canary7 WMS web app, for handheld scanners (Zebra TC51) at the packing station.

The operator scans a shipment, then scans every physical unit **without ever being shown what the order requires**. The script tallies everything **locally in browser memory**. Only when the operator taps *Finish* — and only if the local tally exactly matches the order — does it write anything to Canary7.

> **The one rule that explains 80% of this code: NOTHING is written to Canary7 until Finish.**
> Scanning, container boundaries, weights, dimensions, "closing" a box — all local. That's why so much of the code can freely undo things.

---

## 1. Mental model

```
Operator picks a packing profile
        ↓
Scans a shipment number  →  loadShipment()  →  builds a LOCAL cache:
                                                • what each item requires
                                                • every barcode → item + UOM factor
        ↓
BLIND SCAN loop  →  onScan()  →  increments local counters ONLY.
                                 Screen shows a unit count and nothing else.
                                 Same beep/vibrate/flash for right AND wrong scans.
        ↓
"Close Container" per physical box (number, weight, dims) — still LOCAL
        ↓
"Finish Verification"  →  computeVerification()  — local maths only
        ↓
   ┌─── MISMATCH → show the diff, clear counts, rescan. Nothing committed.
   └─── MATCH    → commit()  ←── THE ONLY PLACE THAT WRITES TO CANARY7
                     per container: create → move children in → close
                     Shipment ends at Consigning Pending (status 7).
```

### Why "blind"?
The whole point is that the operator can't cheat toward the expected number. So the UI must **never** leak whether a scan was correct — not through text, not through sound, not through timing, not through an animation. Several oddities in the code exist purely to preserve this (see §6 *Invariants*).

### What it deliberately does NOT do
It never calls `create-consignment-pieces`. Consigning is done by a human at the desk. Don't add it.

---

## 2. The two data structures you must understand

Everything else is plumbing around these.

### `State` (~line 588) — UI/session level
```js
State.screen      // 'PROFILE' | 'SHIPMENT_ENTRY' | 'SCAN' | 'COMMITTING' | 'SUCCESS'
State.profile     // the chosen Canary7 packing profile object
State.containerPrefixes  // [{prefix, typeId, name}] sorted longest-first
State.committing  // re-entry guard so Finish can't fire commit() twice
```

### `Cache` (~line 625) — everything about the current shipment
```js
Cache.items         // Map: item_id → { itemCode, requiredBase, scannedBase, unitWeight, uoms[] }
Cache.barcodeIndex  // Map: BARCODE → { itemId, factor, uomId }     ← the heart of scanning
Cache.unexpected    // Map: barcode → scan count (things not on this order)
Cache.containers[]  // CLOSED boxes (local only until commit)
Cache.current       // the box being filled right now
```

A **container** (`newContainer()`, ~line 601) is:
```js
{ seq, containerNo, containerTypeId,
  lines: Map(item_id → base units in THIS box),
  unexpected: Map(barcode → count),
  weight, length, width, height,
  _c7Id, _c7ContainerNo, _c7Packed }   // ← the "ledger": only set during commit
```
The three `_c7*` fields are the **commit ledger**. If they're `null`, Canary7 knows nothing about this box and you can do whatever you like to it. Once `_c7Id` is set, real stock has moved and the box is off-limits (`containerIsLocal()`).

### "Base units" vs "UOM factor" — critical
Everything is counted in **base units (Eaches)**. A barcode can name any UOM, and each UOM has a `factor`:

- scan an *Each* barcode → `+1`
- scan an *Outer* barcode with `factor: 48` → `+48`

`Cache.barcodeIndex` stores the factor alongside the item, so `onScan()` is a one-line map lookup plus an addition. Canary7 also stores `shipmentDetailChild.quantity` and `pack-short-v2`'s `short_quantity` in **base units** — do **not** multiply by factor when committing (this was a real bug once).

---

## 3. Map of the file

| § | Lines | What lives there |
|---|---|---|
| Header comment | 1–233 | Userscript metadata + a full changelog explaining *why* each fix exists. **Read the block for the version you're touching.** |
| 0 Constants | 238–274 | `API_BASE`, `WAREHOUSE_ID`, `PACK_LOCATION_ID`, paging limits, feature allow-lists |
| 1 Auth + API | 276–514 | `getToken`, `apiFetch`/`apiGet`/`apiPost`, session-expiry classification |
| 2 API queue | 516–582 | `APIQueue` — concurrency 4, retry with backoff, dedupe |
| 3 State + Cache | 584–738 | The structures above, plus the reset functions |
| 4 Audio / voice | 740–793 | Beeps, speech, vibration |
| 5 Helpers | 795–823 | `_esc`, `num`, `normRef`, container-prefix matching |
| 6 Data fetches | 825–878 | Profiles + container types |
| 7 Shipment load | 880–1056 | `loadShipment()` — builds the blind cache |
| 7b Barcode lookup | 1058–1252 | Resolving *unexpected* barcodes to real items/factors |
| 8 Scan handling | 1254–1296 | `onScan()` — ~35 lines, zero network calls |
| 9 UI shell | 1298–1573 | Overlay positioning, tab chip, open/close |
| 9 Screens | 1575–1714 | Profile → shipment entry → scan screen |
| 10 View scanned | 1739–1996 | The review modal + unverify |
| 10 Close container | 1998–2131 | Local box finalisation |
| 11 Finish | 2133–2283 | Verification maths + the mismatch screen |
| 12 **Commit** | 2285–2661 | **The only code that writes to Canary7** |
| 13 Focus recovery | 2674–2697 | Keeps the scan input focused (3 layers) |
| 14 Nav injection | 2699–2756 | Adds the sidebar launcher |
| 15 CSS | 2758–2951 | All styling, injected as one `<style>` |
| 16 Debug handle | 2953–2985 | `window.__palletpack` — everything exported for testing |
| 17 Boot | 2987–3026 | Waits for Angular, injects nav, watches for re-renders |

---

## 4. How it attaches to Canary7 (the shell)

Canary7 is an Angular app. This script **never modifies Canary7's own DOM** — that's a hard rule, and breaking it makes C7's tabs go blank.

- It appends **one fixed-position `<div id="mpp-root">` overlay** to `<body>`, positioned over C7's content area.
- It adds a launcher `<li>` to C7's sidebar and a "Pallet Pack" chip to C7's tab bar.
- Clicking a native C7 tab just **hides** the overlay (`display:none`) — state stays intact. Clicking our chip shows it again.
- `measureChrome()` (~line 1334) works out where C7's content area starts by measuring C7's **tab bar** (never the sidebar — an open drawer gives a wrong answer). A sanity gate rejects any measurement leaving less than 60% of the viewport / 280px.
- A pile of observers (`wireReposition()`) re-measure on resize, orientation change, sidebar transitions and Angular re-renders.

**Rendering is `innerHTML` string templates.** Every `render*()` function rewrites `root.innerHTML` and then re-attaches listeners (`wireHeader()` etc.). There is no framework, no virtual DOM. Consequences:

- Always `_esc()` anything from the API or the scanner before putting it in a template.
- Anything that must survive a re-render lives on `<body>`, not in `#mpp-root` (that's why the session-expired banner is mounted there).
- After adding a button to a template, **add its `addEventListener` in the same function.**

---

## 5. How it talks to Canary7

```js
const API_BASE = 'https://stgauth.canary7.com/index.php?r=';
```
Yes, `stgauth` — the production UI at `malpa.canary7.com` is a static Angular app; the API is served from `stgauth`. Not a mistake.

Auth: `getToken()` scrapes the JWT out of `localStorage`/`sessionStorage`; `captureSessionId()` grabs `x-session-id` by monkey-patching `XMLHttpRequest.setRequestHeader` until Angular makes a call.

**All calls go through `apiFetch()`** (~line 427). Use `apiGet` / `apiPost`. Never call `fetch()` directly.

### Reading a failure — this is where people get lost
A `401`/`500` from Canary7 is a *question*, not an answer:

- Angular rotates the token in the background → a call in flight gets a meaningless 401. → **retried once automatically.**
- C7 intermittently answers `HTTP 500 {"message":"jwt expired"}` and then serves the same request fine. → `sessionIsAlive()` **probes** before ever claiming expiry.
- Only after that probe says "dead" do you get a `SESSION_EXPIRED` error.

Error codes you'll see:

| `err.code` | Meaning |
|---|---|
| `SESSION_EXPIRED` | Probed and confirmed dead. Test with `isSessionExpired(err)` — **never** test `err.message` or `err.status === 401`. |
| `AUTH_BLIP` | Auth-shaped failure but the session is alive. Transient; do not retry mutations. |
| *(none)*, has `.status` | A real business rejection. **Do not retry** — C7 sends business refusals as HTTP 500 with a numeric code, and retrying re-fires a mutation against live stock. |

`opts.critical: false` means "this read may fail silently, never show the session modal". Used for the cosmetic barcode lookup.

### The queue
`Q = new APIQueue({ concurrency: 4, maxRetries: 3 })`. It retries **only** transport failures (no `.status`) and gateway codes (408/429/502/503/504). Commit's per-container steps must stay **serialised** because child-split IDs chain.

### The commit call sequence (per container)
```
POST shipment/shipment-container/create                  → container id
GET  shipment/shipment-container/move-into-container-v2  → whole child goes in
GET  shipment/shipment-container/pack-short-v2           → part of a child goes in;
                                                            returns a NEW child id
                                                            carrying the remainder
GET  shipment/shipment-container/close-to-container      → weight + dims
```
Then `verifyConsigningPending()` re-reads the header and confirms status **7**. A `500` on `close-to-container` is treated as **soft** — C7 closes the container before the print side-effects that generate those 500s.

---

## 6. Invariants — break these and you break the tool

1. **No writes before Finish.** If you add an API call outside `commit()`, stop and think again.
2. **Never leak correctness on the scan screen.** Identical chime, vibration, flash for hits and misses. The units pill repaints on a *fixed 600 ms delay* for both (`scheduleScanMetaUpdate`) precisely so a self-correcting number can't become the tell.
3. **Test `err.code`, never `err.message`.** See the table above.
4. **`_c7Id` set = hands off.** Guard any state-mutating path with `containerIsLocal(box)` / `c7HoldsContainers()`.
5. **Commit must be re-entrant.** Retry is a real user path. Never re-create or re-pack a container whose ledger says it's done — a phantom empty pallet on a live consignment is the failure mode.
6. **Keep the ledger consistent.** If you remove units from a box you must also: decrement `Cache.items[id].scannedBase`, drop the box if it's now empty, and reduce its keyed weight. `reconcileClosedBox()` does the last two — use it.
7. **`normRef()` on both sides of every barcode comparison.** C7's reference rows contain dirty quoting (a live row reads `"""0129351262016618"`). The exact form is authoritative; the normalised form is only ever a weak **alias** that can never displace a real entry.
8. **Paginate.** `loadShipment` loops until a short page returns. C7 truncates silently at your `per-page` and never tells you there's more. A load that would still be truncated is **refused**, not packed blind.
9. **`_esc()` everything interpolated into HTML.**

---

## 7. Common edits, and where to make them

| I want to… | Do this |
|---|---|
| Change the packing station location | `PACK_LOCATION_ID` (line ~249). Per-station constant. |
| Enable partial rescan for another client | Add the company id to `PARTIAL_RESCAN_COMPANY_IDS` (line ~256). Confirm the id against `shipmentHeader.company_id`, not a guess. |
| Change what the scan screen displays | `updateScanScreenMeta()` (~1705). **Re-read invariant #2 first.** |
| Add a field to the Close Container dialog | `openCloseContainer()` (~2004) — template, then read it in the `#mpp-cc-ok` handler, then store it on the container in `newContainer()` (~601), then send it in `closeToContainer()` (~2572). |
| Change the failed-verification screen | `showMismatch()` (~2191) |
| Change what's shown in "View scanned" | `showViewScanned()` (~1740) + `itemScanRow()` / `unexpectedScanRow()` |
| Add a new screen | Write a `renderX()` that sets `State.screen`, writes `root().innerHTML`, then calls `wireHeader()` and wires its own buttons. Add the screen's scan-input id to `_SCAN_SCREENS` (~1304) if it accepts scans. |
| Restyle anything | `injectCSS()` (~2762). Use the `--c7-*` tokens; they're scoped to `.mpp-root` so C7's own variables are untouched. |
| Change how barcodes resolve to items | `loadShipment`'s `indexBarcode` (~1002). Careful — this is the correctness core. |
| Fix the panel appearing in a squeezed column | `measureChrome()` (~1334). Measure something *inside* the content column. |

---

## 8. Debugging on a handheld

There's no console on a TC51, so everything is exported:

```js
window.__palletpack   // State, Cache, and ~40 functions
```

Useful one-liners in a desktop Chrome console on the C7 tab:

```js
__palletpack.VERSION
__palletpack.Cache.items                 // requirements vs scanned
__palletpack.Cache.barcodeIndex.size     // did the load actually index everything?
__palletpack.computeVerification()       // what Finish would decide right now
__palletpack.onScan('0129351262016618')  // simulate a scan
__palletpack.c7HoldsContainers()         // is anything already committed?
```

All logging is prefixed `[MalpaPalletPack]` via `LOG()` / `WARN()`.

**Symptom → likely cause:**

| Symptom | Look at |
|---|---|
| Real SKUs reported as "unknown barcode" | Pagination / `barcodeIndex` build (`loadShipment`) |
| "Session expired" while C7 clearly works | `_isAuthFailure` / `sessionIsAlive` — something is throwing the sentinel too eagerly |
| Panel squeezed into a narrow right column | `measureChrome()` sanity gate |
| A modal button does nothing | Listener bound via `document.getElementById` instead of scoped to the modal — there are two overlays |
| Phantom empty pallet in C7 | Commit re-entrancy / `_c7Packed` ledger |
| Outer carton counts as 1 instead of 48 | `unexpectedFactor` / `resolveUnexpected` lookup failing |

---

## 9. Releasing

1. Bump **both** `// @version` (line 4) **and** the `VERSION` constant (line ~246). They must match or the fleet won't update.
2. Add a changelog block to the header comment — explain the *root cause*, not just the fix. That's the house style and it's the reason this file is maintainable.
3. Push to the repo behind `@updateURL` / `@downloadURL`; handhelds pull from the raw GitHub URL.
4. Verify the raw URL serves the new version before telling anyone it's out.

The `malpa-userscripts:release-userscript` skill automates steps 1–4 if you have the plugin.

---

## 10. Gotchas that will bite you

- **The scan input is invisible, not hidden.** It's a full-size transparent `<input>` (`.mpp-scan`). A 1×1 hidden input made Firefox pop the soft keyboard. Don't "tidy" it.
- **Capture scans from `input.value`, never from `e.key`.** Hardware scanners report shifted glyphs (`-` → `_`, `0` → `)`).
- **`##` in shipment numbers must be encoded** — that's what `encShip()` is for.
- **C7 returns expanded relations under camelCase** (`shipmentHeader`), not `shipment_header`. Read camelCase first, snake_case as fallback. Getting this wrong silently omitted `shipment_header_id` and made every close 500.
- **`get-pack-container` returns every container on the shipment**, not just the one you asked for. Filter by `container_no`.
- **`Number('')` and `Number(null)` are both `0`.** Company/status parsing explicitly checks for empty before `Number()` — otherwise a blank field becomes "company 0".
- **The status guard is positive-only:** block only when a status is readable *and* isn't 5. An absent status proceeds rather than false-blocking.
- **Duplicate container number = HTTP 500.** Handled by regenerating the number and retrying — but *only* for genuine duplicates, never for auth-shaped 500s.

---

## 11. Where the real explanations live

The 200-line header comment is not decoration — it's the incident record. Every non-obvious line in this file exists because something failed on a live pallet, and the header says which order, which company, and what the root cause was. **Read the relevant block before changing the code it describes.** If you fix something, add your own block in the same style.

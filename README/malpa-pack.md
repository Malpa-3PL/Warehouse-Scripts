# Malpa Pack v3 — README

`malpa-pack.user.js` · ~5,900 lines · one IIFE, no build step, no dependencies.

This document is for someone who has never seen this file and needs to change it without
breaking a live packing bench. Read sections 1–4 before you touch anything.

---

## 1. What it is, in one paragraph

Malpa Pack is a **Tampermonkey userscript** that injects a full packing station into the
Canary7 WMS web app. Tampermonkey loads it on every `*.canary7.com` page; the script waits
for Canary7's Angular UI to appear, adds a **"Malpa Pack" item to C7's left sidebar**, and
when the operator clicks it, adds a **tab to C7's tab bar** plus a full-screen panel that
covers C7's content area. Everything the operator does — scan a tote, scan items, close the
box, print the label — happens inside that panel, talking directly to Canary7's REST API
with the logged-in user's own token. It replaces C7's own packing screen because it is much
faster: barcode matching happens locally, so scan feedback is instant, and the API calls
catch up in the background.

It runs on packing-station browsers (desktop Chrome), not the TC51 handhelds.

---

## 2. The five things to know before you edit

1. **Scanning is optimistic.** A scan is matched in JavaScript against a barcode set already
   in memory, the counter goes up, the beep fires — *then* the API call is queued. If the
   call later fails, the script rolls the local state back and shouts at the operator. Never
   "fix" this by awaiting the API before showing feedback; the whole design exists to avoid
   that latency.
2. **`get-pack-container` (GPC) is called ONCE per source tote.** It returns the entire
   shipment: header, company, job, every line, every barcode. All matching works off that
   one payload. Re-fetching it mid-pack throws away scan state and is only done in one
   deliberate recovery path (stale child, §7.4).
3. **This is production.** Warehouse 10 (Darra) is the only live warehouse. There is no
   sandbox for packing. Every write moves real stock and prints real carrier labels.
4. **Profiles drive behaviour, not `if` statements scattered around.** All profile flags are
   read through the `Workflow` object (§5). If you need new conditional behaviour, add a
   getter there rather than reading `Session.profile.foo` inline.
5. **Bump `@version` on every change.** Tampermonkey only auto-updates the fleet when the
   version in the header increases. There is no internal `VERSION` constant to keep in sync
   — the header is the only place. Shipping is done with the `release-userscript` skill
   (bump → test → commit → push to `Malpa-3PL/Warehouse-Scripts` → verify the raw URL).

---

## 3. How it loads (the metadata block)

```
@match      https://*.canary7.com/*      // UI is malpa.canary7.com, API is stgauth.canary7.com
@grant      GM_xmlhttpRequest            // needed ONLY for the two non-Canary7 hosts
@connect    metrics.malpasoft.com        // Metabase
@run-at     document-idle
@updateURL / @downloadURL → raw.githubusercontent.com/Malpa-3PL/Warehouse-Scripts/main/malpa-pack.user.js
```

Two things people trip over:

- **`API_BASE = 'https://stgauth.canary7.com/index.php?r='` is not staging.** Despite the
  name, that host is Canary7's production monolith API. Do not "fix" it to `malpa.canary7.com`.
- **Taking `@grant` puts the script in Tampermonkey's sandbox.** That is fine here because
  the script never assigns to `window.fetch`. If you ever need to intercept page traffic,
  patch `XMLHttpRequest.prototype` (which still works), as `captureSessionId()` already does.

---

## 4. Map of the file

The file is divided by numbered banner comments. Search for e.g. `// 15.  SCAN` to jump.

| §   | Name | What lives there |
|-----|------|------------------|
| 0   | Constants | `API_BASE`, `WAREHOUSE_ID`, GPC expand list, localStorage keys, Metabase/Retool credentials, `perfMark`, `orBreadcrumb`, `ExpectedCartonCache` |
| 1   | Auth | `getToken`, `captureSessionId`, `mkHeaders`, `apiGet/apiPost/apiDelete` |
| 2   | Async API Queue | the `APIQueue` class and the single instance `Q` |
| 3   | State store | `ShipmentCache`, `SourceToteCache`, `ItemTrack`, `Session` |
| 4b  | Event log | `EventLog` — the operator-facing console pill |
| 4   | Workflow engine | every profile-flag decision + weight calculation |
| 5   | Core API actions | one function per Canary7 endpoint, plus the consign chain |
| 6   | Audio | `beep()` — WebAudio tones, no sound files |
| 7   | CSS | one giant injected `<style>`; all ids/classes prefixed `mp-` |
| 8   | DOM helpers | `h(tag, props, ...children)` — tiny hyperscript |
| 9   | UI refs & build | `buildUI()` constructs the whole panel and fills `R` |
| 10  | Status & queue badge | `setStatus`, `updateQueueBadge`, `showRollback` |
| 11  | Profile loading | `autoDetectLocation`, `loadProfiles`, `onProfileChange` |
| 12  | Location | resolving the pack-to location |
| 12b | Multi-tote modal | blocking "this shipment spans N totes" dialog |
| 13  | Load tote | `onLoadTote` — the big one |
| 14  | Choose box type | the three container-creation paths |
| 15  | Scan | `onScan` — the hot path |
| 16  | Close container | `onCloseContainer` — the other big one |
| 17  | New container | next piece of a multi-piece shipment |
| 20  | Full reset | `onFullReset`, `resetForNextTote` |
| 21  | Render | `renderItems`, `updateProgress`, `updateDetailCounter`, popups |
| 22  | Keyboard | Esc / F2 / F3 / F4 / Enter |
| 23  | Nav injection | sidebar item + capture-phase click listener |
| 24  | Boot | `tryInject`, MutationObserver, background location pre-resolve |

Sections 17 and 19 are near-empty stubs left in place to keep the numbering stable.

---

## 5. The data model

Five objects hold everything. Learn these and the rest of the file reads easily.

### `ShipmentCache` — one shipment
Built once from the GPC response. **Survives closing a container**, so a shipment that needs
three boxes keeps its scan state across all three. Cleared when a new tote is scanned.

- `items` — `{ childId → ItemTrack }`. The `shipment_detail_child` is C7's unit of packing.
- `allItems / pendingItems / doneItems / total / packed / pct / allDone` — derived getters.
- `totalOriginalQty` — captured once, used as the denominator for proportional weight.

### `ItemTrack` — one shipment line
- `required` / `scanned` / `done` — local truth.
- `_apiOk` — has `move-into-container` been *confirmed by the server*? Close is blocked
  until every done line has this.
- `barcodes` — a `Set` of lowercase strings, **scoped to the line's allocated UOM**. This
  matters: if an item has both an Each child and a Carton child, matching against all UOMs
  would fire the move against the wrong child and C7 answers `completePacking() on null`.
- `_scannedAtPieceStart` — units already sealed in a previously closed box. Undo cannot go
  below this floor, and weight for the next piece is calculated from the delta above it.
- `_localOnly` / `_realChildId` — placeholder rows created by the pack-short split (§7.5).
  Never send a `_localOnly` id to C7.

### `SourceToteCache` — one physical tote
Separate from `ShipmentCache` on purpose. A SIBP tote holds stock for several shipments, so
tote-level counters must not be shipment-scoped. Feeds only the titlebar "details remaining"
pill and the retain-tote behaviour — **never** scan matching, close or pack-short.

### `Session` — one outbound container
Profile, pack location, container type, the created container, and `phase`:

```
BOOT → PROFILE → SCAN_TOTE → [SIBP_ITEM_SCAN] → CHOOSE_BOX → PACKING → CLOSING → COMPLETE
```

`phase` is the main guard everywhere. `reset()` clears the container; `resetAll()` clears
the profile too.

### `Workflow` — profile flags → decisions
Pure getters over `Session.profile`. Examples: `autoGenerateContainer()`,
`confirmContainerType()`, `requiresDimsConfirm()`, `allowEarlyClose()`, `isSIBP()`,
`isMIBP()`, `calcPackedWeight()`. **Add new profile-driven behaviour here.**

### `R` — live DOM references
A flat object of every element `buildUI()` created (`R.scanIn`, `R.btnClose`, `R.dcPanel`…).
Set in one literal near the end of `buildUI`; reset to `{}` by `closeUI()`. Guard every
access (`if (R.scanIn)`) because the panel can be closed while async work is in flight.

### `Q` — the API queue
`new APIQueue({ concurrency: 4, maxRetries: 3 })`. Every background call goes through it.
Features: dedup by `key` (an in-flight `move-42` will not be queued twice), priority sort,
exponential backoff, and `drain()` which close waits on. One special case: errors containing
`completePacking` or `packShortV2` are **never retried** — the child id is stale and retrying
can only fail.

---

## 6. The operator flow, mapped to code

| Step | What the operator does | Entry point |
|------|------------------------|-------------|
| 1 | Clicks "Malpa Pack" in the sidebar | `openPack()` → `injectCSS()` + `buildUI()` |
| 2 | Picks a packing profile | `loadProfiles()` → `onProfileChange()` |
| 3 | Pack location resolves (usually already cached) | `autoDetectLocation()` → `onSetLocation()` |
| 4 | Scans the source tote | `onLoadTote()` — GPC, container-type fetch, open-container check, cleanup, badges |
| 5 | A box is created or chosen | `initiateContainerCreation()` → Path A/B/C |
| 6 | Scans items | `onScan()` — match, increment, beep, enqueue verify + move |
| 7 | Last item verified | auto-close, or the carton-scan prompt if the profile confirms dims/weight |
| 8 | Box closes | `onCloseContainer()` — drain queue, weigh, `close-to-container` |
| 9 | Label prints | `startPostCloseConsigning()` via the consign FIFO |
| 10 | Back to the tote field | `resetForNextTote()` (or `onNewContainer()` for the next piece) |

Keyboard: **Esc** closes the panel, **F2** focuses item scan, **F3** focuses tote scan,
**F4** closes the container, **Enter** closes when the button is enabled and focus is not in
an input.

---

## 7. The parts that will bite you

### 7.1 Container creation has three paths (§14)
Chosen from profile flags, mirroring what native C7 does:

- **Path A** — `auto_generate=1` + a default container type → number and type chosen
  silently, container created immediately, no prompt.
- **Path B** — `auto_generate=0` + `confirm_container_type=1` → show the box-type picker,
  then auto-generate the number.
- **Path C** — neither → show a container-number input; the **type is derived from the
  scanned barcode's prefix** matched against `get-shipment-container-type`.

Before any of these, `initiateContainerCreation()` checks for an **already-open outbound
container** on this shipment and reuses it. That is the mid-session-refresh recovery: an
empty open container is valid to pack into, and deleting/recreating it used to produce
duplicate containers at consign.

### 7.2 Two special profile families
Detected by **name regex**, not by a flag — `/sibp/i` and `/mibp/i` on the profile name. If
profiles are renamed in C7, this breaks silently.

- **SIBP** (single item, bulk pick): the tote holds stock for many shipments. Scan the tote
  once, then scan *any item* — that item's own GPC call loads its shipment
  (`onSibpItemScan`). SIBP shipments are **pre-consigned**, so the script does not create
  consignment pieces; it only associates the carrier piece. Tote counts come from
  `inventory/inventory` (or the Retool proxy).
- **MIBP**: keeps the retained-tote flow — after a close, the same tote number is reloaded
  automatically for the next shipment in it.

Both disable early close (`allowEarlyClose()`).

### 7.3 Weight (`Workflow.calcPackedWeight`)
Two attempts, in order:
1. Real weights, per piece. The weight is **not** on `child.itemUnitOfMeasure` (C7 returns
   null there) — it is on `item.itemUnitOfMeasures[]`, matched by the child's allocated UOM
   id. Only units scanned since the last close count (`scanned − _scannedAtPieceStart`).
2. Proportional share of `shipmentHeader.total_net_weight`, based on units in this piece.

Falls back to the container type's own weight, floored at 0.1. Getting this wrong means the
customer is billed the wrong freight, so change it with care.

### 7.4 Stale children
If `move-into-container-v2` returns `completePacking() on null`, that child was already split
by an earlier session or a MIBP wave. The queue does not retry; `_refreshGPCAfterStaleChild()`
re-fetches GPC, rebuilds `ShipmentCache.items` **carrying over scanned state**, and tells the
operator to rescan anything showing 0/N.

### 7.5 Closing with items left over (`splitRemainingItemsForNextContainer`)
Unpacked units are split off one at a time with `pack-short-v2`. C7 may return a new child
id (use it for the next call in the loop) or the same id (create a `_localOnly` placeholder
for the UI only, and remember `_realChildId`). Sending a fake id to C7 is a guaranteed 500.

### 7.6 `close-to-container` returning 500 is usually fine
C7 closes the container server-side *before* running print routing. A 500 from those side
effects still leaves the container closed, so the script treats **any** 500 here as a soft
warning, synthesises a `status_id: 7` response with `_softError`, and continues to consign.
Only 401 and network failures are hard errors.

### 7.7 Empty closed containers self-heal
An abandoned mid-shipment session leaves closed containers that carry a weight but hold no
children — their weight would be declared twice when the operator repacks. At tote load,
`cleanupEmptyClosedContainers()` deletes them, then re-reads to verify the delete actually
happened. It filters hard on `shipment_header_id` because the detail endpoint returns every
container in the consignment group.

### 7.8 The consign chain is strictly FIFO
Packing may overlap the previous shipment's label chain, but the chains themselves are
serialised through `_enqueueConsign()`. C7 handles concurrency fine; the **printer gives no
ordering guarantee**, and two boxes on the bench with swapped labels is a real incident.
`_shipmentGen` guards the async failure handler so a late error from shipment A cannot
clobber the UI of shipment B — it still surfaces the error via badge, log, beep and the
⟳ Reprint button.

### 7.9 Undo is floored
`unverifyItem()` refuses to go below `_scannedAtPieceStart`. Those units are physically
inside a sealed, weighed box and C7 has no reverse move.

---

## 8. External services (not Canary7)

Two calls leave the Canary7 domain and therefore go through `GM_xmlhttpRequest`:

| Service | Purpose | Notes |
|---|---|---|
| Metabase card 581 (`metrics.malpasoft.com`) | shipment number → **expected carton label**, cached in `ExpectedCartonCache` | Refreshed in the background, debounced to 60s, never destructively — a failed refetch keeps the old map. A response of exactly 2000 rows logs a warning: Metabase's default row cap is truncating the card. |
| Retool workflow | tote inventory detail for the counter | Used because floor operators may lack C7 `inventory/inventory` permission; the workflow runs under a privileged service account. `normaliseRetoolRows()` exists because Retool's output shape depends on how the workflow block is configured. |

Both keys are **hardcoded in the file**, which is world-readable on GitHub. That is a known
state of affairs, not an accident — but do not add more, and do not log headers.

Because `GM_xmlhttpRequest` runs in the Tampermonkey sandbox, OpenReplay cannot see these
calls at all. `orBreadcrumb()` emits a structured console line (plus a custom event if C7's
tracker is exposed) so they are findable in a session replay. Consign failures get one too.

---

## 9. Canary7 endpoints used

All are `GET` unless noted, all relative to `API_BASE`.

**Reading**
`shipment/shipment-container/get-pack-container` · `shipment/shipment-container` (list/detail)
· `configuration/shipment-packing-profile` · `configuration/container-type/get-shipment-container-type`
· `shipment/shipment-container/container-type` · `configuration/location/view-by-code`
· `configuration/location` · `labour/shift-user` · `inventory/inventory` ·
`logging/inventory-log` (last picker) · `job/job` (job id by container)

**Writing**
`shipment/shipment-container/auto-generate-container-number` ·
`shipment/shipment-container/create` (POST) · `shipment/shipment-container/delete` (DELETE) ·
`shipment/shipment-container/move-into-container-v2` · `shipment/shipment-container/pack-short-v2` ·
`shipment/shipment-container/close-to-container` ·
`shipment/shipment-container/create-consignment-pieces` (POST) ·
`shipment/consignment-piece/set-carrier-piece-no` · `shipment/consignment/reprint` ·
`job/job/unassign-job` · `configuration/item/process-log-item-verification` (best-effort log)

Note that several *write* operations are `GET` requests with query parameters. That is
Canary7's design, not a mistake in this script.

### Auth
`getToken()` scrapes `access_token` / `token` / `id_token` / `auth_token` from local or
session storage. `x-session-id` is trickier: Canary7's Angular interceptor adds it to every
request and it links to the user's shift, which carries the **printer assignment**. Without
it, `create-consignment-pieces` returns "No Print Route". The script captures it by
monkey-patching `XMLHttpRequest.prototype.setRequestHeader` once at boot, un-patching itself
as soon as it sees the header, with a localStorage scan as fallback. `waitForSession()` gives
it up to 1 second before any API call.

---

## 10. UI conventions

- **Every id and class is prefixed `mp-`.** Keep it that way; collisions with Angular are
  invisible and horrible.
- The panel is a **fixed-position overlay** sized to C7's content area by measuring the
  sidebar and tab bar (`positionTabView`). It never reparents or restyles C7's own DOM —
  the one exception is toggling `active` classes on tab `<li>`s, which `closeUI()` restores.
- **It never sets `display:none` on a C7 tab pane.** That is the classic bug in this repo
  (an inline style beats Angular's `.active` class, so the pane stays dead until reload).
  Malpa Pack hides only its *own* view. Keep it that way.
- Tab co-existence is handled three ways at once: a click listener on our tab, a capture
  listener on the tab bar and sidebar, and a 200 ms poll that hides the view if C7 activated
  another tab or removed our `<li>`. Belt and braces, deliberately.
- The sidebar nav uses **one document-level capture-phase click listener**, attached once,
  because Angular re-renders the nav and would drop a listener bound to the element. A
  MutationObserver re-injects the nav item if Angular removes it.
- `EventLog` is the operator's console: an append-only list rendered into a pill in the
  titlebar. Use `EventLog.ok()` / `EventLog.err()` for anything the operator should be able
  to look back at; use `setStatus()` for the transient status line.
- Sounds are generated with WebAudio (`beep('ok' | 'err' | 'scan_done' | 'scan_partial' |
  'all_done')`). No assets to host.

---

## 11. Common edits

**Add a profile-driven behaviour** → add a getter to `Workflow`, call it from the flow. Do
not read `Session.profile` directly outside §4.

**Add a new Canary7 call** → add one `async function` in §5 that returns `apiGet/apiPost`,
call it from the flow. If it should not block the operator, wrap it with `Q.enqueue({ key, fn,
onSuccess, onFailure })` and give it a stable dedup key.

**Add a field to the item rows** → `renderItems()` in §21; the data comes from `ItemTrack`,
so add it in the constructor and make sure GPC actually returns it (extend `GPC_EXPAND`
only if you must — it was deliberately trimmed to keep the payload small).

**Change what happens on close** → `onCloseContainer()` in §16. Respect the order: drain the
queue → verify `_apiOk` on every done line → weigh → close → consign. Do not move consign
before close; C7 needs the committed weight and dimensions.

**Change scan matching** → `ItemTrack.barcodes` (construction) and `onScan()` (matching).
Keep the allocated-UOM scoping.

**Add a debug handle** — there isn't one yet. The house pattern asks for
`window.__malpaPack = { Session, ShipmentCache, Q, R }`, which is the only practical way to
inspect state on a locked-down bench machine. Adding it is a good first contribution.

---

## 12. Debugging

- `openPack()` wraps `buildUI()` in a try/catch that paints the **message and stack into the
  page** — the operator can read it out over the radio without opening DevTools. Keep that.
- `PERF.enabled` is `true`; timings appear as `[MalpaPack][perf] …` in the console. Every
  slow path (GPC, queue drain, close, tote-load-to-ready) is already instrumented.
- Console prefixes: `[MalpaPack]` general, `[MalpaPack][perf]` timings, `[MalpaPack][net]`
  the OpenReplay breadcrumbs for sandboxed requests.
- The QUEUE badge in the titlebar shows in-flight API work; it polls every 250 ms.
- If reads that worked a minute ago start returning 403 across every route, the problem is
  usually an expired upstream session, not permissions.

---

## 13. Known rough edges

- SIBP/MIBP detection is a **regex on the profile name**; renaming a profile in C7 silently
  changes behaviour.
- Metabase and Retool credentials are committed in the file.
- No offline test harness ships alongside this script, and no `window.__malpaPack` handle.
- `Session.containerTypes` is cached for the life of the tab; a container type added in C7
  mid-shift will not appear until reload.
- Sections 17/19 are stubs; §18 does not exist.
- `_mpTabPoll` (200 ms) and the boot MutationObserver run for the lifetime of the page.

---

## 14. Before you ship

1. Bump `@version`.
2. Exercise the real paths on the bench: a single-box shipment, a multi-piece shipment
   (close with items remaining), a close with the carton-scan prompt, and one deliberate
   consign failure to confirm the badge / log / ⟳ Reprint recovery.
3. Commit and push to `Malpa-3PL/Warehouse-Scripts`, then confirm the raw URL serves the new
   version — that URL is what the fleet updates from.

// ==UserScript==
// @name         Malpa Pallet Pack
// @namespace    malpa
// @version      1.9.0
// @match        https://*.canary7.com/*
// @homepageURL  https://github.com/zaynnev/malpa3pl
// @supportURL   https://github.com/zaynnev/malpa3pl/issues
// @updateURL    https://raw.githubusercontent.com/Malpa-3PL/Warehouse-Scripts/main/malpa-palletpack.user.js
// @downloadURL  https://raw.githubusercontent.com/Malpa-3PL/Warehouse-Scripts/main/malpa-palletpack.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MALPA PALLET PACK  —  blind verification + deferred pack for Canary7 WMS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  Flow (see build guide §0):
 *    1. Operator picks a packing profile.
 *    2. Operator scans a shipment number (Pack Pending / status 5). Every line is
 *       loaded into a LOCAL cache (required base qty, UOM factors, barcodes, weights).
 *    3. Operator BLIND-scans every physical unit. Outer-UOM barcodes count by their
 *       `factor` (one outer scan = +48 base units). Nothing on screen reveals the
 *       required counts.
 *    4. Operator taps Close Container per physical box (enters weight/dimensions).
 *    5. Operator taps Finish Verification.
 *
 *  *** NO C7 WRITE CALLS FIRE UNTIL FINISH. ***  Scanning, container boundaries and
 *  weight/dim entry are all local. At Finish the script does a local total-vs-required
 *  match:
 *    • MISMATCH → show the diff, reset scanned state, restart (nothing committed).
 *    • MATCH    → commit per container (create → move/pack children → close), which
 *                 leaves the shipment at Consigning Pending (status 7).
 *
 *  This script NEVER calls create-consignment-pieces. The desk consigns.
 *
 *  Scaffolding lifted from Malpa Pick v4.8.9 (session/nav/focus/audio) and
 *  Malpa Pack v3.3.78 (APIQueue + create/move/pack-short-v2/close call shapes).
 *
 *  v1.2.3 — Shell is a fixed overlay pinned to C7's content area. We never reparent or
 *  restyle C7's own chrome, so its tabs cannot break.
 *
 *  ------------------------------------------------------------------------------
 *  v1.9.0 — two additions to View scanned. Nothing was removed: every v1.8.0 path,
 *  function and screen is still present and still behaves the same.
 *
 *  (1) PER-CONTAINER TOTAL. Each container group in View scanned now carries its total
 *      unit count on the header (known lines plus unexpected scans at their own factor,
 *      via the existing unitsIn()). No new disclosure on a blind screen — it is the sum
 *      of the per-item totals already printed underneath it.
 *
 *  (2) UNVERIFY FROM A CLOSED CONTAINER. Previously only the open box was correctable, so
 *      an over-count that had already been boxed could only be fixed by resetting the
 *      whole order. "Closed" here is a purely LOCAL boundary — the container does not
 *      exist in Canary7, nothing has been moved into it and no weight has been sent, all
 *      of which happens at Finish — so there is nothing remote to get out of step with.
 *
 *      `unverify` / `unverifyUnexpected` are untouched and still exported; the new
 *      `unverifyIn` / `unverifyUnexpectedIn` take the container explicitly and are what
 *      View scanned now calls. The row builders gained an optional trailing `box`
 *      argument, so their old 4-argument shape still resolves to the open container.
 *
 *      Three things taking units out of a closed box has to keep straight:
 *        • the shipment-wide item total drops by the same amount, so the box ledger still
 *          sums to it — that is the invariant commit packs from;
 *        • its keyed weight is reduced by the weight of what came out, so the figure sent
 *          to close-to-container still describes the box. An estimate from item weights;
 *          boxes with no weight keyed, or items with no weight on file, are left alone;
 *        • a box emptied completely is dropped and the rest renumbered, or commit would
 *          create and close an empty pallet in Canary7.
 *
 *      A container that DOES exist in Canary7 — a commit that part-failed — is refused:
 *      that stock has really moved and cannot be un-moved from here (containerIsLocal).
 *
 *  ------------------------------------------------------------------------------
 *  v1.8.0 — PARTIAL RESCAN on a failed verification, for allow-listed companies only
 *  (currently just 49 / Bprimal — see PARTIAL_RESCAN_COMPANY_IDS).
 *
 *  Before: any mismatch reset the entire order. On a pallet of several hundred units one
 *  miscount cost the operator the whole re-scan, which is its own source of error.
 *
 *  Now the failure screen also offers "Clear & re-scan these N items": the counts for the
 *  SKUs that failed are cleared, every SKU that matched keeps its count, and the operator
 *  re-scans just those few lines from zero. Both directions are cleared, over and under —
 *  a short count is no evidence that the units already tallied went onto the right SKU, so
 *  a line that failed gets a clean re-count rather than arithmetic on a number we just
 *  proved wrong. The report still shows the size and direction of each error, which it
 *  already did before this version.
 *
 *  This is safe to do freely because NOTHING has reached Canary7 at this point: no
 *  container exists, no child has been moved, no weight has been sent. The entire ledger is
 *  local until Finish. So there are only two interlocks — the company allow-list, and the
 *  one case where that premise breaks: a commit that part-failed and left real containers
 *  behind, after which the full reset is the only option. Both re-checked on tap.
 *
 *  Three things the reset has to keep straight, none of them optional:
 *    • the cleared SKUs come out of every container's line map, or commit would move units
 *      that no item total credits;
 *    • a closed box left with nothing is dropped, or commit would create and close an empty
 *      pallet in Canary7;
 *    • a closed box that merely changed has its keyed weight reduced by the weight of what
 *      came out, so the figure sent to close-to-container still describes the box. An
 *      estimate from item weights; boxes with no item weights on file are left untouched.
 *  Unexpected/unknown barcodes are always cleared wholesale — they are keyed by barcode,
 *  not by item, so there is no per-SKU line to be selective about.
 *
 *  If any closed box holds units of a cleared SKU, the screen names those boxes so the
 *  operator can get the units out before re-scanning them.
 *
 *  Every other company sees exactly the v1.7.1 screen, wording and single button.
 *
 *  v1.7.1 — three field defects fixed (v1.7.0), then hardened after an independent code
 *  review (v1.7.1). v1.7.0 was never released; 1.7.1 is the first build of this work to
 *  reach the fleet. Each root cause was reproduced in the code and the API behaviour
 *  behind it re-probed live (warehouse 10, read-only) before patching.
 *
 *  (1) OPENED IN A SQUEEZED RIGHT-HAND COLUMN until the operator tapped the tab.
 *      positionRoot() measured `.sidebar`'s right edge at the exact moment the operator
 *      tapped the sidebar launcher - i.e. while the drawer was still OPEN and overlaying
 *      the content - and pinned `left` to it (~62% of a TC51 screen), leaving `right:0`.
 *      Nothing re-measured afterwards: the only MutationObserver watched <body class>,
 *      and C7 collapses the drawer by toggling a class on the sidebar itself, so the
 *      stale `left` survived until a tab-chip tap happened to re-run positionRoot -
 *      exactly the reported workaround.
 *      Fix: measure C7's TAB BAR, then div.tab-content, and only fall back to the
 *      sidebar. Both sit INSIDE the content area, so their left edge IS the content's
 *      left edge in either layout: a docked sidebar pushes them, an overlaying drawer
 *      does not. A sanity gate rejects any measurement that would leave the panel under
 *      60% of the viewport or under 280px; a settle schedule re-measures while the
 *      drawer animates; observers now watch the sidebar element, the tab bar,
 *      <html>/<body> classes, transitionend and visualViewport.
 *
 *  (2) "SESSION EXPIRED" WHILE THE SESSION WAS DEMONSTRABLY ALIVE, mostly on
 *      "View scanned". That screen is the only one that calls the item lookup on a
 *      DIFFERENT host - the general microservice at malpa.canary7.com/general/... -
 *      and ANY 401 from it ran _showSessionExpired(), whose Dismiss then wiped the
 *      operator's entire blind scan, while every packing call on stgauth kept working.
 *      Two amplifiers: C7 intermittently answers a rotating JWT with HTTP 500
 *      {"message":"jwt expired"} (re-confirmed live - the same GET failed twice, then
 *      succeeded unchanged), and Angular rotates the token silently, so a call in
 *      flight across a rotation draws a 401 that means nothing.
 *      Fix: the barcode lookup now uses `configuration/item&reference=` on the SAME
 *      monolith base every other call already authenticates against, with the
 *      microservice kept only as a fallback. Auth failures are classified in ONE place:
 *      retry once if the token rotated mid-flight, then PROBE the API before claiming
 *      expiry, and never let a non-critical lookup raise the modal at all. The sentinel
 *      is now err.code === 'SESSION_EXPIRED' (a message-string test and an
 *      err.status === 401 test disagreed, so a queued 401 was retried three times
 *      behind an already-visible modal). Dismiss no longer destroys the scan: nothing
 *      is committed until Finish, so the local cache stays valid across a re-login.
 *
 *  (3) AN OFF-SHIPMENT OUTER COUNTED AS 1, NOT 48. Unexpected barcodes were tallied as
 *      raw scan events because only the shipment's own UOMs were indexed. They are now
 *      resolved (deduped, one call per distinct barcode, fire-and-forget so the scan
 *      path stays synchronous) to the exact UOM whose reference matches, and counted
 *      scans x factor. This also CLOSES A BLIND-VERIFICATION LEAK: an expected outer
 *      moved the units pill by 48 while an unexpected one moved it by 1, which told the
 *      operator they had scanned the wrong thing.
 *
 *  Live probes behind this build (read-only, warehouse 10):
 *    GET index.php?r=configuration/item&reference=<barcode>
 *        &expand=itemUnitOfMeasures.unitOfMeasure,itemUnitOfMeasures.itemUnitOfMeasureReference
 *      -> 200 [{ id, item_code, description, itemUnitOfMeasures:[{ id, factor,
 *              unitOfMeasure:{name}, itemUnitOfMeasureReference:[{reference}] }] }]
 *      -> ARSBSRDSP resolves Each/1, Inner/6, Outer/48.
 *      -> The reference match is EXACT (a truncated barcode returns []), unlike
 *         configuration/location, which prefix-matches.
 *      -> An unknown reference returns 200 [].
 *      -> Some references carry dirty quoting, so both sides are normalised (quotes and
 *         whitespace stripped, upper-cased) before comparison.
 *    index.php?r=item/item does NOT exist on the monolith (Yii InvalidRouteException);
 *      configuration/item is the route.
 *
 *  Hardening added in the 1.7.1 review round, each with a regression test:
 *    - The session-expiry "already showing?" test is the DOM, not a boolean. A boolean
 *      survived the next render()'s innerHTML rewrite and latched ON forever, after
 *      which no expiry could ever be reported again. initData() now recognises the
 *      sentinel instead of rendering over its own modal.
 *    - An expiry during commit no longer strands the operator on a spinner whose X had
 *      no listener (renderCommitting never called wireHeader) — it returns to the scan
 *      screen with the closed containers intact.
 *    - The retry queue now retries ONLY transport failures and gateway codes
 *      (408/429/502/503/504). Canary7 delivers business rejections as HTTP 500 with a
 *      numeric code; retrying one re-fires a mutation against live stock.
 *    - The barcode lookup sends the RAW scanned string (the reference match is exact,
 *      so upper-casing it could miss), and caches on the normalised key. A lookup that
 *      errors is capped at 2 attempts instead of re-firing two hosts on every scan.
 *    - The units pill is repainted on the same fixed delay for a hit and a miss, so a
 *      pill that visibly self-corrects cannot become the new tell (see
 *      scheduleScanMetaUpdate).
 *    - Closing a container counts unexpected units in its empty-box guard, so the
 *      refusal message can no longer contradict the pill and reveal a bad box.
 *    - barcodeIndex keeps the EXACT code authoritative and the normalised form as a
 *      weak alias, so two items whose codes differ only by whitespace can never
 *      collapse onto one key and credit the wrong stock.
 *    - wireReposition() unwires first (openUI is reachable again if Angular removes our
 *      root); transitionend is filtered to the drawer itself; the measurement gates use
 *      the LAYOUT viewport so the panel does not jump when the soft keyboard opens.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

(function () {
  'use strict';

  // ===========================================================================
  // 0. CONSTANTS  (build guide §4/§5 — confirm production values before rollout)
  // ===========================================================================

  // API host: same as Malpa Pick v4.8.9 / Pack v3.3.78. On production the UI at
  // malpa.canary7.com is a static Angular app (S3/CloudFront — calling index.php
  // there returns an XML AccessDenied 403); the Canary7 API itself is served from
  // stgauth.canary7.com, which is what both proven sibling scripts call.
  const VERSION          = '1.9.0';   // keep in step with @version or the fleet won't update
  const API_BASE         = 'https://stgauth.canary7.com/index.php?r=';
  const WAREHOUSE_ID     = 10;      // guide §5 — HAR shows 10; CONFIRM for production
  const PACK_LOCATION_ID = 72037;   // guide §3 D5 / §5 — packing/close location (code WDD-02); per-station constant, CONFIRM

  // Companies whose failed verification clears ONLY the mismatched item counts and lets the
  // operator re-scan those items, instead of resetting the whole order (v1.8.0).
  //   49 = Bprimal — confirmed read-only against legacy `configuration/company`
  //        (2026-08-19) and cross-checked on shipment BP100932, whose
  //        shipmentHeader.company_id came back as 49.
  const PARTIAL_RESCAN_COMPANY_IDS = new Set([49]);

  // get-pack-container expand for the commit context resolve (guide §3 D4)
  const PP_GPC_EXPAND = [
    'shipmentHeader', 'jobInstruction',
    'shipmentDetailChildren.shipmentDetail.item.itemUnitOfMeasures.unitOfMeasure',
    'shipmentDetailChildren.itemUnitOfMeasure',
  ].join(',');

  const LOG = (...a) => console.log('[MalpaPalletPack]', ...a);
  const WARN = (...a) => console.warn('[MalpaPalletPack]', ...a);

  // ===========================================================================
  // 1. AUTH + API LAYER  (copied from Pick §1)
  // ===========================================================================

  // Strip a Bearer prefix and JSON quoting before use: a value stored as `"eyJ..."`
  // is sent as `Bearer "eyJ..."` and draws a 401 that looks exactly like an expiry.
  function getToken() {
    for (const store of [localStorage, sessionStorage]) {
      try {
        for (const key of ['access_token', 'token', 'id_token', 'auth_token']) {
          const v = store.getItem(key);
          if (v && v.length > 20) {
            return v.trim().replace(/^Bearer\s+/i, '').replace(/^"|"$/g, '');
          }
        }
      } catch (_) {}
    }
    return null;
  }

  let _sessionId = null;

  function captureSessionId() {
    if (_sessionId) return;
    // Check storage first for a numeric session/shift value
    for (const store of [localStorage, sessionStorage]) {
      try {
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          const val = store.getItem(key);
          if (
            key &&
            (key.toLowerCase().includes('session') || key.toLowerCase().includes('shift')) &&
            val && /^\d+$/.test(val.trim())
          ) {
            _sessionId = val.trim();
            return;
          }
        }
      } catch (_) {}
    }
    // Intercept the next Angular XHR to steal x-session-id from its headers
    if (!window._mppXHRPatched) {
      window._mppXHRPatched = true;
      const origSet = XMLHttpRequest.prototype.setRequestHeader;
      XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        if (name.toLowerCase() === 'x-session-id' && value && !_sessionId) {
          _sessionId = String(value);
          XMLHttpRequest.prototype.setRequestHeader = origSet;
          window._mppXHRPatched = false;
        }
        return origSet.call(this, name, value);
      };
    }
  }

  function mkHeaders(extra = {}) {
    const h = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${getToken()}`,
      'x-warehouse-id': String(WAREHOUSE_ID),
      ...extra,
    };
    if (_sessionId) h['x-session-id'] = _sessionId;
    return h;
  }

  async function waitForSession() {
    if (_sessionId) return;
    captureSessionId();
    for (let i = 0; i < 5 && !_sessionId; i++) {
      await new Promise(r => setTimeout(r, 50));
    }
  }

  // ── AUTH FAILURE CLASSIFICATION (v1.7.0) ──────────────────────────────────
  // A 401 from Canary7 is a QUESTION, not an answer. Two non-expiry causes are
  // routine on the floor and both used to raise the expiry modal:
  //   • Angular rotates the access token in the background. A call already in
  //     flight across the rotation returns 401 while the next call succeeds.
  //   • The monolith intermittently answers with HTTP 500 {"message":"jwt expired"}
  //     and then serves the identical request unchanged seconds later (re-confirmed
  //     live while preparing this build).
  // So: retry once if the token moved, then ASK the API whether the session is dead,
  // and only then tell the operator it is.
  function _isAuthFailure(status, body) {
    if (status === 401) return true;
    const m = String((body && (body.message || body.error)) || '');
    return status >= 500 && /jwt|token|unauthor/i.test(m) && /expire|invalid|missing/i.test(m);
  }

  function _mkError(status, body, fallback) {
    const raw = (body && (body.message || body.error));
    const err = new Error(typeof raw === 'string' && raw ? raw : (fallback || `API error ${status}`));
    err.status = status;
    err.body = body;
    return err;
  }

  // The sentinel. Test err.code — NEVER err.message (the old message-string test and
  // the queue's err.status === 401 test disagreed, so a queued 401 was retried three
  // times behind an already-visible modal).
  function _sessionExpiredError(status) {
    const err = new Error('Session expired');
    err.code = 'SESSION_EXPIRED';
    err.status = status || 401;
    return err;
  }
  const isSessionExpired = (err) => !!err && err.code === 'SESSION_EXPIRED';

  // Cheap authenticated read whose only job is to answer "is the session really
  // dead?". Single-flight, verdict cached 5s so a burst of 401s asks once.
  // A network failure is NOT an expiry — it returns alive, so a flaky wifi moment
  // never costs the operator their scan.
  let _aliveProbe = null, _aliveVerdict = null, _aliveAt = 0, _authFailStreak = 0;
  function sessionIsAlive() {
    const now = Date.now();
    // The cache exists to stop a burst of concurrent 401s probing N times — and the
    // single-flight promise below already collapses a truly concurrent burst, so the
    // cache only ever saves a SEQUENTIAL repeat. It must not outlive its usefulness: a
    // second consecutive auth failure means the last verdict is suspect, so re-probe
    // rather than keep reporting a dead session as a transient blip. The streak is
    // cleared by any successful call and by dismissing the banner.
    if (_authFailStreak < 2 && _aliveVerdict !== null && now - _aliveAt < 5000) {
      return Promise.resolve(_aliveVerdict);
    }
    if (_aliveProbe) return _aliveProbe;
    _aliveProbe = (async () => {
      try {
        const res = await fetch(API_BASE + 'configuration/container-type&per-page=1&page=1',
                                { method: 'GET', headers: mkHeaders() });
        if (res.ok) return true;
        const body = await res.json().catch(() => ({}));
        return !_isAuthFailure(res.status, body);
      } catch (_) {
        return true;
      }
    })().then((v) => {
      _aliveVerdict = v; _aliveAt = Date.now(); _aliveProbe = null;
      LOG('session probe:', v ? 'alive' : 'dead');
      return v;
    });
    return _aliveProbe;
  }
  // Force the next auth failure to re-probe (used on dismiss, and by the harness).
  function _resetAliveProbe() { _aliveVerdict = null; _aliveAt = 0; _authFailStreak = 0; }

  // The single door every Canary7 call goes through.
  //   critical:false → a nice-to-have read (the barcode lookup). It may fail, but it
  //                    must NEVER put a session modal over the operator's screen.
  async function apiFetch(url, init = {}, opts = {}) {
    const critical = opts.critical !== false;
    const label = opts.label || url;
    await waitForSession();
    const tokenBefore = getToken();

    let res = await fetch(url, { ...init, headers: mkHeaders(init.headers || {}) });
    if (res.ok) { _authFailStreak = 0; return res.json().catch(() => ({})); }

    let body = await res.json().catch(() => ({}));
    if (!_isAuthFailure(res.status, body)) throw _mkError(res.status, body);
    _authFailStreak++;

    // 1. Did Angular rotate the token underneath us? Then this 401 means nothing.
    const tokenAfter = getToken();
    if (tokenAfter && tokenAfter !== tokenBefore) {
      LOG('auth failure with a rotated token — retrying once:', label);
      res = await fetch(url, { ...init, headers: mkHeaders(init.headers || {}) });
      if (res.ok) { _authFailStreak = 0; return res.json().catch(() => ({})); }
      body = await res.json().catch(() => ({}));
      if (!_isAuthFailure(res.status, body)) throw _mkError(res.status, body);
    }

    // 2. Ask the API before claiming the session died.
    const alive = await sessionIsAlive();
    if (alive) {
      WARN('auth-shaped failure but the session is alive — transient:',
           res.status, (body && body.message) || '', label);
      const err = _mkError(res.status, body, 'Canary7 rejected that call. Try again.');
      err.code = 'AUTH_BLIP';
      throw err;
    }
    if (critical) _showSessionExpired();
    throw _sessionExpiredError(res.status);
  }

  const apiGet = (path, opts) =>
    apiFetch(API_BASE + path, { method: 'GET' }, { label: path, ...(opts || {}) });
  const apiPost = (path, data, opts) =>
    apiFetch(API_BASE + path, { method: 'POST', body: JSON.stringify(data) },
             { label: path, ...(opts || {}) });

  // Session expiry — only reachable once sessionIsAlive() has confirmed the session
  // is genuinely dead. Dismiss no longer throws the scan away: NOTHING is committed
  // until Finish, the blind cache is entirely local, and commit re-resolves the live
  // packing context anyway — so after re-authenticating the operator can carry on
  // exactly where they were. Losing a part-scanned pallet to a transient 401 was the
  // worst part of this bug.
  // The "is it already up?" test is the DOM itself, never a boolean: every render()
  // rewrites root.innerHTML and would destroy the banner while leaving a boolean latched
  // true — after which no expiry could ever be reported again and calls would fail silently.
  function _showSessionExpired() {
    // Only report while Pallet Pack is actually ON SCREEN. The 600ms boot prefetch runs
    // with no UI at all, and a backgrounded session leaves #mpp-root in the DOM at
    // display:none — in both cases a body-mounted, inset:0 banner would cover Canary7's
    // own screen for something the operator is not currently doing. The next call they
    // make raises it again.
    const _r = document.getElementById('mpp-root');
    if (!_r || _r.style.display === 'none') return;
    if (document.getElementById('mpp-session-dismiss')) return;
    // Mounted on <body>, NOT inside #mpp-root: every render() rewrites root.innerHTML,
    // which used to destroy this banner the instant any screen repainted. It is
    // position:fixed anyway, so it lands in the same place and carries its own copy of
    // the design tokens (see .mpp-session-overlay in the CSS).
    const banner = document.createElement('div');
    banner.className = 'mpp-overlay mpp-session-overlay';
    banner.innerHTML = `
      <div class="mpp-modal" style="text-align:center">
        <div class="mpp-modal-title" style="text-align:center">🔒 Session expired</div>
        <div class="mpp-note">Canary7 signed this device out.<br>
          Log back in on another tab, then carry on — <b>nothing has been committed
          and your scans are still here</b>.</div>
        <button id="mpp-session-dismiss" class="mpp-btn mpp-btn-primary" style="margin-top:4px">Keep my scans</button>
        <button id="mpp-session-reset" class="mpp-btn mpp-btn-ghost">Start over</button>
      </div>`;
    document.body.appendChild(banner);
    const dismiss = () => { banner.remove(); _resetAliveProbe(); };
    document.getElementById('mpp-session-dismiss')?.addEventListener('click', () => {
      dismiss();
      setTimeout(_refocusScanInput, 60);
    });
    document.getElementById('mpp-session-reset')?.addEventListener('click', () => {
      if (!confirmDiscardC7Work('Starting over')) return;
      dismiss();
      resetAll();
      renderProfileSelect();
    });
  }

  // ===========================================================================
  // 2. API QUEUE  (copied from Pack §2 — concurrency-limited, retry, keyed dedupe)
  // ===========================================================================

  class APIQueue {
    constructor({ concurrency = 3, maxRetries = 3 } = {}) {
      this._concurrency = concurrency;
      this._maxRetries  = maxRetries;
      this._queue       = [];
      this._running     = 0;
      this._inFlight    = new Set();
    }
    enqueue({ key, fn, onSuccess, onFailure, priority = 0 }) {
      if (key && this._inFlight.has(key)) return Promise.resolve(null);
      if (key) this._inFlight.add(key);
      return new Promise((resolve, reject) => {
        this._queue.push({ key, fn, onSuccess, onFailure, priority, resolve, reject, attempt: 0 });
        this._queue.sort((a, b) => b.priority - a.priority);
        this._tick();
      });
    }
    _tick() {
      while (this._running < this._concurrency && this._queue.length) {
        const task = this._queue.shift();
        this._running++;
        this._run(task);
      }
    }
    async _run(task) {
      try {
        const result = await task.fn();
        if (task.key) this._inFlight.delete(task.key);
        task.onSuccess && task.onSuccess(result);
        task.resolve(result);
      } catch (err) {
        // Canary7 delivers BUSINESS rejections as HTTP 500 with a numeric code — they
        // are deterministic refusals, not transient faults, and retrying one re-fires a
        // mutation against live stock. So: retry ONLY what can plausibly succeed
        // unchanged — a transport failure (fetch threw, no status) or a gateway blip.
        // Everything with a definite HTTP status is a decision, and decisions stand.
        const s = err.status;
        const transport = s === undefined || s === null;
        const gateway = s === 502 || s === 503 || s === 504 || s === 408 || s === 429;
        const nonRetryable =
          err.code === 'SESSION_EXPIRED' ||
          err.code === 'AUTH_BLIP' ||
          (!transport && !gateway);
        task.attempt++;
        if (!nonRetryable && task.attempt < this._maxRetries) {
          const delay = 500 * Math.pow(2, task.attempt - 1);
          await new Promise(r => setTimeout(r, delay));
          this._queue.unshift(task);
        } else {
          if (task.key) this._inFlight.delete(task.key);
          task.onFailure && task.onFailure(err);
          task.reject(err);
        }
      } finally {
        this._running--;
        this._tick();
      }
    }
  }
  const Q = new APIQueue({ concurrency: 4, maxRetries: 3 });
  // Route a call through the queue and await it (retry + dedupe, but the caller
  // still serialises per container — child-split ids chain, guide §12).
  const qCall = (key, fn) => Q.enqueue({ key, fn });

  // ===========================================================================
  // 3. STATE + BLIND CACHE  (guide §8 — all local until Finish)
  // ===========================================================================

  const State = {
    screen: 'PROFILE',           // PROFILE | SHIPMENT_ENTRY | SCAN | COMMITTING | SUCCESS
    profile: null,               // chosen packing profile object
    profiles: [],
    containerTypes: [],
    containerPrefixes: [],       // [{ prefix, typeId, name }] sorted longest-first
    voiceEnabled: (() => {
      try { const v = sessionStorage.getItem('mpp_voice'); return v === null ? true : v === '1'; }
      catch (_) { return true; }
    })(),
    committing: false,           // re-entry guard for Finish/commit (guide §13/§15)
  };

  function newContainer(seq) {
    return {
      seq,
      containerNo: null,
      containerTypeId: null,
      _c7Id: null,            // C7 container id, once created (commit ledger)
      _c7ContainerNo: null,   // the number C7 actually accepted
      _c7Packed: false,       // created AND closed — never touch it again
      lines: new Map(),          // item_id -> base units placed in THIS box
      unexpected: new Map(),     // UPPER(barcode) -> count of unexpected scans in THIS box
      weight: null, length: null, width: null, height: null,
    };
  }

  // Units in a box, counted the one way: known lines plus unexpected scans at their own
  // factor. The scan-screen pill, the "don't close an empty box" check and the partial
  // reset's drop test all use this, so they cannot disagree. A 0-valued line does not keep
  // a box alive.
  function unitsIn(cont) {
    let n = 0;
    for (const v of cont.lines.values()) n += num(v);
    return n + unexpectedUnits(cont.unexpected);
  }

  const Cache = {
    shipmentNumber: null,
    shipmentHeaderId: null,
    companyId: null,             // shipmentHeader.company_id — gates the partial rescan (v1.8.0)
    items: new Map(),            // item_id -> { itemCode, description, requiredBase, scannedBase, unitWeight }
    barcodeIndex: new Map(),     // UPPER(barcode) -> { itemId, factor, uomId }
    unexpected: new Map(),       // normRef(barcode) -> scan count
    unexpectedRaw: new Map(),    // normRef(barcode) -> the exact string that was scanned
    unexpectedResolved: new Map(), // normRef(barcode) -> { itemCode, description, factor, uomName } | { unknown:true }
    containers: [],              // finalised Container boundaries
    current: null,               // the box being filled now

    reset() {
      this.shipmentNumber = null;
      this.shipmentHeaderId = null;
      this.companyId = null;
      this.items = new Map();
      this.barcodeIndex = new Map();
      this.unexpected = new Map();
      this.unexpectedRaw = new Map();
      this.unexpectedResolved = new Map();
      _unexpectedAttempts.clear();   // a new shipment gets a clean slate on the network
      this.containers = [];
      this.current = newContainer(1);
    },
    // Reset only scanned state (guide §13) — keep item requirements + barcodeIndex.
    // unexpectedResolved is a pure barcode→UOM fact, not scan state, so it is kept:
    // re-scanning the same wrong carton must not re-query C7.
    resetScans() {
      for (const it of this.items.values()) it.scannedBase = 0;
      this.unexpected = new Map();
      this.containers = [];
      this.current = newContainer(1);
    },
    // PARTIAL reset (v1.8.0) — clear the counts for the items that failed to match and
    // leave every item that DID match alone, so the operator re-scans those few SKUs from
    // zero instead of the whole pallet.
    //
    // Safe to do freely because nothing here has reached Canary7: no container exists, no
    // child has been moved, no weight has been sent. The whole ledger is local until
    // Finish. (`partialRescanAvailable` still refuses the one case where that is no longer
    // true — a commit that part-failed and left real containers behind.)
    //
    // Both directions are cleared, over and under. A short count is not evidence that the
    // units already tallied went onto the right SKU, so the only honest reset for a line
    // that failed is a clean re-count from zero.
    //
    // Three consequences that are NOT optional bookkeeping:
    //  • The zeroed SKUs come out of every container's line map too. Those maps are what
    //    commit packs box by box; leaving a stripped SKU in one would have commit move
    //    units no item total credits.
    //  • A closed box left with nothing is dropped, or commit would create and close an
    //    empty pallet in Canary7.
    //  • A closed box that merely changed has its keyed weight reduced by the weight of
    //    what came out, so the figure sent to close-to-container still describes the box.
    //    An estimate from item weights, but strictly better than a weight that includes
    //    units no longer in there. Boxes with no item weights on file are left alone.
    //
    // The OPEN box is kept, not replaced: its surviving lines are physically in that
    // carton, and the re-scans belong there too.
    resetMismatchedScans(itemIds) {
      const ids = new Set(itemIds);
      for (const id of ids) {
        const it = this.items.get(id);
        if (it) it.scannedBase = 0;
      }
      const dropped = [];
      const adjusted = [];
      for (const c of this.containers) {
        let touched = false;
        let removedWeight = 0;
        for (const id of ids) {
          const base = c.lines.get(id);
          if (base === undefined) continue;
          const it = this.items.get(id);
          removedWeight += num(base) * ((it && it.unitWeight) || 0);
          c.lines.delete(id);
          touched = true;
        }
        if (!touched) continue;
        if (unitsIn(c) <= 0) { dropped.push(c); continue; }
        if (num(c.weight) > 0 && removedWeight > 0) {
          c.weight = Math.max(0, Math.round((num(c.weight) - removedWeight) * 100) / 100);
          adjusted.push(c);
        }
        c.unexpected = new Map();
        }
      const drop = new Set(dropped);
      this.containers = this.containers.filter(c => !drop.has(c));
      this.containers.forEach((c, i) => { c.seq = i + 1; });
      // Unexpected/unknown barcodes are cleared wholesale, never selectively: they are
      // keyed by barcode, not by item, so there is no per-SKU line to be selective about.
      this.unexpected = new Map();
      for (const id of ids) this.current.lines.delete(id);
      this.current.unexpected = new Map();
      this.current.seq = this.containers.length + 1;
      LOG('partial reset — cleared', ids.size, 'item(s);', dropped.length, 'box(es) dropped;',
          adjusted.length, 'box weight(s) adjusted');
      return { itemIds: [...ids], dropped, adjusted };
    },
  };

  // Full reset back to shipment entry (keeps profile selected — guide §13)
  function resetForNextShipment() {
    Cache.reset();
    State.committing = false;
    renderShipmentEntry();
  }
  // Full reset back to profile select
  function resetAll() {
    Cache.reset();
    State.committing = false;
    State.screen = 'PROFILE';
  }

  // ===========================================================================
  // 4. AUDIO / VOICE  (copied from Pick §Audio — minimal so nothing leaks counts)
  // ===========================================================================

  const Audio = {
    _ctx: null,
    init() {
      if (this._ctx) return;
      try { this._ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { WARN('AudioContext unavailable:', e.message); }
    },
    _tone(freq, duration, type = 'sine', gainVal = 0.4, startDelay = 0) {
      if (!this._ctx) return;
      try {
        const osc = this._ctx.createOscillator();
        const gain = this._ctx.createGain();
        osc.connect(gain); gain.connect(this._ctx.destination);
        osc.type = type;
        osc.frequency.setValueAtTime(freq, this._ctx.currentTime + startDelay);
        gain.gain.setValueAtTime(gainVal, this._ctx.currentTime + startDelay);
        gain.gain.exponentialRampToValueAtTime(0.001, this._ctx.currentTime + startDelay + duration);
        osc.start(this._ctx.currentTime + startDelay);
        osc.stop(this._ctx.currentTime + startDelay + duration);
      } catch (e) { /* ignore */ }
    },
    chime(type) {
      this.init();
      if (!this._ctx) return;
      if (this._ctx.state === 'suspended') this._ctx.resume();
      if (type === 'scan')        { this._tone(880, 0.12, 'sine', 0.32, 0); }              // every scan (blind — same for hit/miss)
      else if (type === 'ok')     { this._tone(660, 0.12, 'sine', 0.3, 0); this._tone(880, 0.2, 'sine', 0.4, 0.13); }
      else if (type === 'error')  { this._tone(180, 0.08, 'square', 0.3, 0); this._tone(180, 0.08, 'square', 0.3, 0.12); }
    },
  };

  const Voice = {
    speak(text) {
      if (!State.voiceEnabled || !window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text));
      u.rate = 1.7; u.pitch = 1.0; u.volume = 1.0;
      window.speechSynthesis.speak(u);
    },
    // Errors bypass the mute toggle
    error(text) {
      if (!window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text));
      u.rate = 1.6; u.pitch = 1.0; u.volume = 1.0;
      window.speechSynthesis.speak(u);
    },
  };

  function vibrate(pattern) { if (navigator.vibrate) try { navigator.vibrate(pattern); } catch (_) {} }

  // ===========================================================================
  // 5. HELPERS
  // ===========================================================================

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // Shipment number encoding for query strings (## → %23%23, guide §7)
  function encShip(num) { return String(num).trim().replace(/#/g, '%23'); }

  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

  // Barcode/reference normalisation — ONE definition, used on both sides of every
  // comparison. C7's own reference rows carry dirty quoting (a live row for
  // ARSBSRDSP reads `"""0129351262016618"`) and a scanner can deliver stray
  // whitespace, so neither side is trusted raw.
  function normRef(v) { return String(v == null ? '' : v).replace(/["'\s]/g, '').toUpperCase(); }

  // Longest-prefix container-type match (guide §14)
  function containerTypeFromNumber(no) {
    const up = String(no || '').trim().toUpperCase();
    if (!up) return null;
    for (const p of State.containerPrefixes) {   // already sorted longest-first
      if (p.prefix && up.startsWith(p.prefix)) return p;
    }
    return null;
  }

  // ===========================================================================
  // 6. DATA FETCHES  (guide §6/§7)
  // ===========================================================================

  async function fetchProfiles() {
    // Need verifications[] (guide §2.3 verification id 4) + jobTypes + container flags
    const data = await apiGet(
      'configuration/shipment-packing-profile' +
      '&expand=verifications,jobTypes&per-page=100&page=1'
    );
    return Array.isArray(data) ? data : (data?.items || []);
  }

  async function fetchContainerTypes() {
    const data = await apiGet('configuration/container-type&per-page=100&page=1');
    return Array.isArray(data) ? data : (data?.items || []);
  }

  let _initStarted = false;
  async function initData() {
    if (_initStarted && State.profiles.length) return;
    _initStarted = true;
    try {
      const [profiles, types] = await Promise.all([fetchProfiles(), fetchContainerTypes()]);
      State.profiles = profiles || [];
      State.containerTypes = types || [];
      buildContainerPrefixes();
      LOG('initData OK — profiles:', State.profiles.length, 'types:', State.containerTypes.length);
      if (State.screen === 'PROFILE') renderProfileSelect();
    } catch (err) {
      WARN('initData failed:', err.message);
      _initStarted = false;
      // On an expiry the modal is already up — re-rendering here would wipe it.
      if (isSessionExpired(err)) return;
      if (State.screen === 'PROFILE') renderProfileSelect('Could not load profiles: ' + err.message);
    }
  }

  function buildContainerPrefixes() {
    State.containerPrefixes = State.containerTypes
      .map(ct => ({
        prefix: (ct.container_number_prefix || '').toUpperCase(),
        typeId: ct.id,
        name: ct.name || ct.description || `Type ${ct.id}`,
      }))
      .filter(p => p.prefix)
      .sort((a, b) => b.prefix.length - a.prefix.length);   // longest-prefix-match
  }

  // True when the selected profile only accepts UOM-reference barcodes (guide §2.3, id 4)
  function profileOnlyAcceptsReference() {
    const v = State.profile?.verifications || [];
    return v.some(x => (x.id ?? x.verification_id) === 4 || /only accept reference/i.test(x.name || ''));
  }

  // ===========================================================================
  // 7. SHIPMENT LOAD  (guide §7 — widened expand/fields, build blind cache §8)
  // ===========================================================================

  async function loadShipment(shipmentNumber) {
    const enc = encShip(shipmentNumber);
    const expand = [
      'shipmentHeader',
      'item.itemUnitOfMeasures.unitOfMeasure',
      'item.itemUnitOfMeasures.itemUnitOfMeasureReference',
    ].join(',');
    const fields = [
      'id', 'quantity', 'original_qty',
      'shipment_header.id', 'shipment_header.shipment_number',
      'shipment_header.leading_status_id', 'shipment_header.company_id',
      'item.id', 'item.item_code', 'item.description',
      'item.itemUnitOfMeasures.id', 'item.itemUnitOfMeasures.factor',
      'item.itemUnitOfMeasures.weight', 'item.itemUnitOfMeasures.unitOfMeasure.name',
      'item.itemUnitOfMeasures.itemUnitOfMeasureReference.reference',
    ].join(',');

    const data = await apiGet(
      `shipment/shipment-detail&shipment_number=${enc}` +
      `&expand=${expand}&fields=${fields}&per-page=200&page=1`
    );
    const lines = Array.isArray(data) ? data : (data?.items || []);
    if (!lines.length) { const e = new Error('Shipment not found.'); e.code = 'NOT_FOUND'; throw e; }

    // Guard on the SHIPMENT-HEADER leading status (the authoritative "Pack Pending"
    // signal — guide §7/§15). Detail rows don't reliably carry a leading status, so
    // reading it per-line gave false negatives. Only block when we can POSITIVELY
    // read a status that isn't 5; if it's absent, proceed rather than false-block.
    // C7 returns an EXPANDed relation under its camelCase name (`shipmentHeader`),
    // not `shipment_header`. Reading the snake_case key left shipmentHeaderId undefined,
    // so the create body omitted shipment_header_id → the container had no shipment
    // link → close-to-container 500'd on `shipmentHeader->statusFlow`. Read camelCase
    // first, snake_case as a fallback.
    const hdr = lines[0].shipmentHeader || lines[0].shipment_header || {};
    const rawStatus = hdr.leading_status_id ?? hdr.leadingStatus?.id ?? hdr.leadingStatus;
    const status = (rawStatus === undefined || rawStatus === null || rawStatus === '')
      ? null : Number(rawStatus);
    if (status !== null && status !== 5) {
      const e = new Error(`Shipment is not Pack Pending — current status ${status}. Cannot load.`);
      e.code = 'BAD_STATUS';
      throw e;
    }
    if (status === null) WARN('Could not read shipment leading status from detail response — proceeding.');

    // Build the blind cache (guide §8)
    Cache.reset();
    Cache.shipmentNumber = hdr.shipment_number || shipmentNumber;
    Cache.shipmentHeaderId = hdr.id;
    // Company decides whether a failed verification clears only the mismatched counts
    // (v1.8.0). C7 returns the whole expanded shipmentHeader regardless of `fields`, so
    // company_id is already in this payload; it is named in `fields` above only to record
    // the dependency. Number('') and Number(null) are both 0 — finite — so isFinite alone
    // would turn an empty field into "company 0" with nothing in the log.
    const rawCompany = hdr.company_id;
    const parsedCompany = (rawCompany === undefined || rawCompany === null || rawCompany === '')
      ? NaN : Number(rawCompany);
    Cache.companyId = Number.isFinite(parsedCompany) ? parsedCompany : null;
    if (Cache.companyId === null) {
      WARN('shipment_header company_id not readable (got', JSON.stringify(rawCompany) +
           ') — partial rescan disabled for this shipment.');
    }
    if (Cache.shipmentHeaderId == null) WARN('shipment_header id not found in load response — create/close will fail.');

    const onlyRef = profileOnlyAcceptsReference();
    let uomModelMissing = false;

    for (const ln of lines) {
      const item = ln.item || {};
      const itemId = item.id ?? item.item_code;
      if (itemId == null) continue;
      const uoms = item.itemUnitOfMeasures || [];
      if (!uoms.length) uomModelMissing = true;

      // Aggregate required base qty by item (guide §8 — totals only, child ids volatile)
      let entry = Cache.items.get(itemId);
      if (!entry) {
        entry = {
          itemCode: item.item_code || String(itemId),
          description: item.description || '',
          requiredBase: 0,
          scannedBase: 0,
          unitWeight: computeUnitWeight(uoms),
          // UOMs (factor + name) for the View Scanned breakdown, e.g. "1 Carton of 6".
          uoms: uoms.map(u => ({ factor: num(u.factor) || 1, name: u.unitOfMeasure?.name || '' })),
        };
        Cache.items.set(itemId, entry);
      }
      entry.requiredBase += num(ln.quantity);

      // Build barcodeIndex from UOM references (guide §8).
      // TWO keys per barcode. The EXACT form (trim + upper) is authoritative. The
      // normalised form — quotes and whitespace stripped, which is what makes C7's
      // dirty reference rows scannable at all — is only ever an ALIAS: it may fill a
      // free slot, it never displaces anything, and a real code always evicts an alias.
      // Without that rule two different items whose codes differ only by whitespace
      // would collapse onto one key and a scan would credit the wrong stock.
      // `weak` = fill a free slot or displace an alias, never displace a real entry —
      // even one belonging to the SAME item. Some clients use the EAN as the SKU, so the
      // bare item_code can BE one of that item's own UOM references; overwriting it at
      // factor 1 would silently count an Outer of 24 as a single unit.
      const indexBarcode = (rawCode, entry, weak) => {
        const exact = String(rawCode == null ? '' : rawCode).trim().toUpperCase();
        if (exact) {
          const prev = Cache.barcodeIndex.get(exact);
          if (!prev || prev._alias || (!weak && prev.itemId === entry.itemId)) {
            Cache.barcodeIndex.set(exact, entry);
          } else if (weak && prev.itemId !== entry.itemId) {
            // Not a weak-write no-op: two different items really do claim this code.
            WARN('barcode claimed by two items:', exact, '->', prev.itemId, 'and', entry.itemId,
                 '— keeping the first; scans of it need checking by hand.');
          } else if (!weak) {
            WARN('barcode claimed by two items:', exact, '->', prev.itemId, 'and', entry.itemId,
                 '— keeping the first; scans of it need checking by hand.');
          }
        }
        const alias = normRef(rawCode);
        if (alias && alias !== exact && !Cache.barcodeIndex.has(alias)) {
          Cache.barcodeIndex.set(alias, { ...entry, _alias: true });
        }
      };
      for (const u of uoms) {
        const factor = num(u.factor) || 1;
        const uomId = u.id;
        for (const ref of (u.itemUnitOfMeasureReference || [])) {
          indexBarcode(ref.reference, { itemId, factor, uomId });
        }
      }
      // Bare item_code → factor 1, UNLESS profile is Only-Accept-Reference (guide §2.3)
      if (!onlyRef && item.item_code) {
        const baseUom = uoms.find(u => (num(u.factor) || 1) === 1) || uoms[0];
        indexBarcode(item.item_code, { itemId, factor: 1, uomId: baseUom?.id }, true);
      }
    }

    if (uomModelMissing) {
      // Guide §7 fallback note: if the widened expand/fields don't return UOM data,
      // the per-item factor/barcode model is incomplete. Surface it rather than
      // silently packing with a broken barcode index.
      WARN('Some lines returned no itemUnitOfMeasures — UOM factors/barcodes may be incomplete.');
    }
    LOG('Loaded shipment', Cache.shipmentNumber, '— items:', Cache.items.size,
        'barcodes:', Cache.barcodeIndex.size, 'company:', Cache.companyId,
        'partial rescan:', PARTIAL_RESCAN_COMPANY_IDS.has(Cache.companyId));
  }

  // unitWeight = base-unit (factor 1) UOM weight; else derive from an outer UOM (weight/factor)
  function computeUnitWeight(uoms) {
    const base = uoms.find(u => (num(u.factor) || 1) === 1);
    if (base && num(base.weight) > 0) return num(base.weight);
    for (const u of uoms) {
      const f = num(u.factor) || 1;
      if (num(u.weight) > 0 && f > 0) return num(u.weight) / f;
    }
    return 0;
  }

  // ---------------------------------------------------------------------------
  // 7b. BARCODE → ITEM LOOKUP  (for unexpected scans: the real item code instead of a
  //     raw barcode, AND the factor of the UOM that barcode names). READ-ONLY.
  //     Since v1.7.0 it IS called from the scan path — fire-and-forget, deduped to one
  //     call per distinct barcode. That does not leak correctness: the scan handler
  //     stays synchronous, the chime/vibration/flash are byte-identical for a hit and
  //     a miss, and the only thing the answer changes is a unit tally that is repainted
  //     on the same delay either way (see scheduleScanMetaUpdate). No write of any kind
  //     fires before Finish.
  // ---------------------------------------------------------------------------
  // The expand that carries what we need: the item AND every UOM with its factor and
  // its references, so we can tell WHICH UOM the scanned barcode belongs to.
  const ITEM_LOOKUP_QS =
    'expand=itemUnitOfMeasures.unitOfMeasure,itemUnitOfMeasures.itemUnitOfMeasureReference' +
    '&fields=id,item_code,description,itemUnitOfMeasures.id,itemUnitOfMeasures.factor,' +
    'itemUnitOfMeasures.unitOfMeasure.name,itemUnitOfMeasures.itemUnitOfMeasureReference.reference' +
    '&per-page=5&page=1';

  // PRIMARY: the monolith — the same base, and the same credentials, that every
  // packing call in this script already uses successfully.
  //
  // The previous build asked the `general` microservice on the app origin instead, and
  // a 401 from that SECOND host called _showSessionExpired() — which is why "View
  // scanned" could throw a session-expired modal over a session that was demonstrably
  // alive, and then wipe the operator's scan. Probed live before switching:
  //   index.php?r=item/item          → Yii InvalidRouteException (does not exist)
  //   index.php?r=configuration/item&reference=… → 200, item + UOM factors, exact
  //                                                match, unknown reference → [].
  // FALLBACK: the microservice, retained because it does answer this query. It is sent
  // the same expand; if it ever declines to return itemUnitOfMeasures the lookup still
  // yields the item code and simply degrades to factor 1 — the pre-1.7.0 behaviour,
  // never a wrong multiplier.
  // BOTH are critical:false — a cosmetic lookup must never take the operator's screen.
  const ITEM_LOOKUP_MICRO = 'https://malpa.canary7.com/general/api/wms/v1/item';

  async function lookupItemByReference(barcode) {
    const ref = encodeURIComponent(barcode);
    const opts = { critical: false, label: 'item-lookup' };
    let data;
    try {
      data = await apiFetch(`${API_BASE}configuration/item&reference=${ref}&${ITEM_LOOKUP_QS}`,
                            { method: 'GET' }, opts);
    } catch (e) {
      if (isSessionExpired(e)) throw e;          // no point asking the second host
      WARN('monolith item lookup failed:', e.status || '', e.message, '— trying the microservice');
      data = await apiFetch(`${ITEM_LOOKUP_MICRO}?reference=${ref}&${ITEM_LOOKUP_QS}`,
                            { method: 'GET' }, opts);
    }
    const arr = Array.isArray(data) ? data : (data?.items || []);
    return arr[0] || null;
  }

  // Which UOM does this barcode belong to? That, not the item, is what decides
  // whether one scan is 1 unit or 48 (defect 3).
  function uomForReference(item, barcode) {
    const want = normRef(barcode);
    for (const u of (item?.itemUnitOfMeasures || [])) {
      for (const r of (u.itemUnitOfMeasureReference || [])) {
        if (normRef(r.reference) === want) {
          return { factor: num(u.factor) || 1, uomName: u.unitOfMeasure?.name || '' };
        }
      }
    }
    // Resolved to the item but not to a UOM row (e.g. it matched on item_code).
    // Fall back to the base UOM — one each. Never guess a multiplier.
    const base = (item?.itemUnitOfMeasures || []).find(u => (num(u.factor) || 1) === 1);
    return { factor: 1, uomName: base?.unitOfMeasure?.name || '' };
  }
  const _unexpectedLookups = new Map();   // normRef(barcode) -> in-flight Promise (dedupe)
  const _unexpectedAttempts = new Map();  // normRef(barcode) -> failed attempts so far
  const MAX_LOOKUP_ATTEMPTS = 2;
  // `barcode` is the RAW scanned string. C7's reference match is EXACT (probed), so the
  // query must carry exactly what came off the scanner — normRef upper-cases and strips
  // characters, which is right for a cache key and wrong for the wire.
  function resolveUnexpected(barcode) {
    const key = normRef(barcode);
    if (!key) return Promise.resolve({ unknown: true, factor: 1, uomName: '' });
    if (Cache.unexpectedResolved.has(key)) return Promise.resolve(Cache.unexpectedResolved.get(key));
    if (_unexpectedLookups.has(key)) return _unexpectedLookups.get(key);
    // Give up after a couple of failures rather than re-firing two hosts on every scan
    // of a barcode C7 cannot resolve — that is a request storm on a degraded network,
    // right on the scan path.
    if ((_unexpectedAttempts.get(key) || 0) >= MAX_LOOKUP_ATTEMPTS) {
      return Promise.resolve({ unknown: true, factor: 1, uomName: '' });
    }
    const raw = String(barcode == null ? '' : barcode).trim() || key;
    const p = lookupItemByReference(raw)
      .then(item => {
        const uom = uomForReference(item, key);
        const resolved = item
          ? { itemCode: item.item_code, description: item.description || item.long_description || '',
              factor: uom.factor, uomName: uom.uomName }
          : { unknown: true, factor: 1, uomName: '' };
        Cache.unexpectedResolved.set(key, resolved);
        _unexpectedLookups.delete(key);
        // Deliberately NO repaint here. The pill is painted once per scan, on a fixed
        // delay, by scheduleScanMetaUpdate(). A late correction arriving after that
        // paint would make the number visibly jump 1 -> 48 for a miss and never for a
        // hit — the animation becomes the tell. A slow lookup therefore leaves the pill
        // low until the next scan; every screen that matters (View scanned, Close
        // Container, Finish) reads the Cache directly and is always correct.
        return resolved;
      })
      .catch(err => {
        _unexpectedLookups.delete(key);
        // An auth failure says nothing about this barcode — don't spend an attempt on it.
        const authy = isSessionExpired(err) || err.code === 'AUTH_BLIP';
        if (!authy) _unexpectedAttempts.set(key, (_unexpectedAttempts.get(key) || 0) + 1);
        WARN('barcode lookup failed for', key, '—', err.message,
             authy ? '(auth failure — no attempt spent)'
                   : `(attempt ${_unexpectedAttempts.get(key)}/${MAX_LOOKUP_ATTEMPTS})`);
        return { unknown: true, factor: 1, uomName: '' };   // show the raw barcode, count 1
      });
    _unexpectedLookups.set(key, p);
    return p;
  }

  // Units contributed by an unexpected barcode = scans x the factor of ITS UOM.
  // Until the background lookup lands we count 1 each (exactly what the old build
  // always did); the tally then corrects itself.
  function unexpectedFactor(code) {
    const r = Cache.unexpectedResolved.get(normRef(code));
    const f = r && num(r.factor);
    return f > 0 ? f : 1;
  }
  function unexpectedUnits(map) {
    let n = 0;
    for (const [code, scans] of (map || new Map())) n += scans * unexpectedFactor(code);
    return n;
  }
  // Patch every unexpected row inside `scope` (a rendered modal): swap the raw
  // barcode label for the resolved item code once the lookup returns. Falls back to
  // the barcode when C7 can't resolve it.
  function resolveUnexpectedRows(scope) {
    if (!scope) return;
    scope.querySelectorAll('[data-unex]').forEach(row => {
      const code = row.getAttribute('data-unex');
      const scans = num(row.getAttribute('data-unex-n')) || 1;
      const label = row.querySelector('.mpp-unex-label');
      resolveUnexpected(Cache.unexpectedRaw.get(code) || code).then(r => {
        if (!document.contains(row)) return;
        if (label) {
          if (r && !r.unknown && r.itemCode) {
            label.innerHTML = `<b>${_esc(r.itemCode)}</b>` +
              (r.description ? ' ' + _esc(r.description) : '') +
              ` <span class="mpp-vs-uom-f">(not on this shipment)</span>`;
          } else {
            label.innerHTML = `${_esc(code)} <span class="mpp-vs-uom-f">(unknown barcode)</span>`;
          }
        }
        // The row was painted before the factor was known. Correct the UOM line and
        // both totals now, so the operator never reads a stale "x1" for an outer.
        const factor = (r && num(r.factor) > 0) ? num(r.factor) : 1;
        const units = scans * factor;
        const line = row.querySelector('.mpp-unex-line');
        if (line) line.innerHTML = unexpectedLineHTML(scans, factor, r && r.uomName);
        const total = row.querySelector('.mpp-unex-total');
        if (total) total.textContent = String(units);
        const qty = row.querySelector('.mpp-unex-qty');
        if (qty) qty.textContent = unexpectedQtyText(scans, factor);
      });
    });
  }
  // "4 Outers (48 each)" once the factor is known, "x4" while it is not.
  function unexpectedLineHTML(scans, factor, uomName) {
    if (factor > 1) {
      const nm = _esc(_plural(uomName || 'Unit', scans));
      return `${scans} ${nm} <span class="mpp-vs-uom-f">(${factor} each)</span>`;
    }
    return `&times;${scans}`;
  }
  function unexpectedQtyText(scans, factor) {
    return factor > 1
      ? `unexpected \u00d7${scans} = ${scans * factor} units`
      : `unexpected \u00d7${scans}`;
  }

  // ===========================================================================
  // 8. SCAN HANDLING  (guide §9 — client-side only, never fires an API call)
  // ===========================================================================

  function onScan(raw) {
    if (State.screen === 'SHIPMENT_ENTRY') { onShipmentScan(raw); return; }
    if (State.screen !== 'SCAN') return;

    // Exact first, normalised alias second — the same precedence the index was built
    // with, so an item whose code legitimately contains a space can never be resolved
    // through another item's alias.
    const exact = String(raw == null ? '' : raw).trim().toUpperCase();
    const code = normRef(raw);
    if (!code) return;

    const hit = Cache.barcodeIndex.get(exact) || Cache.barcodeIndex.get(code);
    if (hit) {
      const it = Cache.items.get(hit.itemId);
      if (it) it.scannedBase += hit.factor;
      Cache.current.lines.set(hit.itemId, (Cache.current.lines.get(hit.itemId) || 0) + hit.factor);
    } else {
      // Unknown — record as unexpected. Track it BOTH shipment-wide (for the Finish
      // report, which it guarantees fails) AND in the current box, so it counts toward
      // this container's units and can be unverified. Same success feedback (stay
      // blind, never signal wrong). (guide decision #2)
      Cache.unexpected.set(code, (Cache.unexpected.get(code) || 0) + 1);
      Cache.current.unexpected.set(code, (Cache.current.unexpected.get(code) || 0) + 1);
      Cache.unexpectedRaw.set(code, String(raw).trim());   // exact string for the wire
      // Resolve this barcode's real UOM factor in the background — deduped, so one
      // call per distinct barcode for the life of the shipment. Fire-and-forget: the
      // scan path stays synchronous and the feedback below is unchanged, so nothing
      // about it tells the operator whether the scan was expected. It only stops an
      // off-shipment OUTER being counted as a single unit (defect 3) — and it closes
      // a blind-verification leak, because the units pill used to jump by 48 for an
      // expected outer and by 1 for an unexpected one.
      resolveUnexpected(Cache.unexpectedRaw.get(code));
    }
    // Identical feedback for hit and miss — do NOT leak correctness
    Audio.chime('scan');
    vibrate([30]);
    flashScan();
    scheduleScanMetaUpdate();
  }

  // ===========================================================================
  // 9. UI SHELL / SCREENS
  // ===========================================================================

  function root() { return document.getElementById('mpp-root'); }

  const _SCAN_SCREENS = { SHIPMENT_ENTRY: 'mpp-ship-in', SCAN: 'mpp-scan-in' };

  // ── True-tab shell ────────────────────────────────────────────────────────
  // Pallet Pack lives as a FIXED overlay pinned to the C7 content area (below the tab
  // bar, right of the sidebar). We NEVER touch C7's own tabs or panes — clicking a
  // native tab just HIDES our overlay (C7 shows its content underneath); clicking our
  // tab chip or the sidebar launcher SHOWS it again with all state intact. Because we
  // never mutate C7's DOM, there is no tab "bounce" and no blank native menus. The only
  // real teardown is × / Esc → closeUI().
  let _mppRepositionObserver = null;
  let _mppResizeObserver = null;
  let _mppSettleTimers = [];
  let _mppSidebarEl = null;
  let _mppOnTransitionEnd = null;

  // ── Where does C7's content area actually start? (v1.7.0) ─────────────────
  // Measure something INSIDE the content column, never the sidebar. C7's tab bar and
  // div.tab-content both live in that column, so their LEFT edge is the content's
  // left edge under either layout: a docked sidebar pushes them across, an overlaying
  // drawer leaves them where they are.
  //
  // The old code measured the sidebar's RIGHT edge — and the one moment it was
  // guaranteed to measure it wrongly was the moment the operator tapped the sidebar
  // launcher, because the drawer was still open and covering ~62% of a TC51 screen.
  // The panel was pinned into the strip left over, and nothing re-measured until a
  // tab-chip tap happened to call this again. Hence "click the tab to fix it".
  //
  // Every candidate must survive a sanity gate: whatever is left has to be a usable
  // panel (>= 60% of the viewport and >= 280px). An open drawer cannot pass it, which
  // is the entire point.
  function measureChrome() {
    // Gate on the LAYOUT viewport: getBoundingClientRect is in layout coordinates, and
    // mixing in visualViewport.height made the panel jump the moment the soft keyboard
    // opened during weight/dimension entry.
    const de = document.documentElement || {};
    const vw = Math.round(de.clientWidth || window.innerWidth || 0);
    const vh = Math.round(de.clientHeight || window.innerHeight || 0);
    if (!vw || !vh) return { top: 0, left: 0 };
    const minWidth = Math.max(280, Math.round(vw * 0.6));
    const sane = (b) => b && b.width > 0 && b.left >= 0 && b.left < vw &&
                        b.top >= 0 && b.top < vh * 0.5 && (vw - b.left) >= minWidth;

    // (a) The tab bar — the best anchor: it yields the left edge AND the top in one go.
    const tabBar = document.querySelector('ul.nav.nav-tabs[role="tablist"]');
    if (tabBar) {
      const b = tabBar.getBoundingClientRect();
      if (sane(b) && b.bottom > 0 && b.bottom < vh * 0.5) {
        return { top: Math.round(b.bottom), left: Math.round(b.left) };
      }
      if (sane(b)) return { top: 0, left: Math.round(b.left) };   // bar is tall/wrapped
    }
    // (b) The tab-content pane — same column, no bottom edge to reason about.
    const pane = document.querySelector('div.tab-content');
    if (pane) {
      const b = pane.getBoundingClientRect();
      if (sane(b)) return { top: Math.round(Math.max(0, b.top)), left: Math.round(b.left) };
    }
    // (c) Last resort: a DOCKED sidebar, and only if a usable panel remains beside it.
    const sidebar = document.querySelector('div.sidebar, .sidebar');
    if (sidebar) {
      const b = sidebar.getBoundingClientRect();
      if (b.width > 0 && b.right > 0 && b.right < vw && (vw - b.right) >= minWidth) {
        return { top: 0, left: Math.round(b.right) };
      }
    }
    // (d) Take the whole viewport. On a handheld, covering C7's header is correct.
    return { top: 0, left: 0 };
  }

  // Idempotent: only writes when a value actually changed, so the observers below
  // cannot thrash layout (and cannot feed themselves).
  function positionRoot() {
    const r = document.getElementById('mpp-root');
    if (!r || r.style.display === 'none') return;
    const m = measureChrome();
    const top = m.top + 'px', left = m.left + 'px';
    if (r.style.top !== top) r.style.top = top;
    if (r.style.left !== left) r.style.left = left;
    if (r.style.right !== '0px') r.style.right = '0px';
    if (r.style.bottom !== '0px') r.style.bottom = '0px';
  }

  // C7's drawer ANIMATES shut and Angular re-lays-out the tab bar a beat after a route
  // change, so one measurement at open time is never enough. Re-measure across the
  // settle window. Cheap, because each pass is a no-op unless something moved.
  function positionRootSettled() {
    positionRoot();
    _mppSettleTimers.forEach(clearTimeout);
    _mppSettleTimers = [60, 160, 320, 600, 1000].map((ms) => setTimeout(positionRoot, ms));
    if (window.requestAnimationFrame) requestAnimationFrame(positionRoot);
  }

  // Watch everything that can move the content column. The old build watched only
  // <body class>; C7 collapses its drawer by re-classing the SIDEBAR, so the one
  // event that mattered was the one event nobody was listening for.
  function wireReposition() {
    unwireReposition();   // idempotent by construction: if #mpp-root was torn out by
                          // anything other than closeUI(), openUI() lands here again
    window.addEventListener('resize', positionRootSettled);
    window.addEventListener('orientationchange', positionRootSettled);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', positionRoot);
      window.visualViewport.addEventListener('scroll', positionRoot);
    }
    const attrOpts = { attributes: true, attributeFilter: ['class', 'style'] };
    _mppRepositionObserver = new MutationObserver(() => positionRoot());
    _mppRepositionObserver.observe(document.body, attrOpts);
    _mppRepositionObserver.observe(document.documentElement, attrOpts);
    _mppSidebarEl = document.querySelector('div.sidebar, .sidebar');
    if (_mppSidebarEl) {
      _mppRepositionObserver.observe(_mppSidebarEl, attrOpts);
      // Only the drawer's own transition, not every nav-link hover inside it.
      _mppOnTransitionEnd = (e) => { if (!e || e.target === _mppSidebarEl) positionRootSettled(); };
      _mppSidebarEl.addEventListener('transitionend', _mppOnTransitionEnd);
    }
    const tabBar = document.querySelector('ul.nav.nav-tabs[role="tablist"]');
    if (tabBar) _mppRepositionObserver.observe(tabBar, { attributes: true, attributeFilter: ['class', 'style'], childList: true });
    if (window.ResizeObserver) {
      _mppResizeObserver = new ResizeObserver(() => positionRoot());
      try {
        if (_mppSidebarEl) _mppResizeObserver.observe(_mppSidebarEl);
        if (tabBar) _mppResizeObserver.observe(tabBar);
        _mppResizeObserver.observe(document.documentElement);
      } catch (_) {}
    }
  }

  function unwireReposition() {
    window.removeEventListener('resize', positionRootSettled);
    window.removeEventListener('orientationchange', positionRootSettled);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', positionRoot);
      window.visualViewport.removeEventListener('scroll', positionRoot);
    }
    _mppSettleTimers.forEach(clearTimeout);
    _mppSettleTimers = [];
    if (_mppSidebarEl && _mppOnTransitionEnd) _mppSidebarEl.removeEventListener('transitionend', _mppOnTransitionEnd);
    _mppSidebarEl = null; _mppOnTransitionEnd = null;
    if (_mppRepositionObserver) { _mppRepositionObserver.disconnect(); _mppRepositionObserver = null; }
    if (_mppResizeObserver) { _mppResizeObserver.disconnect(); _mppResizeObserver = null; }
  }

  // Ensure our "Pallet Pack" chip is in the C7 tab bar (re-added if Angular re-rendered
  // the bar while we were backgrounded). Clicking the body shows us; the × closes us.
  function ensureTabChip() {
    const tabBar = document.querySelector('ul.nav.nav-tabs[role="tablist"]');
    if (!tabBar || document.getElementById('mpp-tab-li')) return;
    const li = document.createElement('li');
    li.id = 'mpp-tab-li';
    li.className = 'nav-item ng-star-inserted';
    const a = document.createElement('a');
    a.className = 'nav-link';
    a.href = 'javascript:void(0);';
    a.setAttribute('role', 'tab');
    a.innerHTML = '<span class="mpp-tab-label">Pallet Pack</span>' +
                  '<span class="mpp-tab-x" title="Close Pallet Pack">×</span>';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (e.target.closest('.mpp-tab-x')) { e.stopPropagation(); confirmClose(); }
      else showPalletPack();
    });
    li.appendChild(a);
    tabBar.appendChild(li);
  }

  // Show our overlay (bring Pallet Pack to the front). State is untouched.
  function showPalletPack() {
    const r = document.getElementById('mpp-root');
    if (!r) return;
    ensureTabChip();
    r.style.display = 'flex';
    const chip = document.getElementById('mpp-tab-li');
    chip?.classList.add('active');
    chip?.querySelector('a.nav-link')?.classList.add('active');
    // Settled, not single-shot: the sidebar drawer the operator just tapped is still
    // open and still animating shut at this instant.
    positionRootSettled();
    setTimeout(_refocusScanInput, 60);
  }

  // Hide our overlay so C7's own tab content shows. Session stays alive in the DOM.
  function hidePalletPack() {
    const r = document.getElementById('mpp-root');
    if (!r) return;
    r.style.display = 'none';
    document.querySelector('.mpp-session-overlay')?.remove();   // don't leave it over C7
    const chip = document.getElementById('mpp-tab-li');
    chip?.classList.remove('active');
    chip?.querySelector('a.nav-link')?.classList.remove('active');
  }

  function openUI() {
    if (document.getElementById('mpp-root')) { showPalletPack(); return; }  // re-show existing session
    injectCSS();
    const overlay = document.createElement('div');
    overlay.id = 'mpp-root';
    overlay.className = 'mpp-root';
    document.body.appendChild(overlay);
    ensureTabChip();
    document.addEventListener('keydown', onGlobalKey, true);
    wireReposition();
    showPalletPack();
    if (!State.profiles.length) { initData(); renderProfileSelect('Loading profiles…'); }
    else renderProfileSelect();
  }

  function closeUI() {
    document.removeEventListener('keydown', onGlobalKey, true);
    if (_metaTimer) { clearTimeout(_metaTimer); _metaTimer = null; }
    unwireReposition();
    document.getElementById('mpp-tab-li')?.remove();
    document.querySelector('.mpp-session-overlay')?.remove();   // it lives on <body>
    document.getElementById('mpp-root')?.remove();
    resetAll();
  }

  function onGlobalKey(e) {
    if (!document.getElementById('mpp-root')) return;
    if (e.key === 'Escape') { e.preventDefault(); confirmClose(); }
  }

  // True once Canary7 holds at least one container for this shipment. After that,
  // throwing local state away is NOT a neutral act: C7 keeps the boxes, the children in
  // them are already status 7, and a fresh scan-and-commit cannot pack them again — so
  // every path that resets must say so out loud first.
  function c7HoldsContainers() { return Cache.containers.some(c => c._c7Id); }
  function confirmDiscardC7Work(action) {
    if (State.screen === 'SUCCESS') return true;   // everything is committed; nothing to lose
    if (!c7HoldsContainers()) return true;
    const n = Cache.containers.filter(c => c._c7Id).length;
    return confirm(
      `Canary7 already holds ${n} container(s) for this shipment.\n\n` +
      `${action} loses the record of which ones are done. The stock in them is already ` +
      `packed and cannot be packed again from here.\n\nCheck the shipment in C7 first. ` +
      `Continue anyway?`);
  }

  function confirmClose() {
    // Never tear the tool down mid-write: closeUI() resets state while the commit loop
    // is still awaiting, so the writes would carry on with no UI and no re-entry guard.
    // The spinner always resolves now (success or the error screen), so waiting is safe.
    if (State.committing) {
      toast('Packing is running — wait for it to finish or fail.');
      return;
    }
    // Don't lose in-progress scans — or, worse, the ledger of what C7 already holds.
    // The old gate only fired on the SCAN screen, so closing from the commit-error
    // screen (State.screen is still COMMITTING there) discarded the ledger silently.
    // A finished commit is not "work to lose": warning there is just noise on the one
    // dialog whose value depends on being rare.
    if (State.screen !== 'SUCCESS' && !confirmDiscardC7Work('Closing Pallet Pack')) return;
    const hasScans = [...Cache.items.values()].some(i => i.scannedBase > 0) || Cache.containers.length > 0;
    if (hasScans && !c7HoldsContainers() &&
        !confirm('Close Pallet Pack? Scanned (uncommitted) progress will be lost.')) return;
    closeUI();
  }

  function header(title, subtitle) {
    return `
      <div class="mpp-header">
        <div>
          <div class="mpp-title">${_esc(title)}</div>
          ${subtitle ? `<div class="mpp-subtitle">${subtitle}</div>` : ''}
        </div>
        <button class="mpp-x" id="mpp-close-btn" title="Close (Esc)">✕</button>
      </div>`;
  }
  function wireHeader() {
    document.getElementById('mpp-close-btn')?.addEventListener('click', confirmClose);
  }

  // ---- Screen 1: Profile select (guide §6) ----------------------------------
  function renderProfileSelect(msg) {
    State.screen = 'PROFILE';
    const r = root(); if (!r) return;
    const opts = State.profiles.map(p =>
      `<option value="${p.id}">${_esc(p.name || ('Profile ' + p.id))}</option>`).join('');
    r.innerHTML = `
      ${header('Pallet Pack', 'Select packing profile')}
      <div class="mpp-body">
        ${msg ? `<div class="mpp-note">${_esc(msg)}</div>` : ''}
        <label class="mpp-label">Packing profile</label>
        <select id="mpp-profile-sel" class="mpp-select">${opts || '<option>Loading…</option>'}</select>
        <button id="mpp-profile-go" class="mpp-btn mpp-btn-primary mpp-btn-lg" ${State.profiles.length ? '' : 'disabled'}>Continue</button>
      </div>`;
    wireHeader();
    if (State.profile) {
      const sel = document.getElementById('mpp-profile-sel');
      if (sel) sel.value = String(State.profile.id);
    }
    document.getElementById('mpp-profile-go')?.addEventListener('click', () => {
      const id = document.getElementById('mpp-profile-sel')?.value;
      const prof = State.profiles.find(p => String(p.id) === String(id));
      if (!prof) return;
      State.profile = prof;
      LOG('profile selected:', prof.id, prof.name, 'onlyRef:', profileOnlyAcceptsReference());
      Cache.reset();
      renderShipmentEntry();
    });
  }

  // ---- Screen 2: Shipment entry (guide §7) ----------------------------------
  function renderShipmentEntry(msg, msgType) {
    State.screen = 'SHIPMENT_ENTRY';
    const r = root(); if (!r) return;
    r.innerHTML = `
      ${header('Pallet Pack', 'Profile: ' + _esc(State.profile?.name || State.profile?.id))}
      <div class="mpp-body">
        <label class="mpp-label">Scan shipment number</label>
        <input id="mpp-ship-in" class="mpp-input mpp-scan" type="text" inputmode="none"
               autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
               placeholder="Scan / type shipment #" />
        <div id="mpp-ship-fb" class="mpp-fb ${msgType || 'dim'}">${_esc(msg || 'Ready to scan shipment')}</div>
        <button id="mpp-ship-back" class="mpp-btn mpp-btn-ghost">← Change profile</button>
      </div>`;
    wireHeader();
    const inp = document.getElementById('mpp-ship-in');
    inp?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.keyCode === 13) {
        e.preventDefault();
        const v = inp.value.trim();
        inp.value = '';
        if (v) onShipmentScan(v);
      }
    });
    document.getElementById('mpp-ship-back')?.addEventListener('click', renderProfileSelect);
    setTimeout(() => inp?.focus(), 80);
  }

  async function onShipmentScan(shipmentNumber) {
    setShipFeedback('Loading…', 'dim');
    try {
      await loadShipment(shipmentNumber);
      Audio.chime('ok');
      renderScanScreen();
    } catch (err) {
      if (isSessionExpired(err)) return;              // the modal is already up
      Audio.chime('error');
      Voice.error(err.code === 'NOT_FOUND' ? 'Shipment not found' : 'Cannot load shipment');
      setShipFeedback(err.message || 'Could not load shipment', 'err');
      setTimeout(() => document.getElementById('mpp-ship-in')?.focus(), 60);
    }
  }
  function setShipFeedback(msg, type) {
    const el = document.getElementById('mpp-ship-fb');
    if (el) { el.textContent = msg; el.className = 'mpp-fb ' + (type || 'dim'); }
  }

  // ---- Screen 3: Blind scan (guide §10) -------------------------------------
  function renderScanScreen() {
    State.screen = 'SCAN';
    if (!Cache.current) Cache.current = newContainer(1);
    const r = root(); if (!r) return;
    r.innerHTML = `
      ${header(Cache.shipmentNumber, '')}
      <div class="mpp-body mpp-scan-body">
        <div class="mpp-container-badge" id="mpp-container-badge">Container ${Cache.containers.length + 1}</div>
        <div class="mpp-scan-zone" id="mpp-scan-zone">
          <div class="mpp-scan-zone-label">Scan items</div>
          <div class="mpp-scan-arrows">&gt;&gt;&gt;</div>
          <input id="mpp-scan-in" class="mpp-scan" type="text" inputmode="none"
                 autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" />
        </div>
        <div class="mpp-scan-meta" id="mpp-scan-meta"></div>
        <div class="mpp-scan-actions">
          <button id="mpp-view-btn" class="mpp-btn mpp-btn-ghost">View scanned</button>
          <div class="mpp-scan-actions-row">
            <button id="mpp-close-container-btn" class="mpp-btn mpp-btn-secondary">Close Container</button>
            <button id="mpp-finish-btn" class="mpp-btn mpp-btn-primary">Finish Verification</button>
          </div>
        </div>
      </div>`;
    wireHeader();
    const inp = document.getElementById('mpp-scan-in');
    // Value-based capture: the hardware scanner types into the field and the browser
    // composes the correct text in .value (reconstructing from keydown e.key is wrong —
    // the scanner reports shifted glyphs, e.g. "-"→"_", "0"→")"). The field is full-size
    // but visually transparent (see CSS) so Firefox honours inputmode="none" and keeps
    // the soft keyboard down — a 1×1 hidden input did not.
    inp?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.keyCode === 13) {
        e.preventDefault();
        const v = inp.value.trim();
        inp.value = '';
        if (v) onScan(v);
      }
    });
    document.getElementById('mpp-view-btn')?.addEventListener('click', showViewScanned);
    document.getElementById('mpp-close-container-btn')?.addEventListener('click', () => openCloseContainer(false));
    document.getElementById('mpp-finish-btn')?.addEventListener('click', onFinish);
    // Refocus scan input on any tap that isn't a button
    document.querySelector('.mpp-scan-body')?.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      setTimeout(() => document.getElementById('mpp-scan-in')?.focus(), 40);
    });
    updateScanScreenMeta();
    setTimeout(() => inp?.focus(), 80);
  }

  // Blind meta — shows ONLY how many scans landed in the current box + boxes closed.
  // No required items, counts, or progress (guide decision #4).
  function updateScanScreenMeta() {
    const el = document.getElementById('mpp-scan-meta');
    if (!el) return;
    const curUnits = unitsIn(Cache.current);   // lines + unexpected scans x their own factor
    el.innerHTML =
      `<span class="mpp-meta-pill">This container: ${curUnits} unit${curUnits === 1 ? '' : 's'}</span>` +
      `<span class="mpp-meta-pill">Containers closed: ${Cache.containers.length}</span>`;
    const badge = document.getElementById('mpp-container-badge');
    if (badge) badge.textContent = `Container ${Cache.containers.length + 1}`;
  }

  // The units pill is repainted on a fixed short delay after EVERY scan, hit or miss.
  // That delay is deliberate. An unexpected barcode's factor arrives from a lookup a
  // moment after the scan, so repainting a miss on a different schedule from a hit
  // would let the operator read correctness off the ANIMATION — a pill that visibly
  // corrects itself from 1 to 48 says "that carton was wrong" just as loudly as the
  // old static 1 did. Same delay for both, so both settle the same way. Everything
  // that is not scan-triggered (unverify, closing a box, entering the screen) still
  // repaints immediately.
  const META_SETTLE_MS = 600;
  let _metaTimer = null;
  function scheduleScanMetaUpdate() {
    if (_metaTimer) clearTimeout(_metaTimer);
    _metaTimer = setTimeout(() => { _metaTimer = null; updateScanScreenMeta(); }, META_SETTLE_MS);
  }

  function flashScan() {
    const zone = document.getElementById('mpp-scan-zone');
    if (!zone) return;
    zone.classList.remove('mpp-flash');
    void zone.offsetWidth;
    zone.classList.add('mpp-flash');
  }

  // ---- View scanned modal (guide §10, decision #6) --------------------------
  function showViewScanned() {
    const r = root(); if (!r) return;

    // Grouped by container: each closed box, then the open one — known items AND any
    // unexpected scans that landed in that box, with a per-item UOM breakdown (guide §10).
    const curHas = Cache.current.lines.size > 0 || Cache.current.unexpected.size > 0;
    const boxes = curHas ? [...Cache.containers, Cache.current] : [...Cache.containers];

    // removals[] registers each editable (open-container) row so its Unverify button
    // can remove exactly one unit of that UOM / unexpected barcode (guide §13).
    const removals = [];
    const groups = [];
    boxes.forEach((box, idx) => {
      const editable = box === Cache.current;   // the open container
      // v1.9.0 — a CLOSED container is correctable too. "Closed" is a local boundary only:
      // the container does not exist in Canary7, nothing has been moved into it and no
      // weight has been sent until Finish. A container that DOES exist in C7 (a commit
      // that part-failed) is not editable, here or anywhere.
      const correctable = editable || containerIsLocal(box);
      const rows = [];
      for (const [id, base] of box.lines) {
        if (base <= 0) continue;
        rows.push(itemScanRow(id, base, correctable, removals, box));
      }
      for (const [code, n] of (box.unexpected || new Map())) {
        if (n <= 0) continue;
        rows.push(unexpectedScanRow(code, n, correctable, removals, box));
      }
      if (!rows.length) return;
      const label = `Container ${idx + 1}` +
        (box.containerNo ? ` — ${_esc(box.containerNo)}` : '') +
        (editable ? ' (open)' : '');
      // v1.9.0 — total units in THIS container, on the group header. Discloses nothing new
      // on a blind screen: it is the sum of the per-item totals already listed below it.
      const boxTotal = unitsIn(box);
      const totalPill = `<span class="mpp-vs-group-qty">${boxTotal} unit${boxTotal === 1 ? '' : 's'}</span>`;
      groups.push(`<div class="mpp-vs-group"><div class="mpp-vs-group-h">${label}${totalPill}</div>${rows.join('')}</div>`);
    });

    const body = groups.length
      ? groups.join('')
      : '<div class="mpp-note">Nothing scanned yet.</div>';

    const modal = document.createElement('div');
    modal.className = 'mpp-overlay';
    modal.innerHTML = `
      <div class="mpp-modal">
        <div class="mpp-modal-title">Scanned so far</div>
        <div class="mpp-vs-list">${body}</div>
        <button class="mpp-btn mpp-btn-primary" id="mpp-vs-close">Close</button>
      </div>`;
    r.appendChild(modal);
    resolveUnexpectedRows(modal);   // swap raw barcodes for their item codes
    document.getElementById('mpp-vs-close')?.addEventListener('click', () => {
      modal.remove();
      setTimeout(() => document.getElementById('mpp-scan-in')?.focus(), 40);
    });
    // Remove (unverify) one of a UOM from the container that row belongs to, then
    // re-render. v1.9.0: `rm.box` may be a CLOSED container; it falls back to the open one
    // so a removal registered by the old 4-argument row shape still works.
    modal.addEventListener('click', (e) => {
      const btn = e.target.closest('.mpp-vs-rm');
      if (!btn) return;
      e.preventDefault();
      const rm = removals[Number(btn.dataset.idx)];
      if (!rm) return;
      const box = rm.box || Cache.current;
      if (rm.unexpected) unverifyUnexpectedIn(box, rm.unexpected);
      else unverifyIn(box, rm.itemId, rm.factor);
      modal.remove(); showViewScanned();
    });
  }

  // Unverify: remove one UOM's worth of base units (factor) of an item from the OPEN
  // container, keeping the item total in sync (guide §13). Never goes below zero.
  function unverify(itemId, factor) {
    const cur = Cache.current;
    const have = cur.lines.get(itemId) || 0;
    const dec = Math.min(factor, have);
    if (dec <= 0) return;
    if (have - dec <= 0) cur.lines.delete(itemId);
    else cur.lines.set(itemId, have - dec);
    const it = Cache.items.get(itemId);
    if (it) it.scannedBase = Math.max(0, it.scannedBase - dec);
    updateScanScreenMeta();
    vibrate([20]);
  }
  // Unverify one unexpected SCAN from the OPEN container — i.e. one of that barcode's
  // UOM, which is `factor` units, matching how Unverify behaves for a known item.
  // Keeps the shipment-wide tally (used by the Finish report) in sync. Never negative.
  function unverifyUnexpected(code) {
    const cur = Cache.current;
    const have = cur.unexpected.get(code) || 0;
    if (have <= 0) return;
    if (have - 1 <= 0) cur.unexpected.delete(code);
    else cur.unexpected.set(code, have - 1);
    const total = (Cache.unexpected.get(code) || 0) - 1;
    if (total <= 0) Cache.unexpected.delete(code);
    else Cache.unexpected.set(code, total);
    updateScanScreenMeta();
    vibrate([20]);
  }
  // ===========================================================================
  // 10b. UNVERIFY FROM ANY CONTAINER, INCLUDING A CLOSED ONE  (v1.9.0)
  // ===========================================================================
  //
  // `unverify` / `unverifyUnexpected` above are kept exactly as they were: the open-box
  // case, still exported, still what the scan screen uses. These are the general forms
  // that take the container explicitly — keep the two in step if either is ever changed.
  //
  // Correcting a CLOSED box is safe here because "closed" is a purely local boundary: the
  // container does not exist in Canary7 yet, no child has been moved into it and no weight
  // has been sent. All of that happens at Finish. The one case where that stops being true
  // is a commit that part-failed and left real containers behind, and `containerIsLocal`
  // refuses those.

  // A container is still ours to edit only while Canary7 knows nothing about it.
  function containerIsLocal(box) {
    return !!box && !box._c7Id && !box._c7Packed;
  }

  // Weight and emptiness upkeep after units leave a CLOSED box (v1.9.0).
  //  • Its operator-keyed weight now describes contents it no longer holds, so reduce it by
  //    the weight of what came out. An estimate from item weights, but strictly better than
  //    a figure that includes units that are gone. Boxes with no weight keyed, or items
  //    with no weight on file, are left alone rather than guessed at.
  //  • A box emptied completely is dropped: commit walks Cache.containers and would
  //    otherwise create and close an empty pallet in Canary7.
  function reconcileClosedBox(box, removedWeight) {
    if (box === Cache.current) return;
    if (num(box.weight) > 0 && removedWeight > 0) {
      const before = num(box.weight);
      box.weight = Math.max(0, Math.round((before - removedWeight) * 100) / 100);
      LOG('closed box', box.containerNo || box.seq, 'weight', before, '->', box.weight,
          'after unverify');
    }
    if (unitsIn(box) > 0) return;
    const i = Cache.containers.indexOf(box);
    if (i < 0) return;
    Cache.containers.splice(i, 1);
    Cache.containers.forEach((c, n) => { c.seq = n + 1; });
    if (Cache.current) Cache.current.seq = Cache.containers.length + 1;
    LOG('closed box', box.containerNo || 'container', 'emptied by unverify — dropped');
    toast(`${box.containerNo || 'Container'} is now empty — removed.`);
  }

  // Remove one UOM's worth (factor base units) of an item from ANY container, keeping the
  // shipment-wide item total in step. Returns true if anything was actually removed.
  function unverifyIn(box, itemId, factor) {
    if (!box) return false;
    if (!containerIsLocal(box)) {
      toast('That container is already packed in Canary7 — it cannot be changed here.');
      return false;
    }
    const have = box.lines.get(itemId) || 0;
    const dec = Math.min(factor, have);
    if (dec <= 0) return false;
    if (have - dec <= 0) box.lines.delete(itemId);
    else box.lines.set(itemId, have - dec);
    const it = Cache.items.get(itemId);
    if (it) it.scannedBase = Math.max(0, it.scannedBase - dec);
    reconcileClosedBox(box, dec * ((it && it.unitWeight) || 0));
    updateScanScreenMeta();
    vibrate([20]);
    return true;
  }

  // Same for one unexpected SCAN of a barcode. No weight adjustment: an unrecognised
  // barcode has no item record, so there is no unit weight to subtract — the box keeps
  // its keyed weight rather than being adjusted by a number we would have to invent.
  function unverifyUnexpectedIn(box, code) {
    if (!box) return false;
    if (!containerIsLocal(box)) {
      toast('That container is already packed in Canary7 — it cannot be changed here.');
      return false;
    }
    const have = box.unexpected.get(code) || 0;
    if (have <= 0) return false;
    if (have - 1 <= 0) box.unexpected.delete(code);
    else box.unexpected.set(code, have - 1);
    const total = (Cache.unexpected.get(code) || 0) - 1;
    if (total <= 0) Cache.unexpected.delete(code);
    else Cache.unexpected.set(code, total);
    reconcileClosedBox(box, 0);
    updateScanScreenMeta();
    vibrate([20]);
    return true;
  }

  // An unexpected scan card: resolved item code (via data-unex/resolveUnexpectedRows,
  // falling back to the raw barcode), the count, and — for the open box — Unverify.
  function unexpectedScanRow(code, n, editable, removals, box) {
    let rm = '';
    if (editable) {
      // `box` is optional and defaults to the open container, so the original 4-argument
      // call shape still behaves exactly as it did (v1.9.0).
      const idx = removals.push({ unexpected: code, box: box || Cache.current }) - 1;
      rm = `<button class="mpp-vs-rm" data-idx="${idx}" title="Unverify one">Unverify</button>`;
    }
    // Rendered with whatever factor is known now; resolveUnexpectedRows() corrects the
    // line and the total in place the moment the lookup lands.
    const factor = unexpectedFactor(code);
    const resolved = Cache.unexpectedResolved.get(normRef(code));
    return `<div class="mpp-vs-item" data-unex="${_esc(code)}" data-unex-n="${n}">
        <div class="mpp-vs-item-h mpp-unex-label">${_esc(code)}</div>
        <div class="mpp-vs-uom"><span class="mpp-unex-line">${unexpectedLineHTML(n, factor, resolved && resolved.uomName)}</span>${rm}</div>
        <div class="mpp-vs-total"><span>Total</span><span class="mpp-unex-total">${n * factor}</span></div>
      </div>`;
  }
  // One item = a small card: header (code + description, no qty), one row per UOM,
  // then a Total footer (guide §10).
  function itemScanRow(id, base, editable, removals, box) {
    const it = Cache.items.get(id);
    const uomLines = uomParts(id, base).map(p => {
      const nm = _esc(_plural(p.name, p.count));
      const hint = p.factor > 1 ? ` <span class="mpp-vs-uom-f">(${p.factor} each)</span>` : '';
      let rm = '';
      if (editable) {
        // `box` optional, defaults to the open container — see unexpectedScanRow (v1.9.0).
        const idx = removals.push({ itemId: id, factor: p.factor, box: box || Cache.current }) - 1;
        rm = `<button class="mpp-vs-rm" data-idx="${idx}" title="Unverify one ${_esc(p.name)}">Unverify</button>`;
      }
      return `<div class="mpp-vs-uom"><span>${p.count} ${nm}${hint}</span>${rm}</div>`;
    }).join('');
    return `<div class="mpp-vs-item">
        <div class="mpp-vs-item-h"><b>${_esc(it?.itemCode || id)}</b> ${_esc(it?.description || '')}</div>
        ${uomLines}
        <div class="mpp-vs-total"><span>Total</span><span>${base}</span></div>
      </div>`;
  }
  // Naive English pluraliser: "Carton"→"Cartons", "Box"→"Boxes", "Each"→"Eaches".
  function _plural(word, n) {
    if (n === 1 || !word) return word;
    return /([sxz]|[cs]h)$/i.test(word) ? word + 'es' : word + 's';
  }
  // Break a base-unit total into UOM rows — largest factor first, remainder as base
  // units. Returns [{count, name, factor}] (guide §10).
  function uomParts(itemId, base) {
    const it = Cache.items.get(itemId);
    const uoms = (it?.uoms || []).slice().sort((a, b) => b.factor - a.factor);
    const baseName = (uoms.find(u => u.factor === 1) || {}).name || 'Each';
    const parts = [];
    let rem = base;
    for (const u of uoms) {
      if (u.factor <= 1) continue;
      const n = Math.floor(rem / u.factor);
      if (n > 0) { parts.push({ count: n, name: u.name || 'Unit', factor: u.factor }); rem -= n * u.factor; }
    }
    if (rem > 0 || parts.length === 0) parts.push({ count: rem, name: baseName, factor: 1 });
    return parts;
  }

  // ===========================================================================
  // 10. CLOSE CONTAINER  (guide §10 — local only; number→type→weight/dims)
  // ===========================================================================

  // finishAfter: when true, this is the implicit close of the last (open) container
  // triggered by Finish (guide §11/§15) — after closing we proceed to the match.
  function openCloseContainer(finishAfter) {
    // Nothing scanned into the current box? Don't create an empty container.
    // Unexpected scans count here too: with the pill reading "48 units", refusing to
    // close with "nothing scanned into this container yet" both contradicts the screen
    // and tells the operator every carton in the box was wrong. Verification still
    // fails at Finish, so nothing incorrect can commit.
    const curUnits = unitsIn(Cache.current);
    if (curUnits === 0) {
      if (finishAfter) { doFinish(); return; }
      toast('Nothing scanned into this container yet.');
      return;
    }
    const suggestedWeight = suggestedWeightForCurrent();
    const r = root(); if (!r) return;
    const modal = document.createElement('div');
    modal.className = 'mpp-overlay';
    modal.innerHTML = `
      <div class="mpp-modal">
        <div class="mpp-modal-title">Close Container ${Cache.containers.length + 1}</div>
        <label class="mpp-label">Container number</label>
        <input id="mpp-cc-no" class="mpp-input" type="text" autocomplete="off"
               placeholder="Scan / type container label" />
        <div id="mpp-cc-type" class="mpp-fb dim"></div>
        <div id="mpp-cc-type-picker-wrap" style="display:none">
          <label class="mpp-label">Container type</label>
          <select id="mpp-cc-type-picker" class="mpp-select"></select>
        </div>
        <div class="mpp-grid2">
          <div><label class="mpp-label">Weight (kg)</label>
            <input id="mpp-cc-wt" class="mpp-input" type="number" step="0.01" min="0" value="${suggestedWeight || ''}" /></div>
          <div><label class="mpp-label">Length (cm)</label>
            <input id="mpp-cc-l" class="mpp-input" type="number" step="0.1" min="0" /></div>
          <div><label class="mpp-label">Width (cm)</label>
            <input id="mpp-cc-w" class="mpp-input" type="number" step="0.1" min="0" /></div>
          <div><label class="mpp-label">Height (cm)</label>
            <input id="mpp-cc-h" class="mpp-input" type="number" step="0.1" min="0" /></div>
        </div>
        <div id="mpp-cc-fb" class="mpp-fb err" style="display:none"></div>
        <div class="mpp-grid2">
          <button id="mpp-cc-cancel" class="mpp-btn mpp-btn-ghost">Cancel</button>
          <button id="mpp-cc-ok" class="mpp-btn mpp-btn-primary">${finishAfter ? 'Close & Finish' : 'Close Container'}</button>
        </div>
      </div>`;
    r.appendChild(modal);

    const noIn = document.getElementById('mpp-cc-no');
    const typeFb = document.getElementById('mpp-cc-type');
    const pickerWrap = document.getElementById('mpp-cc-type-picker-wrap');
    const picker = document.getElementById('mpp-cc-type-picker');

    const refreshType = () => {
      const match = containerTypeFromNumber(noIn.value);
      if (match) {
        typeFb.textContent = `Type: ${match.name}`;
        typeFb.className = 'mpp-fb ok';
        pickerWrap.style.display = 'none';
      } else if (noIn.value.trim()) {
        // No prefix matched — prompt operator to pick a type (guide decision #8)
        typeFb.textContent = 'Unknown prefix — select a container type:';
        typeFb.className = 'mpp-fb err';
        if (!picker.options.length) {
          picker.innerHTML = State.containerTypes
            .map(ct => `<option value="${ct.id}">${_esc(ct.name || ct.description || ('Type ' + ct.id))}</option>`).join('');
        }
        pickerWrap.style.display = '';
      } else {
        typeFb.textContent = '';
        pickerWrap.style.display = 'none';
      }
    };
    noIn.addEventListener('input', refreshType);
    noIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); refreshType(); document.getElementById('mpp-cc-wt')?.focus(); } });

    document.getElementById('mpp-cc-cancel')?.addEventListener('click', () => {
      document.activeElement?.blur();   // dismiss the soft keyboard from weight/dims/number fields
      modal.remove();
      setTimeout(() => document.getElementById('mpp-scan-in')?.focus(), 40);
    });

    document.getElementById('mpp-cc-ok')?.addEventListener('click', () => {
      const fb = document.getElementById('mpp-cc-fb');
      const showErr = (m) => { fb.textContent = m; fb.style.display = ''; };
      const no = noIn.value.trim();
      if (!no) return showErr('Enter or scan the container number.');
      const match = containerTypeFromNumber(no);
      let typeId = match?.typeId;
      if (!typeId) {
        typeId = Number(picker.value);
        if (!typeId) return showErr('Select a container type.');
      }
      const weight = num(document.getElementById('mpp-cc-wt').value);
      const length = num(document.getElementById('mpp-cc-l').value);
      const width  = num(document.getElementById('mpp-cc-w').value);
      const height = num(document.getElementById('mpp-cc-h').value);
      // Honour wholesale profile confirm_weight / confirm_dimensions (guide §1.9)
      if (State.profile?.confirm_weight && weight <= 0) return showErr('Enter the container weight.');
      if (State.profile?.confirm_dimensions && (length <= 0 || width <= 0 || height <= 0))
        return showErr('Enter length, width and height.');

      // Finalise current into containers, start a fresh one (guide §10)
      Cache.current.containerNo = no;
      Cache.current.containerTypeId = typeId;
      Cache.current.weight = weight;
      Cache.current.length = length;
      Cache.current.width = width;
      Cache.current.height = height;
      Cache.containers.push(Cache.current);
      Cache.current = newContainer(Cache.containers.length + 1);

      document.activeElement?.blur();   // dismiss the soft keyboard from weight/dims fields
      modal.remove();
      Audio.chime('ok');
      updateScanScreenMeta();
      if (finishAfter) doFinish();
      else setTimeout(() => document.getElementById('mpp-scan-in')?.focus(), 40);
    });

    setTimeout(() => noIn?.focus(), 80);
  }

  function suggestedWeightForCurrent() {
    let w = 0;
    for (const [id, base] of Cache.current.lines) {
      const it = Cache.items.get(id);
      if (it && it.unitWeight) w += it.unitWeight * base;
    }
    return w > 0 ? Math.round(w * 100) / 100 : '';
  }

  // ===========================================================================
  // 11. FINISH VERIFICATION (local match, guide §11) + mismatch reset (§13)
  // ===========================================================================

  // Local total-vs-required match (guide §11). scannedBase is kept live on every
  // scan (incl. the still-open box), so this is meaningful the moment the operator
  // declares they're done. Returns { mismatches, unexpected, verified }.
  function computeVerification() {
    const mismatches = [];
    // itemId rides along so the partial reset can clear exactly these lines (v1.8.0).
    // Iterate entries, not values: the id is the Map key, and it is what container lines
    // and the barcode index are keyed by.
    for (const [itemId, it] of Cache.items.entries()) {
      if (it.scannedBase !== it.requiredBase) {
        mismatches.push({ itemId, itemCode: it.itemCode, required: it.requiredBase, scanned: it.scannedBase });
      }
    }
    const unexpected = [...Cache.unexpected.entries()];
    return { mismatches, unexpected, verified: mismatches.length === 0 && unexpected.length === 0 };
  }

  function onFinish() {
    if (State.committing) return;                 // re-entry guard (guide §15)
    // Verify FIRST — before the operator enters any container info. If the match
    // fails there is no reason to key weight/dimensions, so show the report and
    // reset straight away. Only once verification passes do we prompt for the final
    // (open) box's info and commit (guide §11/§15).
    const v = computeVerification();
    if (!v.verified) { showMismatch(v.mismatches, v.unexpected); return; }

    // Verified — treat the still-open box (if any) as the final container: prompt
    // its weight/dims, then commit. Otherwise commit what's already closed.
    if (unitsIn(Cache.current) > 0) { openCloseContainer(true); return; }
    doFinish();
  }

  function doFinish() {
    if (State.committing) return;
    if (!Cache.containers.length) { toast('Close at least one container first.'); return; }
    const v = computeVerification();
    if (v.verified) { commit(); }
    else { showMismatch(v.mismatches, v.unexpected); }
  }

  // Is the partial rescan available for THIS shipment right now? (v1.8.0)
  // Only two conditions, because on this path nothing has reached Canary7 — no container
  // exists, no child has moved, no weight has been sent — so there is no remote state to
  // get out of step with:
  //   • the company is allow-listed, and
  //   • this session has not already created a container in C7. That last one is reachable:
  //     a commit can part-fail, and the operator can then go back to scanning and Finish
  //     again. Once real containers exist, clearing counts locally would put the ledger at
  //     odds with stock C7 has already moved, so the full reset (which routes through
  //     confirmDiscardC7Work) is the only option offered.
  function partialRescanAvailable() {
    return PARTIAL_RESCAN_COMPANY_IDS.has(Cache.companyId) && !c7HoldsContainers();
  }

  function showMismatch(mismatches, unexpected) {
    Audio.chime('error');
    Voice.error('Verification failed');
    vibrate([60, 30, 60]);
    const r = root(); if (!r) return;

    // PARTIAL RESCAN (v1.8.0, allow-listed company only). Offered when there is at least
    // one per-item mismatch to clear — with only unexpected barcodes to fix there is no
    // count to reset, so it would be a button that does nothing a full reset doesn't.
    const partial = partialRescanAvailable() && mismatches.length > 0;

    // Which closed boxes hold units of a SKU that is about to be cleared. Computed BEFORE
    // anything is touched, because the operator has to physically get those units back out
    // in order to re-scan them.
    const affected = !partial ? [] : Cache.containers.filter(c =>
      mismatches.some(m => c.lines.has(m.itemId)));

    const rows = mismatches.map(m => {
      const diff = m.scanned - m.required;
      // The qty is diagnostic — the direction and size of the error. This report already
      // disclosed required-vs-scanned before v1.8.0, so it reveals nothing new on a blind
      // screen. The COUNT ITSELF is cleared either way, so this is not an instruction to
      // scan a difference: the operator re-scans that SKU from zero.
      const what = partial
        ? (diff < 0 ? `${-diff} short` : `${diff} too many`)
        : `required ${m.required}, scanned ${m.scanned}`;
      return `<div class="mpp-vs-row mpp-vs-bad"><span><b>${_esc(m.itemCode)}</b></span>` +
             `<span>${what}</span></div>`;
    });
    const un = unexpected.map(([code, n]) =>
      `<div class="mpp-vs-row mpp-vs-bad" data-unex="${_esc(code)}" data-unex-n="${n}">` +
      `<span class="mpp-unex-label">${_esc(code)}</span>` +
      `<span class="mpp-unex-qty">${unexpectedQtyText(n, unexpectedFactor(code))}</span></div>`);
    const modal = document.createElement('div');
    modal.className = 'mpp-overlay';
    modal.innerHTML = `
      <div class="mpp-modal">
        <div class="mpp-modal-title" style="color:var(--c7-red)">✕ Verification failed</div>
        ${partial
          ? `<div class="mpp-note">These counts will be cleared — re-scan these items from
               scratch. Everything that matched stays scanned. Nothing has been committed.</div>`
          : `<div class="mpp-note">Differences (nothing has been committed):</div>`}
        <div class="mpp-vs-list">${rows.join('')}${un.join('')}</div>
        ${partial
          ? `${affected.length
               ? `<div class="mpp-note">Open ${affected.map(c => _esc(c.containerNo || ('container ' + c.seq))).join(', ')}
                    and take those items out first — re-scan them into the container you have open.</div>`
               : ``}
             <button class="mpp-btn mpp-btn-primary" id="mpp-mm-partial">Clear &amp; re-scan these ${mismatches.length} item${mismatches.length === 1 ? '' : 's'}</button>
             <button class="mpp-btn mpp-btn-ghost" id="mpp-mm-ok">Reset &amp; rescan everything</button>`
          : `<button class="mpp-btn mpp-btn-primary" id="mpp-mm-ok">Reset &amp; rescan</button>`}
      </div>`;
    r.appendChild(modal);
    resolveUnexpectedRows(modal);   // swap raw barcodes for their item codes

    modal.querySelector('#mpp-mm-partial')?.addEventListener('click', () => {
      // Re-derive both the gate and the mismatch set at tap time. The gate because
      // `partial` was decided at paint; the set because the array closed over above is a
      // snapshot, and clearing a SKU that has since been corrected would send the operator
      // to re-count a line that is already right.
      if (!partialRescanAvailable()) {
        modal.remove();
        toast('Canary7 already holds containers for this shipment — full reset only.');
        renderScanScreen();
        return;
      }
      const fresh = computeVerification();
      if (fresh.verified) {
        modal.remove();
        renderScanScreen();
        toast('Counts now match — tap Finish.');
        return;
      }
      const res = Cache.resetMismatchedScans(fresh.mismatches.map(m => m.itemId));
      modal.remove();
      renderScanScreen();
      // One message, covering everything that moved: the container badge may have shifted
      // under the operator and a box weight may have been adjusted.
      const parts = [`Re-scan ${res.itemIds.length} item${res.itemIds.length === 1 ? '' : 's'}`];
      if (res.dropped.length) parts.push(`${res.dropped.length} box${res.dropped.length === 1 ? '' : 'es'} emptied`);
      if (res.adjusted.length) parts.push(`${res.adjusted.length} box weight${res.adjusted.length === 1 ? '' : 's'} adjusted`);
      toast(parts.join(' · '));
    });

    modal.querySelector('#mpp-mm-ok')?.addEventListener('click', () => {
      // Reachable after a partial commit (commit error → back to scan → scan → Finish),
      // and resetScans() drops Cache.containers along with the ledger.
      if (!confirmDiscardC7Work('Resetting and rescanning')) return;
      modal.remove();
      Cache.resetScans();               // keep items + barcodeIndex (guide §13)
      renderScanScreen();
    });
  }

  // ===========================================================================
  // 12. COMMIT  (deferred; runs only when verified — guide §12/§14)
  // ===========================================================================

  async function commit() {
    if (State.committing) return;
    State.committing = true;
    State.screen = 'COMMITTING';
    renderCommitting('Resolving packing context…');

    try {
      // 1. Resolve live packing context (guide §3 D4 two-step)
      const listPath =
        `shipment/shipment-container&shipment_number=${encShip(Cache.shipmentNumber)}` +
        `&expand=status,container_type&fields=id,container_no,status.id,container_type.name` +
        `&per-page=50&page=1`;
      const listRaw = await apiGet(listPath);
      const list = Array.isArray(listRaw) ? listRaw : (listRaw?.items || []);
      const source = list.find(c => Number(c.status?.id ?? c.status_id) === 5);
      if (!source) throw new Error('Source tote (status 5) not found for this shipment.');

      renderCommitting('Loading source tote…');
      const gpcRaw = await apiGet(
        `shipment/shipment-container/get-pack-container` +
        `&container_no=${encodeURIComponent(source.container_no)}&item_code=null` +
        `&profile=${State.profile.id}&expand=${PP_GPC_EXPAND}`
      );
      const gpcContainers = Array.isArray(gpcRaw) ? gpcRaw : [gpcRaw];
      // get-pack-container returns EVERY container on the shipment, not just the tote
      // we asked for — including already-packed (status-7) pieces from earlier boxes.
      // Only the source tote (the status-5 container we resolved) holds children still
      // to pack; using the others moved already-closed children and corrupted the close.
      const src = gpcContainers.find(c =>
        String(c.container_no) === String(source.container_no)) || gpcContainers[0] || {};
      const consignmentId    = src.consignment_id;
      const jobInstructionId = src.job_instruction_id;

      // Build remaining[item_id] = [ {childId, qtyBase, uomId} ] from the SOURCE tote's
      // still-open children only (guide §8/§12).
      // NOTE: C7 stores shipmentDetailChild.quantity in BASE units regardless of the
      // child's UOM (confirmed from a pack HAR: a Carton-UOM child of 25 + siblings
      // 11 + 30 summed to the detail's base qty of 66). Likewise pack-short-v2's
      // short_quantity is base units. So we do NOT multiply by the UOM factor here —
      // doing so previously inflated Carton children ×factor and left units unpacked.
      const remaining = new Map();
      for (const child of (src.shipmentDetailChildren || [])) {
        if (Number(child.status_id) === 7) continue;          // already packed — never touch
        const item = child.shipmentDetail?.item || {};
        const itemId = item.id ?? item.item_code;
        if (itemId == null) continue;
        const uomId = child.item_unit_of_measure_id ?? child.itemUnitOfMeasure?.id;
        if (!remaining.has(itemId)) remaining.set(itemId, []);
        remaining.get(itemId).push({ childId: child.id, uomId, qtyBase: num(child.quantity) });
      }

      // 2. Location constant (guide §3 D5)
      const loc = PACK_LOCATION_ID;

      // Container-number generator for boxes without an operator-supplied number
      // Seed past anything a previous attempt already used, so a resumed commit doesn't
      // spend its first create on a number C7 is certain to reject as a duplicate.
      let genSeq = 1;
      for (const c of Cache.containers) {
        const m = /-(\d+)$/.exec(c._c7ContainerNo || '');
        if (m) genSeq = Math.max(genSeq, Number(m[1]) + 1);
      }
      const genNumber = () => `${source.container_no}-${genSeq++}`;

      // 3. Per container, in order: create → move/pack children → close.
      //    SERIALISED per container (create → its moves/packs → close) because
      //    child-split ids chain (guide §12).
      let ci = 0;
      for (const cont of Cache.containers) {
        ci++;
        // Commit is RE-ENTRANT. A session expiry, a dropped connection or the Retry
        // button can all bring us back here after some containers are already packed in
        // C7 — and re-creating one produces a phantom empty pallet on a live
        // consignment (the create is rejected as a duplicate number, the duplicate
        // handler invents a new number, and the box is created and closed with nothing
        // in it because its children are already status 7). So each container carries
        // its own ledger and we never do the same work twice.
        if (cont._c7Packed) {
          LOG(`container ${ci} already packed in C7 as ${cont._c7ContainerNo} — skipping`);
          continue;
        }
        if (cont._c7Id) {
          // Created last time but never confirmed closed. Do NOT guess — ask C7 what
          // actually happened. Three answers, three different right moves:
          renderCommitting(`Checking container ${ci} in Canary7…`);
          const st = await inspectContainer(cont._c7Id);
          if (st.closed) {                       // C7 closed it after all
            LOG(`container ${ci} (${cont._c7ContainerNo}) is already closed in C7 — skipping`);
            cont._c7Packed = true;
            continue;
          }
          if (st.known && st.empty) {            // created, nothing moved in: safe to resume
            LOG(`container ${ci} (${cont._c7ContainerNo}) exists in C7 but is empty — resuming into it`);
          } else {
            // It holds children we cannot account for. Packing into it again would move
            // real stock twice, and this script cannot reconcile it. Stop, name the box,
            // and let the commit-error screen offer the one safe way forward.
            const label = cont._c7ContainerNo || cont._c7Id;
            const e = new Error(st.error || !st.known
              ? `Canary7 didn't answer when we asked about container ${label}, which was created ` +
                `but never confirmed closed. Open it in C7: if it is closed, press "Already ` +
                `closed in C7" below; if it is empty, press Retry commit. We won't guess.`
              : `Container ${label} was created in Canary7 and already holds stock, but was ` +
                `never confirmed closed. Open it in C7: if it is complete, close it there and ` +
                `press "Already closed in C7" below. Retrying blind would pack it twice.`);
            e.code = 'CONTAINER_UNRESOLVED';
            e.container = cont;
            throw e;
          }
        }
        renderCommitting(`Packing container ${ci} of ${Cache.containers.length}…`);

        // a. create (regenerate number + retry on duplicate 500, guide §14).
        // Direct call (NOT via the retrying queue): a duplicate-number 500 is not
        // transient — retrying the same number always 500s, so we regenerate here.
        let containerNo = cont._c7ContainerNo || cont.containerNo || genNumber();
        let containerId = cont._c7Id || null;
        let created = containerId ? { id: containerId } : null;
        for (let attempt = 0; attempt < 10 && !created; attempt++) {
          try {
            created = await apiPost('shipment/shipment-container/create', {
              container_no: containerNo,
              status_id: 5,
              shipment_header_id: Cache.shipmentHeaderId,
              consignment_id: consignmentId,
              to_container: 1,
              job_instruction_id: jobInstructionId ?? null,
              consolidation_dock_id: null,
              container_type_id: cont.containerTypeId,
              status: 0,
              allow_inter_warehouse_transfer: 0,
              restrict_twofactor: 0,
            });
          } catch (e) {
            // Only a genuine duplicate-number rejection earns a fresh number. An
            // auth-shaped 500 ("jwt expired") used to land here and burn all ten
            // attempts inventing container numbers against a dead call.
            if (isSessionExpired(e) || e.code === 'AUTH_BLIP') throw e;
            if (e.status === 500) { containerNo = genNumber(); continue; }  // duplicate no.
            throw e;
          }
        }
        if (!created || !created.id) throw new Error('Could not create container ' + containerNo);
        containerId = created.id;
        cont._c7Id = containerId;               // ledger: it exists in C7 from here on
        cont._c7ContainerNo = containerNo;

        // b. allocate each item's units in cont.lines against remaining children (guide §12.b)
        for (const [itemId, baseNeed] of cont.lines) {
          let need = baseNeed;
          const queue = remaining.get(itemId) || [];
          while (need > 0 && queue.length) {
            const child = queue[0];
            if (child.qtyBase <= need) {
              // whole remaining qty of this child goes into this container → move
              await qCall(`move-${child.childId}-${containerId}`, () =>
                apiGet(
                  `shipment/shipment-container/move-into-container-v2` +
                  `&shipment_detail_child_id=${child.childId}` +
                  `&container_id=${containerId}&into_location=${loc}` +
                  `&custom_field_1=null&custom_field_2=null&profile_id=${State.profile.id}`
                ));
              need -= child.qtyBase;
              queue.shift();
            } else {
              // only part of this child goes into this container → pack-short-v2.
              // short_quantity is in BASE units (same units as child.quantity —
              // confirmed from the pack HAR: short_quantity=6 packed 6 and left a
              // remainder child of 19, i.e. 25-6). short_quantity = the amount packed
              // INTO this container; the returned NEW child carries the remainder
              // (which stays in the source tote) for the next container.
              const partBase = need;
              const resp = await qCall(`packshort-${child.childId}-${containerId}`, () =>
                apiGet(
                  `shipment/shipment-container/pack-short-v2` +
                  `&into_location=${loc}&shipment_detail_child_id=${child.childId}` +
                  `&short_quantity=${partBase}&container_id=${containerId}` +
                  `&custom_field_1=null&custom_field_2=null&profile_id=${State.profile.id}`
                ));
              const newChildId = resp?.id || resp?.child_id ||
                resp?.shipmentDetailChild?.id || resp?.shipment_detail_child?.id;
              // Remainder continues under the new child id for later containers
              child.qtyBase = Math.max(0, child.qtyBase - partBase);
              if (newChildId) child.childId = newChildId;
              need = 0;
            }
          }
          if (need > 0) WARN(`Container ${ci}: ${need} base units of item ${itemId} had no matching child.`);
        }

        // c. close — 500 is a soft warning (C7 closes before print side effects, guide §2.4)
        await closeToContainer(containerId, loc, cont);
        cont._c7Packed = true;                  // ledger: done, never redo it
      }

      // 4. Verify the shipment actually advanced before declaring success. C7 moves
      //    the shipment to Consigning Pending (7) as a side effect of all children
      //    being packed into closed containers — but a close can soft-fail server-side
      //    (e.g. "statusFlow on null") and leave it at Pack Pending. Don't show a false
      //    ✓ in that case (guide §2.2/§12). Do NOT call create-consignment-pieces.
      renderCommitting('Verifying shipment status…');
      const advanced = await verifyConsigningPending();
      if (advanced) {
        LOG('Commit complete — shipment at Consigning Pending. No consign call fired.');
        renderSuccess();
      } else {
        WARN('Commit ran but shipment is still Pack Pending — a container may not have closed.');
        renderCommitError(new Error(
          'Packing didn’t complete — the shipment is still Pack Pending (a container may have failed to close). ' +
          'Nothing was consigned; check C7 and retry.'));
      }
    } catch (err) {
      if (isSessionExpired(err)) {
        // The banner is already up (and, living on <body>, survives this render).
        // Deliberately NOT the scan screen: that hands back a Finish button, and
        // Finish re-enters commit(). The ledger above makes that safe now, but the
        // honest screen is the one that says what happened and how far it got.
        const packed = Cache.containers.filter(c => c._c7Packed).length;
        WARN(`commit interrupted by a session expiry after ${packed}/${Cache.containers.length} containers`);
        renderCommitError(new Error(
          `Canary7 signed this device out mid-commit. ${packed} of ${Cache.containers.length} ` +
          `container(s) were packed. Log back in, then Retry — already-packed containers ` +
          `are skipped.`));
        return;
      }
      WARN('commit failed:', err.message);
      renderCommitError(err);
    }
  }

  // What does Canary7 currently think of a container we created earlier? Only called on
  // the rare resume path, so it pays for its own query rather than bloating the list
  // fetch every commit does. NB shipment-container detail returns the whole consignment
  // group, so filter on the id (api trap §6e).
  async function inspectContainer(containerId) {
    try {
      const raw = await apiGet(
        `shipment/shipment-container&shipment_number=${encShip(Cache.shipmentNumber)}` +
        `&expand=status,shipmentDetailChildren&fields=id,container_no,status.id,shipmentDetailChildren.id` +
        `&per-page=100&page=1`);
      const arr = Array.isArray(raw) ? raw : (raw?.items || []);
      const rec = arr.find(c => String(c.id) === String(containerId));
      if (!rec) return { known: false, closed: false, empty: false };
      const status = Number(rec.status?.id ?? rec.status_id);
      // Packed (7) or anything beyond it — someone may have consigned it in C7 between
      // attempts — means the box is finished and must not be touched again.
      const closed = Number.isFinite(status) && status >= 7;
      // "Empty" must be a POSITIVE reading. If the relation did not come back we do not
      // know what is in the box, and this is the one branch whose answer authorises a
      // write to live stock — so an absent key is "not empty", never "empty".
      const kids = rec.shipmentDetailChildren ?? rec.shipment_detail_children;
      const empty = Array.isArray(kids) && kids.length === 0;
      return { known: true, closed, empty, status };
    } catch (e) {
      if (isSessionExpired(e)) throw e;
      WARN('could not inspect container', containerId, '—', e.message);
      // Unknown is unsafe — but say so as "we could not ask", not as "it holds stock".
      return { known: false, closed: false, empty: false, error: true };
    }
  }

  // Re-fetch the shipment header status; true once it reaches Consigning Pending (7).
  async function verifyConsigningPending() {
    try {
      const data = await apiGet(
        `shipment/shipment-detail&shipment_number=${encShip(Cache.shipmentNumber)}` +
        `&expand=shipmentHeader&fields=id,shipment_header.id,shipment_header.leading_status_id` +
        `&per-page=1&page=1`
      );
      const rows = Array.isArray(data) ? data : (data?.items || []);
      const h = rows[0]?.shipmentHeader || rows[0]?.shipment_header || {};
      const st = Number(h.leading_status_id);
      LOG('post-commit leading status:', st);
      return st === 7;
    } catch (e) {
      if (isSessionExpired(e)) throw e;   // let commit()'s catch own it — don't stack an error screen
      WARN('status verify failed:', e.message);
      return false;   // can't confirm → treat as not-advanced (honest, retryable)
    }
  }

  // close-to-container with Pack's soft-500 handling (guide §2.4). Returns even
  // on 500 (container is closed server-side before print/label side effects).
  async function closeToContainer(containerId, loc, cont) {
    const path =
      `shipment/shipment-container/close-to-container` +
      `&close_to_location_id=${loc}&container_id=${containerId}` +
      `&profile_id=${State.profile.id}` +
      `&weight=${num(cont.weight)}&length=${num(cont.length)}` +
      `&width=${num(cont.width)}&height=${num(cont.height)}`;
    try {
      return await apiGet(path);
    } catch (err) {
      // An auth-shaped failure is NOT soft — we have no idea whether the container
      // closed, so it must surface rather than be swallowed as a print-side effect.
      if (isSessionExpired(err) || err.code === 'AUTH_BLIP') throw err;
      // Everything else stays soft: C7 closes the container server-side before the
      // print/label side effects that produce these 500s (guide §2.4).
      WARN('close-to-container soft error:', err.status, err.message || '');
      return { id: containerId, status_id: 7, _softError: err.message || `Server error ${err.status}` };
    }
  }

  // ---- Commit progress / success / error screens ----------------------------
  function renderCommitting(msg) {
    const r = root(); if (!r) return;
    r.innerHTML = `
      ${header('Pallet Pack', 'Committing…')}
      <div class="mpp-body mpp-center">
        <div class="mpp-spinner"></div>
        <div class="mpp-note" id="mpp-commit-msg">${_esc(msg || 'Working…')}</div>
      </div>`;
    wireHeader();   // the spinner screen still needs a working ✕ — a TC51 has no Esc key
  }
  function updateCommitMsg(msg) { const el = document.getElementById('mpp-commit-msg'); if (el) el.textContent = msg; }

  function renderSuccess() {
    State.screen = 'SUCCESS';
    State.committing = false;
    Audio.chime('ok');
    Voice.speak('Verified and packed');
    const r = root(); if (!r) return;
    r.innerHTML = `
      ${header('Pallet Pack', 'Done')}
      <div class="mpp-body mpp-center">
        <div class="mpp-big-tick">✓</div>
        <div class="mpp-success-title">Verified &amp; packed</div>
        <div class="mpp-note">Shipment is now <b>Consigning Pending</b>.<br>Take it to the desk to consign.</div>
        <button id="mpp-next-btn" class="mpp-btn mpp-btn-primary mpp-btn-lg">Next shipment</button>
      </div>`;
    wireHeader();
    document.getElementById('mpp-next-btn')?.addEventListener('click', resetForNextShipment);
  }

  // Commit-time failure: keep ALL local state, offer retry (guide §13)
  function renderCommitError(err) {
    State.committing = false;
    Audio.chime('error');
    // A container C7 created but never confirmed closed can only be settled by a human
    // looking at C7. Once they have, give them a way back in — otherwise Retry throws
    // the same error forever and the only exit is closing the tool, which discards the
    // record of what C7 already holds.
    const stuck = err && err.code === 'CONTAINER_UNRESOLVED' ? err.container : null;
    // Job-type / "null" errors on move/pack mean the shipment's picking job type
    // isn't valid for this profile — surface that, don't imply a transient fault. (guide §2.3/§15)
    let msg = err.message || 'Unknown error';
    if (/completePacking|packShortV2|\bnull\b|job.?type|not valid/i.test(msg)) {
      msg = "Shipment's job type may not be valid for this profile (or a child id was stale). Original error: " + msg;
    }
    err = { message: msg };
    const r = root(); if (!r) return;
    r.innerHTML = `
      ${header('Pallet Pack', 'Commit error')}
      <div class="mpp-body mpp-center">
        <div class="mpp-big-tick" style="color:var(--c7-red)">!</div>
        <div class="mpp-success-title" style="color:var(--c7-red)">Couldn't finish packing</div>
        <div class="mpp-note">${_esc(err.message || 'Unknown error')}</div>
        <div class="mpp-note">Nothing was reset. You can retry the commit.</div>
        <button id="mpp-retry-btn" class="mpp-btn mpp-btn-primary mpp-btn-lg">Retry commit</button>
        ${stuck ? `<button id="mpp-stuck-btn" class="mpp-btn mpp-btn-secondary">Already closed in C7 — continue</button>` : ''}
        <button id="mpp-back-scan-btn" class="mpp-btn mpp-btn-ghost">Back to scan screen</button>
      </div>`;
    wireHeader();
    document.getElementById('mpp-retry-btn')?.addEventListener('click', () => commit());
    document.getElementById('mpp-stuck-btn')?.addEventListener('click', () => {
      if (!confirm(`Confirm container ${stuck._c7ContainerNo || stuck._c7Id} is CLOSED in Canary7. ` +
                   `Pallet Pack will skip it and pack the rest.`)) return;
      stuck._c7Packed = true;
      LOG('operator confirmed', stuck._c7ContainerNo, 'is closed in C7 — resuming commit');
      commit();
    });
    document.getElementById('mpp-back-scan-btn')?.addEventListener('click', () => { State.screen = 'SCAN'; renderScanScreen(); });
  }

  // ---- Toast ----------------------------------------------------------------
  function toast(msg) {
    const r = root(); if (!r) return;
    const t = document.createElement('div');
    t.className = 'mpp-toast';
    t.textContent = msg;
    r.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, 2200);
  }

  // ===========================================================================
  // 13. FOCUS RECOVERY  (copied from Pick §22 — three layers)
  // ===========================================================================

  function _refocusScanInput() {
    const rootEl = root();
    if (!rootEl || rootEl.style.display === 'none') return;  // closed or backgrounded
    const inputId = _SCAN_SCREENS[State.screen];
    if (!inputId) return;
    if (rootEl.querySelector('.mpp-overlay')) return;               // a modal is open
    if (document.querySelector('.mpp-session-overlay')) return;     // …or the expiry banner
    const el = document.getElementById(inputId);
    if (!el || !document.contains(el)) return;
    if (document.activeElement === el) return;
    el.focus();
  }
  // A. Page becomes visible (screen wake / app foreground)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') setTimeout(_refocusScanInput, 300);
  });
  // B. Window regains focus
  window.addEventListener('focus', () => setTimeout(_refocusScanInput, 200));
  // C. Periodic poll every 2.5s — catches anything A/B missed
  setInterval(() => { if (document.getElementById('mpp-root')) _refocusScanInput(); }, 2500);

  // ===========================================================================
  // 14. NAV INJECTION  (copied from Pick §4 — adds a "Pallet Pack" nav item)
  // ===========================================================================

  let _navClickAttached = false;
  function attachNavClickListener() {
    if (_navClickAttached) return;
    _navClickAttached = true;
    // The sidebar launcher opens / re-shows Pallet Pack. A click on a native C7 tab or
    // sidebar menu HIDES Pallet Pack (session preserved) and lets C7 navigate — the
    // operator returns via the Pallet Pack tab chip or the launcher. We never touch
    // C7's own tabs/panes, so nothing bounces and no native menu goes blank.
    document.addEventListener('click', (e) => {
      const nav = document.getElementById('mpp-nav');
      if (nav && (nav === e.target || nav.contains(e.target))) { e.preventDefault(); openUI(); return; }

      // No active Pallet Pack session → nothing to manage.
      if (!document.getElementById('mpp-root')) return;

      // Our own tab chip handles its own clicks (show / ×).
      if (e.target.closest('#mpp-tab-li')) return;

      // Native C7 tab or sidebar menu link → just hide (do NOT preventDefault, so C7
      // handles the navigation). Switching away is free; state is kept for return.
      const nativeTab   = e.target.closest('ul.nav.nav-tabs[role="tablist"] a.nav-link');
      const sidebarLink = e.target.closest('div.sidebar nav a.nav-link');
      if (nativeTab || sidebarLink) hidePalletPack();
    }, true);
  }

  let _prefetched = false;
  function injectNav() {
    attachNavClickListener();
    if (document.getElementById('mpp-nav')) return;
    const ul = document.querySelector('div.sidebar nav ul.nav');
    if (!ul) return;

    const li = document.createElement('li');
    li.id = 'mpp-nav-li';
    li.className = 'nav-item ng-star-inserted';

    const a = document.createElement('a');
    a.id = 'mpp-nav';
    a.className = 'nav-link ng-star-inserted';
    a.setAttribute('href', 'javascript:void(0)');
    // Compact inline-SVG box icon (no external URL dependency)
    a.innerHTML =
      `<span class="mpp-nav-icon" style="display:inline-flex;width:20px;height:20px;margin-right:8px;vertical-align:middle">` +
      `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
      `<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>` +
      `<polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg></span>` +
      `<span class="mpp-nav-label">Pallet Pack</span>`;

    li.appendChild(a);
    ul.insertBefore(li, ul.firstChild);

    if (!_prefetched) { _prefetched = true; setTimeout(() => initData(), 600); }
  }

  // ===========================================================================
  // 15. CSS
  // ===========================================================================

  function injectCSS() {
    if (document.getElementById('mpp-styles')) return;
    const style = document.createElement('style');
    style.id = 'mpp-styles';
    style.textContent = `
      /* Canary7-matched design tokens (same palette as Malpa Pack v3) — scoped to
         our root so we never touch C7's own :root variables.
         The root is a FIXED overlay pinned to the content area by positionRoot() — it
         is shown/hidden (never removed) so the operator can switch C7 tabs and back. */
      .mpp-root{
        --c7-bg:#eef1f5; --c7-surf:#ffffff; --c7-surf2:#f9f9fa; --c7-surf3:#eef9fd;
        --c7-border:#e1e6ef; --c7-border2:#c0cadd; --c7-text:#394967;
        --c7-muted:#9faecb; --c7-muted2:#6b7280; --c7-teal:#2ea8d6; --c7-amber:#fabb3d;
        --c7-green:#79c447; --c7-green-bg:#eff9eb; --c7-green-bd:#bde5ae; --c7-red:#ff5454;
        --c7-font:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;
        --c7-mono:'SF Mono','Fira Code',Consolas,monospace; --c7-r:4px;
        position:fixed; z-index:100; inset:0;
        background:var(--c7-surf2); color:var(--c7-text);
        font-family:var(--c7-font); display:flex; flex-direction:column; overflow:hidden;
        animation:mpp-in .12s ease;
      }
      @keyframes mpp-in{from{opacity:0}to{opacity:1}}
      /* The session banner is mounted on <body> so a screen re-render cannot destroy
         it; being outside .mpp-root it needs its own copy of the tokens. */
      .mpp-session-overlay{
        --c7-surf:#ffffff; --c7-surf2:#f9f9fa; --c7-surf3:#eef9fd; --c7-bg:#eef1f5;
        --c7-border:#e1e6ef; --c7-border2:#c0cadd; --c7-text:#394967;
        --c7-muted:#9faecb; --c7-muted2:#6b7280; --c7-teal:#2ea8d6; --c7-red:#ff5454;
        --c7-r:4px;
        --c7-font:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;
        font-family:var(--c7-font); color:var(--c7-text);
      }
      /* ── titlebar (C7 tab look) ── */
      .mpp-header{display:flex;align-items:center;justify-content:space-between;
        background:var(--c7-surf);border-bottom:1px solid var(--c7-border);
        min-height:44px;padding:6px 12px 6px 16px;flex-shrink:0;
        box-shadow:inset 0 -2px 0 var(--mp-brand,#6fc3eb)}
      .mpp-header>div:first-child{min-width:0;flex:1}
      .mpp-title{font-size:17px;font-weight:700;color:var(--c7-text);overflow-wrap:anywhere}
      .mpp-subtitle{font-size:13px;color:var(--c7-muted);margin-top:2px;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .mpp-x{background:none;border:none;color:var(--c7-muted2);font-size:20px;cursor:pointer;
        padding:2px 6px;border-radius:3px;line-height:1;transition:color .1s,background .1s}
      .mpp-x:hover{color:var(--c7-text);background:var(--c7-surf3)}
      /* ── body ── */
      .mpp-body{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:14px;background:var(--c7-surf)}
      .mpp-body::-webkit-scrollbar{width:6px}
      .mpp-body::-webkit-scrollbar-thumb{background:var(--c7-border2);border-radius:3px}
      .mpp-center{align-items:center;justify-content:center;text-align:center}
      /* ── labels / inputs / selects ── */
      .mpp-label{font-size:15px;font-weight:700;letter-spacing:1px;text-transform:uppercase;
        color:var(--c7-text);display:block;margin-bottom:4px}
      .mpp-input,.mpp-select{width:100%;box-sizing:border-box;background:var(--c7-bg);
        border:1px solid var(--c7-border2);border-radius:var(--c7-r);color:var(--c7-text);
        font-family:var(--c7-font);font-size:22px;padding:14px 16px;min-height:54px;outline:none;
        transition:border-color .12s}
      .mpp-input:focus,.mpp-select:focus{border-color:var(--c7-teal)}
      .mpp-input::placeholder{color:var(--c7-muted)}
      .mpp-select{font-size:18px}
      .mpp-grid2 .mpp-input{font-size:18px;padding:12px;min-height:48px}
      /* ── buttons ── */
      .mpp-btn{border:none;border-radius:var(--c7-r);cursor:pointer;font-family:var(--c7-font);
        font-weight:600;font-size:17px;padding:0 14px;min-height:54px;min-width:0;color:#fff;
        display:flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;
        overflow:hidden;text-overflow:ellipsis;transition:background .1s,opacity .1s}
      .mpp-btn-lg{font-size:21px;min-height:58px}
      .mpp-btn-primary{background:var(--c7-teal)}
      .mpp-btn-primary:hover:not(:disabled){background:#1985ac}
      .mpp-btn-secondary{background:var(--c7-amber);color:#173140}
      .mpp-btn-secondary:hover:not(:disabled){background:#e9a92f}
      .mpp-btn-ghost{background:var(--c7-surf3);color:var(--c7-text);border:1px solid var(--c7-border2)}
      .mpp-btn-ghost:hover:not(:disabled){background:#e2f2fb}
      .mpp-btn:disabled{opacity:.4;cursor:not-allowed;pointer-events:none}
      /* ── notes / feedback ── */
      .mpp-note{font-size:15px;color:var(--c7-muted);line-height:1.5}
      .mpp-fb{font-size:15px;min-height:20px}
      .mpp-fb.ok{color:var(--c7-green)}.mpp-fb.err{color:var(--c7-red)}.mpp-fb.dim{color:var(--c7-muted)}
      .mpp-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
      .mpp-grid2>*{min-width:0}
      /* ── scan screen (flex column that never scrolls: the zone shrinks/grows, the
         badge/meta/buttons keep their size, so all three buttons stay on-screen) ── */
      .mpp-scan-body{gap:12px;overflow:hidden}
      .mpp-container-badge{align-self:center;flex-shrink:0;background:var(--c7-surf3);border:1px solid var(--c7-border);
        padding:6px 16px;border-radius:20px;font-weight:700;font-size:16px;color:var(--c7-teal)}
      .mpp-scan-zone{position:relative;flex:1;min-height:80px;
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        border:2px dashed var(--c7-border2);border-radius:8px;
        padding:12px 16px;text-align:center;background:var(--c7-bg);transition:background .12s,border-color .12s}
      .mpp-scan-zone.mpp-flash{background:var(--c7-green-bg);border-color:var(--c7-green-bd)}
      .mpp-scan-zone-label{font-size:20px;font-weight:700;color:var(--c7-text)}
      .mpp-scan-arrows{font-size:28px;color:var(--c7-teal);letter-spacing:4px;margin-top:8px}
      /* Capture input fills the zone, focusable but with invisible content (blind scan);
         full-size (not 1×1) so Firefox keeps the soft keyboard down. */
      .mpp-scan{position:absolute;inset:0;width:100%;height:100%;opacity:1;border:0;margin:0;padding:0;
        background:transparent;color:transparent;caret-color:transparent;text-align:center;
        font-size:16px;outline:none}
      input.mpp-scan.mpp-input{position:static;inset:auto;width:100%;height:auto;font-size:22px;
        background:var(--c7-bg);color:var(--c7-text);caret-color:auto}
      .mpp-scan-meta{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;flex-shrink:0}
      .mpp-meta-pill{background:var(--c7-surf2);border:1px solid var(--c7-border);border-radius:16px;
        padding:8px 14px;font-size:14px;color:var(--c7-muted2)}
      .mpp-scan-actions{display:flex;flex-direction:column;gap:10px;flex-shrink:0}
      /* Close Container + Finish Verification sit side by side to save vertical space;
         allow the labels to wrap to two lines so they fit at narrow (TC51) widths. */
      .mpp-scan-actions-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
      .mpp-scan-actions-row>*{min-width:0}
      .mpp-scan-actions-row .mpp-btn{white-space:normal;line-height:1.15;font-size:15px}
      /* ── overlay + modal (light) ── */
      /* Anchored to the VIEWPORT (not the panel) so the modal always centres in the
         visible screen and never falls below the fold — position:absolute centred it in
         the full panel height, which exceeds the visible area under Firefox's URL bar. */
      .mpp-overlay{position:fixed;inset:0;z-index:100000;background:rgba(57,73,103,.45);
        display:flex;align-items:center;justify-content:center;padding:12px}
      .mpp-modal{width:100%;max-width:440px;max-height:94%;overflow:hidden auto;background:var(--c7-surf);
        border:1px solid var(--c7-border2);border-radius:8px;padding:16px;box-sizing:border-box;
        display:flex;flex-direction:column;gap:10px;box-shadow:0 12px 40px rgba(57,73,103,.25)}
      .mpp-modal-title{font-size:18px;font-weight:700;color:var(--c7-text)}
      /* Compact everything INSIDE modals so Close Container / Finish fit the TC51
         screen with no scrolling (touch targets stay >=42px). */
      .mpp-modal .mpp-label{font-size:12px;letter-spacing:.5px;margin-bottom:2px}
      .mpp-modal .mpp-input,.mpp-modal .mpp-select{min-height:44px;font-size:17px;padding:8px 12px}
      .mpp-modal .mpp-grid2{gap:8px}
      .mpp-modal .mpp-grid2 .mpp-input{min-height:42px;font-size:16px;padding:6px 10px}
      .mpp-modal .mpp-btn{min-height:48px;font-size:16px}
      .mpp-modal .mpp-fb{min-height:0}
      .mpp-vs-list{display:flex;flex-direction:column;gap:6px;margin:2px 0}
      .mpp-vs-row{display:flex;justify-content:space-between;gap:10px;font-size:15px;
        padding:8px 12px;background:var(--c7-bg);border-radius:var(--c7-r);color:var(--c7-text)}
      .mpp-vs-bad{border-left:3px solid var(--c7-red);background:#fff3f3}
      /* Per-item card: header, one row per UOM, Total footer */
      .mpp-vs-item{display:flex;flex-direction:column;gap:2px;
        padding:8px 12px;background:var(--c7-bg);border-radius:var(--c7-r)}
      .mpp-vs-item-h{font-size:15px;color:var(--c7-text);line-height:1.3}
      .mpp-vs-uom{display:flex;align-items:center;justify-content:space-between;gap:8px;
        font-size:14px;color:var(--c7-muted2);padding-left:10px}
      .mpp-vs-uom-f{color:var(--c7-muted)}
      .mpp-vs-rm{flex-shrink:0;background:var(--c7-surf);border:1px solid var(--c7-border2);
        color:var(--c7-red);border-radius:4px;font-size:12px;font-weight:600;
        padding:3px 10px;min-height:30px;cursor:pointer}
      .mpp-vs-rm:hover{background:#fff3f3}
      .mpp-vs-total{display:flex;justify-content:space-between;font-size:14px;font-weight:700;
        color:var(--c7-text);border-top:1px solid var(--c7-border);margin-top:3px;padding-top:4px}
      /* View-scanned per-container grouping */
      .mpp-vs-group{display:flex;flex-direction:column;gap:5px}
      .mpp-vs-group-h{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;
        color:var(--c7-muted2);margin-top:8px;padding:0 2px;
        /* v1.9.0 — row layout so the per-container total sits opposite the label */
        display:flex;align-items:baseline;justify-content:space-between;gap:8px}
      /* v1.9.0 — per-container total units. Deliberately louder than the label: on a
         pallet this is the number the operator is actually checking. */
      .mpp-vs-group-qty{flex:none;font-size:14px;font-weight:700;text-transform:none;
        letter-spacing:0;color:var(--c7-text);background:var(--c7-surf2);
        border:1px solid var(--c7-border);border-radius:12px;padding:3px 10px}
      .mpp-vs-group:first-child .mpp-vs-group-h{margin-top:0}
      /* ── success / error ── */
      .mpp-big-tick{font-size:64px;color:var(--c7-green);font-weight:700;line-height:1}
      .mpp-success-title{font-size:22px;font-weight:700;color:var(--c7-text)}
      .mpp-spinner{width:44px;height:44px;border:4px solid var(--c7-border);border-top-color:var(--c7-teal);
        border-radius:50%;animation:mpp-spin .8s linear infinite}
      @keyframes mpp-spin{to{transform:rotate(360deg)}}
      /* ── toast ── */
      .mpp-toast{position:absolute;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);
        background:var(--c7-text);color:#fff;padding:12px 18px;border-radius:8px;font-size:15px;
        opacity:0;transition:.25s;z-index:20;max-width:90%;box-shadow:0 8px 24px rgba(0,0,0,.25)}
      .mpp-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
      #mpp-nav .mpp-nav-label{vertical-align:middle}
      /* Tab chip injected into C7's tab bar — inherits C7 tab styling from
         .nav-item/.nav-link; these rules only style our label + close control. */
      #mpp-tab-li .mpp-tab-label{vertical-align:middle}
      #mpp-tab-li .mpp-tab-x{margin-left:10px;font-size:16px;line-height:1;opacity:.65;
        cursor:pointer;padding:0 2px;border-radius:3px}
      #mpp-tab-li .mpp-tab-x:hover{opacity:1;background:rgba(0,0,0,.08)}
      /* Centre the shipment-scan field's placeholder + typed value. */
      #mpp-ship-in{text-align:center}
      #mpp-ship-in::placeholder{text-align:center}
    `;
    document.head.appendChild(style);
  }

  // ===========================================================================
  // 16. DEBUG HANDLE
  // ===========================================================================
  // On a TC51 there is no console to breakpoint in, so expose the internals: this is
  // both the on-device debugging surface and the seam the offline harness tests
  // through. Read-only use only — nothing here is part of the operator flow.
  window.__palletpack = {
    VERSION,
    State, Cache,
    // shell
    measureChrome, positionRoot, positionRootSettled, openUI, closeUI,
    showPalletPack, hidePalletPack, ensureTabChip,
    // scanning / verification
    onScan, computeVerification, unexpectedFactor, unexpectedUnits,
    inspectContainer, c7HoldsContainers,
    // partial rescan (v1.8.0)
    PARTIAL_RESCAN_COMPANY_IDS, partialRescanAvailable, unitsIn,
    // unverify from any container + per-container totals (v1.9.0)
    unverifyIn, unverifyUnexpectedIn, containerIsLocal, reconcileClosedBox,
    showViewScanned, itemScanRow, unexpectedScanRow,
    // the original open-box forms — never exported before, so nothing could assert that
    // v1.9.0 left them behaving identically
    unverify, unverifyUnexpected,
    showMismatch, doFinish, onFinish, newContainer,
    updateScanScreenMeta, scheduleScanMetaUpdate,
    uomForReference, normRef, uomParts,
    // auth
    getToken, mkHeaders, sessionIsAlive, isSessionExpired, apiFetch,
    _isAuthFailure, _showSessionExpired, _resetAliveProbe,
    // data
    loadShipment, lookupItemByReference, resolveUnexpected, initData,
  };

  // ===========================================================================
  // 17. BOOT  (copied from Pick §9)
  // ===========================================================================

  captureSessionId();
  (async () => {
    for (let i = 0; i < 50 && !_sessionId; i++) {
      await new Promise(r => setTimeout(r, 100));
      captureSessionId();
    }
  })();

  let _attempts = 0;
  function tryInject() {
    if (document.querySelector('div.sidebar nav li.nav-item')) { injectNav(); return; }
    if (++_attempts < 80) setTimeout(tryInject, 500);
  }

  new MutationObserver(() => {
    if (!document.getElementById('mpp-nav') && document.querySelector('div.sidebar nav li.nav-item')) {
      injectNav();
    }
    // Angular re-renders the tab bar on a route change, taking our chip with it. If a
    // session is open, put it back — otherwise the only way back to a part-scanned
    // pallet is the sidebar launcher, and the operator has no reason to know that.
    const rootEl = document.getElementById('mpp-root');
    if (rootEl && !document.getElementById('mpp-tab-li')) {
      ensureTabChip();
      if (rootEl.style.display !== 'none') {
        const chip = document.getElementById('mpp-tab-li');
        chip?.classList.add('active');
        chip?.querySelector('a.nav-link')?.classList.add('active');
        positionRootSettled();
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  tryInject();

})();

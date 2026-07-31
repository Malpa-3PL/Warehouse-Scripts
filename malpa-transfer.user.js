// ==UserScript==
// @name         Malpa Transfer
// @namespace    https://malpa.canary7.com
// @version      2.1.0
// @description  Location-to-location stock transfer for Canary7 WMS - TC51 optimised
// @author       Malpa 3PL
// @homepageURL  https://github.com/zaynnev/malpa3pl
// @supportURL   https://github.com/zaynnev/malpa3pl/issues
// @updateURL    https://raw.githubusercontent.com/zaynnev/malpa3pl/main/malpa-transfer.user.js
// @downloadURL  https://raw.githubusercontent.com/zaynnev/malpa3pl/main/malpa-transfer.user.js
// @match        https://*.canary7.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* =============================================================================
 * v2.1.0 - location lookup moved onto the legacy monolith; on-screen console
 *          replaced by a plain success/error banner for the picker.
 *   - v2.0.0 called /inbound/api/wms/v1/location and got a 404. "inbound" is a
 *     SERVICE NAME used by the Malpa proxy (`/canary7/<service>/<path>`), not a
 *     real URL on the tenant. Locations are served by the legacy monolith at
 *     index.php?r=configuration/location - same base as every other call here.
 *   - That filter is a PREFIX match ("A10-B02" returns S01, S02, S11, ...), so
 *     resolveLocation() requires an exact code match or a partial scan would
 *     silently resolve to the wrong bin.
 *
 * v2.0.0 - rebuilt to match the malpa-pick / malpa-replen house pattern.
 *
 * v1.x never appeared on the device. Three structural reasons, all fixed here:
 *   1. It declared @grant GM_xmlhttpRequest. ANY @grant puts the script in
 *      Tampermonkey's sandbox, so the XHR monkey-patch patched the sandbox's
 *      XMLHttpRequest, never Angular's - the token/base sniffer could not fire.
 *      Every working Malpa script uses @grant none + a hardcoded API base.
 *   2. It guessed the nav DOM. The real target is `div.sidebar nav ul.nav`, and
 *      the click MUST be caught by a document-level capture-phase listener
 *      because Angular swallows clicks on its own nav items.
 *   3. It drew a position:fixed overlay instead of injecting a real C7 tab
 *      (`ul.nav.nav-tabs[role=tablist]` + `div.tab-content`).
 *
 * CONFIRMED API BEHAVIOUR (probed live against company MA-TRL, 31 Jul 2026)
 * -----------------------------------------------------------------------------
 * A transfer is ONE call:
 *   POST /index.php?r=inventory/inventory/adjust
 *   {
 *     "adjustment_type_id": "7",             // 7 = Transfer (adjustment_class 3)
 *     "item_id": 1846,
 *     "item_unit_of_measure_id": 1852,       // the SOURCE record's iuom
 *     "item_unit_of_measure_to_id": 1852,    // same
 *     "location_from_id": 78175,
 *     "location_to_id": 78176,
 *     "quantity": 1,                         // in the RECORD's UOM, not base units
 *     "inventory_status": "available",        // preserve the source record's status
 *     "reason_code": "",
 *     "comment": "...",
 *     "batch_no": "abc123"                   // ONLY when the source record has a batch
 *   }
 *
 * Verified by probing, not assumed:
 *  1. QUANTITY UNITS. `on_hand_quantity` is in BASE units, but the `quantity` you
 *     POST is in the record's OWN UOM. quantity:1 on a Carton record (factor 6)
 *     moved SIX base units. So quantity = baseQty / factor, and it must divide
 *     evenly. Enforced in validateRow().
 *  2. THE RESPONSE LIES. The 200 body echoes the source record as it was BEFORE
 *     the move (stale on_hand_quantity and updated_at). Never verify from the
 *     response - re-read the location. doTransfer() re-reads.
 *  3. BATCHES. batch_no moves exactly that batch and creates/updates a matching
 *     record at the destination with the same batch_id. Other batches untouched.
 *  4. DESTINATION. A matching record (item+location+uom+batch+status) is
 *     incremented, else created. Draining a source record to 0 deletes it.
 *  5. LICENCE PLATES - LIMITATION. The adjust body has no LP field. Where one bin
 *     holds the same item/uom/batch/status under several LPs, the API takes from
 *     the OLDEST and the destination record carries no LP. Confirmed at WDD-02:
 *     it took from o7282 (older), not or7. Such records therefore CANNOT be
 *     addressed individually, so groupRows() MERGES them into one row and warns.
 *  6. Allocated/suspended units cannot be transferred - the cap is
 *     on-hand minus those (movableQty), not on-hand.
 * ========================================================================== */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 0. CONSTANTS
  // ---------------------------------------------------------------------------
  const TAG          = '[MalpaTransfer]';
  const VERSION      = '2.1.0';   // keep in step with @version in the header
  const API_ROOT     = 'https://stgauth.canary7.com';
  const API_BASE     = API_ROOT + '/index.php?r=';
  const WAREHOUSE_ID = 10;                      // 10 = Darra (Malpa's only live WH)
  const TRANSFER_ADJUSTMENT_TYPE_ID = '7';      // 7 = Transfer, adjustment_class 3
  const COMMENT      = 'Malpa Transfer (TC51)';
  const REASON_CODE  = '';
  const MAX_ROWS     = 300;

  console.log(TAG, 'script loaded v' + VERSION);

  // ---------------------------------------------------------------------------
  // 1. AUTH + API LAYER  (page context, @grant none - same as pick/replen)
  // ---------------------------------------------------------------------------
  function getToken() {
    for (const store of [localStorage, sessionStorage]) {
      try {
        for (const key of ['access_token', 'token', 'id_token', 'auth_token']) {
          const v = store.getItem(key);
          if (v && v.length > 20) return v.replace(/^Bearer\s+/i, '').replace(/^"|"$/g, '');
        }
      } catch (_) {}
    }
    return null;
  }

  function mkHeaders() {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${getToken()}`,
      'x-warehouse-id': String(WAREHOUSE_ID),
      'x-reference-id': String(Math.floor(Math.random() * 1e9)),
    };
  }

  async function _handle(res) {
    if (res.status === 401) {
      Log.err('Session expired - log back into Canary7');
      throw new Error('Session expired');
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || body.error || `API error ${res.status}`);
    }
    return res.json();
  }

  async function apiGet(path) {
    const res = await fetch(API_BASE + path, { method: 'GET', headers: mkHeaders() });
    return _handle(res);
  }

  async function apiPost(path, data) {
    const res = await fetch(API_BASE + path, {
      method: 'POST',
      headers: mkHeaders(),
      body: JSON.stringify(data),
    });
    return _handle(res);
  }

  // ---------------------------------------------------------------------------
  // 2. STATE
  // ---------------------------------------------------------------------------
  const State = {
    from: null,      // resolved location record
    to: null,        // resolved location record
    rows: [],        // grouped transferable rows
    busy: false,
    reset() {
      this.from = null;
      this.to = null;
      this.rows = [];
      this.busy = false;
    },
  };

  let R = {};        // DOM refs

  // ---------------------------------------------------------------------------
  // 3. AUDIO  (success / error identifiers)
  // ---------------------------------------------------------------------------
  const Audio = {
    _ctx: null,
    init() {
      if (this._ctx) return;
      try {
        this._ctx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) {
        console.warn(TAG, 'AudioContext unavailable:', e.message);
      }
    },
    _tone(freq, duration, type = 'sine', gainVal = 0.4, startDelay = 0) {
      if (!this._ctx) return;
      try {
        const osc = this._ctx.createOscillator();
        const gain = this._ctx.createGain();
        osc.connect(gain);
        gain.connect(this._ctx.destination);
        osc.type = type;
        osc.frequency.setValueAtTime(freq, this._ctx.currentTime + startDelay);
        gain.gain.setValueAtTime(gainVal, this._ctx.currentTime + startDelay);
        gain.gain.exponentialRampToValueAtTime(0.001, this._ctx.currentTime + startDelay + duration);
        osc.start(this._ctx.currentTime + startDelay);
        osc.stop(this._ctx.currentTime + startDelay + duration);
      } catch (_) {}
    },
    chime(type) {
      this.init();
      if (!this._ctx) return;
      if (this._ctx.state === 'suspended') this._ctx.resume();
      if (type === 'ok') {
        // Two-note ascending rise - transfer committed
        this._tone(660, 0.12, 'sine', 0.3, 0);
        this._tone(880, 0.20, 'sine', 0.4, 0.13);
      } else if (type === 'scan') {
        this._tone(880, 0.10, 'sine', 0.25, 0);
      } else if (type === 'warn') {
        // Neutral - read it, nothing moved
        this._tone(560, 0.16, 'triangle', 0.28, 0);
      } else if (type === 'error') {
        // Short double buzz
        this._tone(180, 0.08, 'square', 0.3, 0.00);
        this._tone(180, 0.08, 'square', 0.3, 0.12);
      }
    },
  };

  function buzz(kind) {
    if (!navigator.vibrate) return;
    navigator.vibrate(kind === 'error' ? [60, 30, 60] : [30]);
  }

  // ---------------------------------------------------------------------------
  // 4. LOG  (browser console only - diagnostics for us, not for the picker)
  // ---------------------------------------------------------------------------
  const Log = {
    info: (m) => console.log(TAG, m),
    ok: (m) => console.log(TAG, '✓ ' + m),
    err: (m) => console.error(TAG, '✗ ' + m),
    warn: (m) => console.warn(TAG, '! ' + m),
    step: (m) => console.log(TAG, '→ ' + m),
  };

  // ---------------------------------------------------------------------------
  // 4b. STATUS BANNER  (what the picker actually sees when a task finishes)
  // ---------------------------------------------------------------------------
  const Status = {
    el: null,
    setEl(e) { this.el = e; this.clear(); },
    clear() {
      if (!this.el) return;
      this.el.style.display = 'none';
      this.el.innerHTML = '';
      this.el.className = 'mtr-status';
    },
    /* kind: ok | err | warn.  lines[] = optional detail, one per row. */
    show(kind, title, lines) {
      if (!this.el) return;
      this.el.className = 'mtr-status mtr-status-' + kind;
      this.el.style.display = 'block';
      const mark = kind === 'ok' ? '✓' : (kind === 'err' ? '✗' : '!');
      let html = '<div class="mtr-status-title">' + mark + ' ' + _esc(title) + '</div>';
      const list = (lines || []).filter(Boolean);
      if (list.length) {
        html += '<div class="mtr-status-lines">' +
          list.map((l) => '<div>' + _esc(l) + '</div>').join('') + '</div>';
      }
      this.el.innerHTML = html;
      this.el.scrollTop = 0;
    },
  };

  // ---------------------------------------------------------------------------
  // 5. UTIL
  // ---------------------------------------------------------------------------
  function _esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // TC51 scanners can emit shifted number keys when Android's Shift state sticks
  // during a focus() call ($ instead of 4, % instead of 5, ...). Location codes are
  // full of digits, so an unmangled scan matters. Same fix as malpa-pick.
  const _SHIFT_NUMS = {
    '!': '1', '@': '2', '#': '3', '$': '4', '%': '5',
    '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  };
  function _normaliseScan(val) {
    return String(val || '').split('').map((c) => _SHIFT_NUMS[c] || c).join('');
  }

  // ---------------------------------------------------------------------------
  // 6. DATA
  // ---------------------------------------------------------------------------
  /* Locations come from the LEGACY monolith: index.php?r=configuration/location.
   * NOT /inbound/api/wms/v1/location - that path 404s from the browser (it is a
   * proxy-side route name, not a real URL), which is what broke v2.0.0.
   * The filter is a PREFIX match - "A10-B02" returns S01, S02, S11... - so an
   * exact-code check is mandatory or a partial scan silently picks the wrong bin. */
  async function resolveLocation(code) {
    const clean = String(code || '').trim().toUpperCase();
    if (!clean) throw new Error('No location entered');
    const path = 'configuration/location' +
      '&location_code=' + encodeURIComponent(clean) +
      '&fields=' + encodeURIComponent(
        'id,location_code,warehouse_id,status,location_class_id,allow_multiple_items,enable_license_plate') +
      '&per-page=50';
    const list = await apiGet(path);
    const arr = Array.isArray(list) ? list : [];
    const hit = arr.find((l) => String(l.location_code).toUpperCase() === clean);
    if (!hit) throw new Error('Location "' + clean + '" not found');
    if (String(hit.warehouse_id) !== String(WAREHOUSE_ID)) {
      throw new Error('Location "' + clean + '" is in warehouse ' + hit.warehouse_id +
                      ', not ' + WAREHOUSE_ID);
    }
    if (hit.status !== 1) Log.warn(clean + ' is INACTIVE (status ' + hit.status + ')');
    return hit;
  }

  async function readLocationStock(locationCode) {
    const path = 'inventory/inventory' +
      '&location_code=' + encodeURIComponent(locationCode) +
      '&expand=' + encodeURIComponent('item,batch,itemUnitOfMeasure.unitOfMeasure') +
      '&per-page=' + MAX_ROWS + '&page=1';
    const raw = await apiGet(path);
    return Array.isArray(raw) ? raw : [];
  }

  /* Group records the transfer API cannot tell apart. The adjust call identifies
   * stock by item + location + uom + batch + status, so records differing only by
   * licence plate collapse into one row (see header note 5). */
  function groupRows(records, fromLocationId) {
    const map = new Map();
    for (const r of records) {
      if (String(r.location_id) !== String(fromLocationId)) continue;  // loose filter guard
      const onHand = Number(r.on_hand_quantity) || 0;
      if (onHand <= 0) continue;
      const iuom = r.itemUnitOfMeasure || {};
      const uomName = (iuom.unitOfMeasure && iuom.unitOfMeasure.name) || 'Each';
      const factor = Number(iuom.factor) || 1;
      const batchNo = (r.batch && r.batch.batch_number) || null;
      const status = r.inventory_status || 'available';
      const key = [r.item_id, r.item_unit_of_measure_id, batchNo || '-', status].join('|');
      if (!map.has(key)) {
        map.set(key, {
          key,
          itemId: r.item_id,
          itemCode: (r.item && r.item.item_code) || ('item ' + r.item_id),
          description: (r.item && r.item.description) || '',
          enableBatch: !!(r.item && r.item.enable_batch),
          iuomId: r.item_unit_of_measure_id,
          uomName, factor,
          batchNo,
          batchExpiry: (r.batch && r.batch.expiry) || null,
          status,
          onHand: 0, allocated: 0, suspended: 0,
          lps: [], recordIds: [],
          checked: false, qty: 0,
        });
      }
      const g = map.get(key);
      g.onHand += onHand;
      g.allocated += Number(r.allocated_quantity) || 0;
      g.suspended += Number(r.suspended_quantity) || 0;
      g.recordIds.push(r.id);
      if (r.license_plate_no) g.lps.push(r.license_plate_no);
    }
    const rows = [...map.values()];
    rows.forEach((g) => { g.qty = g.onHand; });
    rows.sort((a, b) =>
      a.itemCode.localeCompare(b.itemCode) || String(a.batchNo).localeCompare(String(b.batchNo)));
    return rows;
  }

  // Allocated / suspended stock cannot be transferred - C7 rejects the move.
  function movableQty(g) {
    return Math.max(0, g.onHand - (g.allocated || 0) - (g.suspended || 0));
  }

  function validateRow(g) {
    const q = Number(g.qty);
    const movable = movableQty(g);
    if (!Number.isFinite(q) || q <= 0) return 'qty must be greater than 0';
    if (!Number.isInteger(q)) return 'qty must be a whole number';
    if (q > g.onHand) return 'only ' + g.onHand + ' on hand';
    if (q > movable) {
      return movable === 0
        ? 'Allocated Stock - none of this line can be moved'
        : 'Allocated Stock - only ' + movable + ' of ' + g.onHand + ' can be moved';
    }
    if (g.factor > 1 && q % g.factor !== 0) {
      return 'qty must be a multiple of ' + g.factor + ' (' + g.uomName + ' of ' + g.factor + ')';
    }
    if (g.enableBatch && !g.batchNo) return 'batch item with no batch on the record - fix in Canary7 first';
    return null;
  }

  // The exact body confirmed by live probing. Separate so it can be unit-tested.
  function buildTransferBody(g, fromId, toId) {
    const body = {
      adjustment_type_id: TRANSFER_ADJUSTMENT_TYPE_ID,
      item_id: g.itemId,
      item_unit_of_measure_id: g.iuomId,
      item_unit_of_measure_to_id: g.iuomId,
      location_from_id: fromId,
      location_to_id: toId,
      quantity: g.qty / g.factor,        // API wants the record's own UOM
      inventory_status: g.status,
      reason_code: REASON_CODE,
      comment: COMMENT,
    };
    if (g.batchNo) body.batch_no = g.batchNo;
    return body;
  }

  function performTransfer(g, fromId, toId) {
    return apiPost('inventory/inventory/adjust', buildTransferBody(g, fromId, toId));
  }

  // ---------------------------------------------------------------------------
  // 7. CSS  (mirrors C7's own tokens: #20a8d8 primary, Roboto, square corners)
  // ---------------------------------------------------------------------------
  function injectCSS() {
    if (document.getElementById('mtr-styles')) return;
    const style = document.createElement('style');
    style.id = 'mtr-styles';
    style.textContent = `
      #mtr-tab-view {
        display: flex; flex-direction: column;
        height: calc(100vh - 55px); max-height: 100vh;
        overflow: hidden; background: #fff; padding: 0; position: relative;
      }
      #mtr-root {
        flex: 1; display: flex; flex-direction: column; overflow: hidden;
        font-family: Roboto, sans-serif; font-size: .875rem; color: #384042;
        box-sizing: border-box; min-width: 0;
      }
      #mtr-root *, #mtr-root *::before, #mtr-root *::after { box-sizing: border-box; }
      #mtr-root input[inputmode="none"] { caret-color: transparent; }

      /* -- Sidebar nav item: same pattern as Malpa Pick -- */
      #mtr-nav-li { order: -1; }
      #mtr-nav {
        display: flex !important; align-items: center; gap: 10px; padding: 10px 12px;
        color: #5cd6a9 !important; font-weight: 500; cursor: pointer;
        transition: background .1s; text-decoration: none !important; position: relative;
      }
      #mtr-nav:hover { background: rgba(92,214,169,.08); }
      #mtr-nav .mtr-nav-icon {
        width: 20px; height: 20px; flex-shrink: 0; display: flex;
        align-items: center; justify-content: center;
      }
      #mtr-nav .mtr-nav-label { font-size: 17px; font-weight: 500; }

      /* -- Buttons -- */
      #mtr-root .mtr-btn {
        display: inline-flex; align-items: center; justify-content: center;
        min-height: 44px; padding: .5rem 1rem; font-size: .875rem; font-weight: 400;
        font-family: Roboto, sans-serif; border: 1px solid transparent; border-radius: 0;
        cursor: pointer; transition: all .2s ease-in-out; white-space: nowrap; width: 100%;
        -webkit-tap-highlight-color: transparent; touch-action: manipulation;
      }
      #mtr-root .mtr-btn:active { opacity: .85; }
      #mtr-root .mtr-btn-primary { background: #20a8d8; border-color: #20a8d8; color: #fff; }
      #mtr-root .mtr-btn-primary:disabled { opacity: .55; cursor: not-allowed; }
      #mtr-root .mtr-btn-go { background: #12833f; border-color: #12833f; color: #fff;
        font-size: 1rem; font-weight: 500; min-height: 50px; letter-spacing: .02em; }
      #mtr-root .mtr-btn-go:disabled { background: #9fb0ba; border-color: #9fb0ba; }
      #mtr-root .mtr-btn-secondary { background: #fff; border-color: #e1e6ef; color: #384042; }

      /* -- Cards / scan rows -- */
      .mtr-card { background: #fff; border: 1px solid #e1e6ef; margin: 0 0 8px; flex-shrink: 0; }
      .mtr-card-label {
        display: block; padding: 7px 10px 0; font-size: 10px; font-weight: 600;
        letter-spacing: .08em; text-transform: uppercase; color: #9faecb;
      }
      .mtr-scanrow { display: flex; gap: 6px; padding: 5px 10px 8px; }
      .mtr-scanrow input {
        flex: 1; min-width: 0; font: 500 18px/1 monospace; padding: 11px 10px;
        border: 2px solid #e1e6ef; border-radius: 0; text-transform: uppercase;
        background: #fff; color: #020202; outline: none; min-height: 44px;
        -webkit-tap-highlight-color: transparent;
      }
      .mtr-scanrow input:focus { border-color: #20a8d8; }
      .mtr-scanrow input.mtr-armed { border-color: #20a8d8; background: #f0f8fd; }
      .mtr-scanrow button {
        flex: 0 0 auto; background: #f0f2f5; border: 1px solid #e1e6ef;
        padding: 0 13px; font: 500 13px Roboto, sans-serif; color: #20455c;
        min-height: 44px; cursor: pointer; -webkit-tap-highlight-color: transparent;
      }
      .mtr-loc-msg { padding: 0 10px 8px; font-size: 12px; font-weight: 500; }
      .mtr-loc-msg.ok { color: #12833f; }
      .mtr-loc-msg.bad { color: #ff5454; }

      /* -- Row list -- */
      .mtr-rows-wrap { flex: 1; min-height: 60px; overflow-y: auto; -webkit-overflow-scrolling: touch;
        border-top: 1px solid #e1e6ef; }
      .mtr-tablehead {
        display: flex; align-items: center; gap: 8px; padding: 7px 10px;
        background: #f0f2f5; border-bottom: 1px solid #e1e6ef;
        font-size: 12px; font-weight: 600; color: #40607a; position: sticky; top: 0; z-index: 2;
      }
      .mtr-tablehead .mtr-count { margin-left: auto; font-weight: 500; color: #9faecb; }
      .mtr-row {
        display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px;
        border-bottom: 1px solid #edf1f5; background: #fff;
      }
      .mtr-row.mtr-on { background: #f0f8fd; }
      /* Allocated stock cannot be fully moved - make it impossible to miss. */
      .mtr-row.mtr-allocrow { background: #fdecea; border-left: 5px solid #c5221f; }
      .mtr-row.mtr-allocrow .mtr-sku { color: #b3261e; }
      .mtr-allocmsg {
        color: #c5221f; font: 600 12px/1.25 Roboto, sans-serif; margin-top: 3px;
        text-transform: uppercase; letter-spacing: .03em;
      }
      .mtr-allocmsg small {
        display: block; font: 500 11px Roboto, sans-serif; text-transform: none;
        letter-spacing: 0; margin-top: 1px;
      }
      .mtr-cb { flex: 0 0 auto; width: 26px; height: 26px; margin: 2px 0 0; }
      .mtr-mid { flex: 1; min-width: 0; }
      .mtr-sku { font: 700 15px/1.2 monospace; word-break: break-all; }
      .mtr-desc { font-size: 12px; color: #9faecb; margin-top: 2px; overflow-wrap: anywhere; }
      .mtr-meta { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px; }
      .mtr-tag {
        font-size: 10px; font-weight: 600; padding: 2px 5px; background: #eef1f5;
        color: #44607a; text-transform: uppercase; letter-spacing: .03em;
      }
      .mtr-tag.mtr-batch { background: #e5f0ff; color: #14549b; }
      .mtr-tag.mtr-lp { background: #f0e6ff; color: #5b2ea8; }
      .mtr-tag.mtr-stat { background: #ffe4e0; color: #a3311f; }
      .mtr-right { flex: 0 0 auto; width: 88px; text-align: right; }
      .mtr-right input {
        width: 100%; font: 700 18px/1 monospace; text-align: right; padding: 10px 6px;
        border: 2px solid #e1e6ef; border-radius: 0; background: #fff; outline: none;
      }
      .mtr-right input:focus { border-color: #20a8d8; }
      .mtr-onhand { font-size: 11px; color: #9faecb; margin-top: 3px; }
      .mtr-err { font-size: 11px; color: #ff5454; font-weight: 600; margin-top: 3px; }
      .mtr-empty { padding: 18px 10px; text-align: center; color: #9faecb; font-size: 13px; }

      /* -- Footer + status banner -- */
      .mtr-foot { flex-shrink: 0; border-top: 1px solid #e1e6ef; background: #fff; padding: 8px 10px 10px; }
      .mtr-status {
        display: none; padding: 10px 12px; margin-bottom: 8px; border-left: 5px solid;
        max-height: 132px; overflow-y: auto; -webkit-overflow-scrolling: touch;
      }
      .mtr-status-title { font: 600 15px/1.3 Roboto, sans-serif; }
      .mtr-status-lines {
        margin-top: 5px; font: 500 12px/1.5 Roboto, sans-serif; opacity: .9;
        overflow-wrap: anywhere;
      }
      .mtr-status-ok   { background: #eaf7ee; border-color: #12833f; color: #12833f; }
      .mtr-status-err  { background: #fdecea; border-color: #c5221f; color: #b3261e; }
      .mtr-status-warn { background: #fff8e6; border-color: #d99400; color: #8a5a00; }

      #mtr-veil {
        position: absolute; inset: 0; background: rgba(255,255,255,.7); display: none;
        align-items: center; justify-content: center; gap: 10px;
        font: 500 14px Roboto, sans-serif; color: #20a8d8; z-index: 300;
      }
      #mtr-tab-view.mtr-busy #mtr-veil { display: flex; }
      .mtr-spinner {
        display: inline-block; width: 20px; height: 20px; border: 2px solid #e1e6ef;
        border-top-color: #20a8d8; border-radius: 50%; animation: mtr-spin .7s linear infinite;
      }
      @keyframes mtr-spin { to { transform: rotate(360deg); } }
    `;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // 8. NAV INJECTION  (document-level capture click - Angular eats direct ones)
  // ---------------------------------------------------------------------------
  let _navClickAttached = false;
  function _attachNavClickListener() {
    if (_navClickAttached) return;
    _navClickAttached = true;
    document.addEventListener('click', (e) => {
      const nav = document.getElementById('mtr-nav');
      if (!nav) return;
      if (nav === e.target || nav.contains(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        openTransfer();
      }
    }, true);
  }

  const NAV_ICON =
    '<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 7h11l-3-3"/><path d="M17 13H6l3 3"/></svg>';

  function injectNav() {
    _attachNavClickListener();
    if (document.getElementById('mtr-nav')) return;
    const ul = document.querySelector('div.sidebar nav ul.nav');
    if (!ul) return;
    const li = document.createElement('li');
    li.id = 'mtr-nav-li';
    li.className = 'nav-item ng-star-inserted';
    const a = document.createElement('a');
    a.id = 'mtr-nav';
    a.className = 'nav-link ng-star-inserted';
    a.setAttribute('href', 'javascript:void(0)');
    a.innerHTML = `<span class="mtr-nav-icon">${NAV_ICON}</span>` +
                  `<span class="mtr-nav-label">Malpa Transfer</span>`;
    li.appendChild(a);
    ul.insertBefore(li, ul.firstChild);
    console.log(TAG, 'sidebar nav item injected');
  }

  // ---------------------------------------------------------------------------
  // 9. SHELL  (real C7 tab; falls back to an overlay if no tab bar on screen)
  // ---------------------------------------------------------------------------
  function measureHeight() {
    const panel = document.getElementById('mtr-tab-view');
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const available = Math.floor(window.innerHeight - rect.top);
    if (available > 100) {
      panel.style.height = available + 'px';
      panel.style.maxHeight = available + 'px';
      panel.style.minHeight = available + 'px';
    }
  }

  function buildShell() {
    if (document.getElementById('mtr-tab-view')) return true;

    const tabBar = document.querySelector('ul.nav.nav-tabs[role="tablist"]');
    const tabContent = document.querySelector('div.tab-content');

    const panel = document.createElement('div');
    panel.id = 'mtr-tab-view';
    panel.innerHTML = `<div id="mtr-root"></div>
      <div id="mtr-veil"><span class="mtr-spinner"></span><span>Working...</span></div>`;

    if (tabBar && tabContent) {
      // Remember what was active so we can restore it exactly on close.
      R._prevActiveLi = tabBar.querySelector('li.nav-item.active');
      R._prevActivePanel = tabContent.querySelector(':scope > .tab-pane.active, :scope > tab.active');

      tabBar.querySelectorAll('li.nav-item').forEach((li) => {
        li.classList.remove('active');
        const a = li.querySelector('a.nav-link');
        if (a) { a.classList.remove('active'); a.setAttribute('aria-selected', 'false'); }
      });
      tabContent.querySelectorAll(':scope > tab, :scope > .tab-pane').forEach((p) => {
        p.classList.remove('active');
        p.style.display = 'none';
      });

      const tabLi = document.createElement('li');
      tabLi.id = 'mtr-tab-li';
      tabLi.className = 'nav-item active';
      tabLi.innerHTML = `
        <a class="nav-link active" aria-selected="true" href="javascript:void(0)"
           style="display:inline-flex;align-items:center;gap:6px;padding-right:8px;">
          Malpa Transfer
          <span id="mtr-tab-close" title="Close (Esc)" style="display:inline-flex;align-items:center;
            justify-content:center;width:18px;height:18px;font-size:14px;line-height:1;color:#384042;
            cursor:pointer;opacity:.6;margin-left:2px;-webkit-tap-highlight-color:transparent;">x</span>
        </a>`;
      tabBar.appendChild(tabLi);
      tabLi.querySelector('#mtr-tab-close').addEventListener('click', (e) => {
        e.stopPropagation();
        closeUI();
      });

      panel.className = 'tab-pane active';
      tabContent.appendChild(panel);
      R._mode = 'tab';
    } else {
      // No tab bar on this screen - fall back to a full-screen panel so the
      // script is still usable rather than silently doing nothing.
      console.warn(TAG, 'no C7 tab bar on this screen - using overlay mode');
      panel.style.cssText =
        'position:fixed;inset:0;z-index:2147483000;background:#fff;display:flex;' +
        'flex-direction:column;';
      panel.innerHTML =
        `<div style="display:flex;align-items:center;gap:8px;background:#20a8d8;color:#fff;padding:9px 12px;flex-shrink:0">
           <div style="flex:1;font:500 15px Roboto,sans-serif">Malpa Transfer</div>
           <button id="mtr-ov-close" style="background:rgba(255,255,255,.18);border:none;color:#fff;
             font-size:19px;line-height:1;width:34px;height:34px;cursor:pointer">&times;</button>
         </div>` + panel.innerHTML;
      document.body.appendChild(panel);
      panel.querySelector('#mtr-ov-close').addEventListener('click', closeUI);
      R._mode = 'overlay';
    }

    document.addEventListener('keydown', onGlobalKey);

    // Minimise the C7 sidebar for maximum TC51 screen space.
    R._sidebarWasMinimized = document.body.classList.contains('sidebar-minimized');
    R._brandWasMinimized = document.body.classList.contains('brand-minimized');
    document.body.classList.add('sidebar-minimized', 'brand-minimized');

    if (R._mode === 'tab') {
      setTimeout(measureHeight, 50);
      window.addEventListener('resize', measureHeight);
    }
    return true;
  }

  function setBusy(on) {
    const panel = document.getElementById('mtr-tab-view');
    if (panel) panel.classList.toggle('mtr-busy', !!on);
    State.busy = !!on;
    refreshGo();
  }

  // ---------------------------------------------------------------------------
  // 10. RENDER
  // ---------------------------------------------------------------------------
  function renderMain() {
    const root = document.getElementById('mtr-root');
    if (!root) return;
    root.innerHTML = `
      <div style="flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;padding:8px 8px 0">
        <div class="mtr-card">
          <span class="mtr-card-label">From location</span>
          <div class="mtr-scanrow">
            <input id="mtr-from" type="text" inputmode="none" autocomplete="off"
                   autocorrect="off" autocapitalize="off" spellcheck="false"
                   placeholder="scan or type" />
            <button id="mtr-from-go">Load</button>
          </div>
          <div class="mtr-loc-msg" id="mtr-from-msg"></div>
        </div>

        <div style="flex:1;min-height:0;display:flex;flex-direction:column;border:1px solid #e1e6ef;
                    background:#fff;margin-bottom:8px;overflow:hidden">
          <div class="mtr-tablehead" id="mtr-tablehead" style="display:none">
            <input type="checkbox" id="mtr-all" class="mtr-cb" title="Select all">
            <span>Select all</span>
            <span class="mtr-count" id="mtr-count"></span>
          </div>
          <div class="mtr-rows-wrap" id="mtr-rows"></div>
        </div>

        <div class="mtr-card">
          <span class="mtr-card-label">To location</span>
          <div class="mtr-scanrow">
            <input id="mtr-to" type="text" inputmode="none" autocomplete="off"
                   autocorrect="off" autocapitalize="off" spellcheck="false"
                   placeholder="scan or type" />
            <button id="mtr-to-go">Check</button>
          </div>
          <div class="mtr-loc-msg" id="mtr-to-msg"></div>
        </div>
      </div>

      <div class="mtr-foot">
        <div class="mtr-status" id="mtr-status"></div>
        <button id="mtr-go" class="mtr-btn mtr-btn-go" disabled>TRANSFER</button>
      </div>`;

    R.root = root;
    R.from = document.getElementById('mtr-from');
    R.to = document.getElementById('mtr-to');
    R.fromMsg = document.getElementById('mtr-from-msg');
    R.toMsg = document.getElementById('mtr-to-msg');
    R.rowsWrap = document.getElementById('mtr-rows');
    R.tablehead = document.getElementById('mtr-tablehead');
    R.all = document.getElementById('mtr-all');
    R.count = document.getElementById('mtr-count');
    R.go = document.getElementById('mtr-go');
    Status.setEl(document.getElementById('mtr-status'));

    const commitFrom = () => loadFrom(R.from.value);
    const commitTo = () => checkTo(R.to.value);

    R.from.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); commitFrom(); }
    });
    R.to.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); commitTo(); }
    });
    document.getElementById('mtr-from-go').addEventListener('click', commitFrom);
    document.getElementById('mtr-to-go').addEventListener('click', commitTo);

    // Arm whichever field the operator last touched, so a scan lands in it.
    [R.from, R.to].forEach((inp) => {
      inp.addEventListener('focus', () => {
        R.from.classList.toggle('mtr-armed', inp === R.from);
        R.to.classList.toggle('mtr-armed', inp === R.to);
        R._armed = inp.id;
      });
    });

    R.all.addEventListener('change', () => {
      const on = R.all.checked;
      State.rows.forEach((r) => { r.checked = on; });
      renderRows();
      Log.info(on ? 'All ' + State.rows.length + ' lines selected' : 'Selection cleared');
    });
    R.go.addEventListener('click', doTransfer);

    Audio.init();
    renderRows();
    setTimeout(() => { R.from.focus(); measureHeight(); }, 80);
  }

  function canGo() {
    return !!(State.from && State.to &&
      String(State.from.id) !== String(State.to.id) &&
      State.rows.some((r) => r.checked));
  }

  function refreshGo() {
    if (!R.go) return;
    R.go.disabled = State.busy || !canGo();
    const n = State.rows.filter((r) => r.checked).length;
    if (R.count) {
      R.count.textContent = State.rows.length ? n + ' of ' + State.rows.length + ' selected' : '';
    }
    if (R.all) R.all.checked = State.rows.length > 0 && n === State.rows.length;
    R.go.textContent = n ? 'TRANSFER ' + n + ' LINE' + (n === 1 ? '' : 'S') : 'TRANSFER';
  }

  function renderRows() {
    if (!R.rowsWrap) return;
    R.rowsWrap.innerHTML = '';
    if (R.tablehead) R.tablehead.style.display = State.rows.length ? 'flex' : 'none';

    if (!State.rows.length) {
      const d = document.createElement('div');
      d.className = 'mtr-empty';
      d.textContent = State.from
        ? 'No stock in ' + State.from.location_code
        : 'Scan a FROM location to list its stock';
      R.rowsWrap.appendChild(d);
      refreshGo();
      return;
    }

    for (const g of State.rows) {
      const err = g.checked ? validateRow(g) : null;
      const hasAlloc = (g.allocated || 0) > 0 || (g.suspended || 0) > 0;

      const row = document.createElement('div');
      row.className = 'mtr-row' + (g.checked ? ' mtr-on' : '') + (hasAlloc ? ' mtr-allocrow' : '');

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'mtr-cb';
      cb.checked = g.checked;
      cb.addEventListener('change', () => { g.checked = cb.checked; renderRows(); });

      const mid = document.createElement('div');
      mid.className = 'mtr-mid';
      const sku = document.createElement('div');
      sku.className = 'mtr-sku';
      sku.textContent = g.itemCode;
      const desc = document.createElement('div');
      desc.className = 'mtr-desc';
      desc.textContent = g.description || '—';
      const meta = document.createElement('div');
      meta.className = 'mtr-meta';
      const tag = (cls, txt) => {
        const s = document.createElement('span');
        s.className = 'mtr-tag ' + cls;
        s.textContent = txt;
        meta.appendChild(s);
      };
      if (g.factor > 1) tag('', g.uomName + ' ×' + g.factor);
      if (g.batchNo) {
        tag('mtr-batch', 'BATCH ' + g.batchNo +
          (g.batchExpiry ? ' · ' + String(g.batchExpiry).slice(0, 10) : ''));
      }
      if (g.status && g.status.toLowerCase() !== 'available') tag('mtr-stat', g.status);
      if (g.lps.length === 1) tag('mtr-lp', 'LP ' + g.lps[0]);
      if (g.lps.length > 1) tag('mtr-lp', g.lps.length + ' LPs: ' + g.lps.join(', '));

      mid.appendChild(sku);
      mid.appendChild(desc);
      if (meta.children.length) mid.appendChild(meta);

      if (hasAlloc) {
        const a = document.createElement('div');
        a.className = 'mtr-allocmsg';
        a.textContent = 'Allocated Stock';
        const s = document.createElement('small');
        const parts = [];
        if (g.allocated > 0) parts.push(g.allocated + ' allocated');
        if (g.suspended > 0) parts.push(g.suspended + ' suspended');
        s.textContent = parts.join(', ') + ' · max movable ' + movableQty(g) + ' of ' + g.onHand;
        a.appendChild(s);
        mid.appendChild(a);
      }
      if (err) {
        const e = document.createElement('div');
        e.className = 'mtr-err';
        e.textContent = err;
        mid.appendChild(e);
      }

      const right = document.createElement('div');
      right.className = 'mtr-right';
      const qty = document.createElement('input');
      qty.type = 'number';
      qty.inputMode = 'numeric';
      qty.min = '0';
      qty.step = String(g.factor > 1 ? g.factor : 1);
      qty.value = String(g.qty);
      qty.addEventListener('input', () => {
        g.qty = qty.value === '' ? 0 : Number(qty.value);
        if (!g.checked && g.qty > 0) g.checked = true;
        refreshGo();
      });
      qty.addEventListener('blur', renderRows);
      const oh = document.createElement('div');
      oh.className = 'mtr-onhand';
      oh.textContent = hasAlloc ? 'max ' + movableQty(g) : 'of ' + g.onHand;
      if (hasAlloc) oh.style.color = '#c5221f';
      right.appendChild(qty);
      right.appendChild(oh);

      row.appendChild(cb);
      row.appendChild(mid);
      row.appendChild(right);
      R.rowsWrap.appendChild(row);
    }
    refreshGo();
  }

  // ---------------------------------------------------------------------------
  // 11. ACTIONS
  // ---------------------------------------------------------------------------
  async function loadFrom(code, opts) {
    const quiet = opts && opts.quiet;
    const clean = _normaliseScan(String(code || '').trim()).toUpperCase();
    if (R.from) R.from.value = clean;
    if (R.fromMsg) { R.fromMsg.className = 'mtr-loc-msg'; R.fromMsg.textContent = ''; }
    State.rows = [];
    renderRows();
    if (!clean) { State.from = null; refreshGo(); return; }
    if (!quiet) { Audio.chime('scan'); Status.clear(); }
    setBusy(true);
    try {
      const loc = await resolveLocation(clean);
      State.from = loc;
      R.fromMsg.className = 'mtr-loc-msg ok';
      R.fromMsg.textContent = 'FROM ' + loc.location_code + ' (id ' + loc.id + ')';

      const recs = await readLocationStock(loc.location_code);
      State.rows = groupRows(recs, loc.id);
      renderRows();

      if (!State.rows.length) {
        if (!quiet) Status.show('warn', loc.location_code + ' is empty', ['Nothing here to transfer.']);
        Audio.chime('warn');
      } else {
        const total = State.rows.reduce((s, r) => s + r.onHand, 0);
        Log.ok('FROM ' + loc.location_code + ': ' + State.rows.length + ' lines, ' + total + ' units');
        // Surface the two things a picker can't infer from the rows alone.
        const notes = [];
        State.rows.filter((r) => r.lps.length > 1).forEach((r) =>
          notes.push(r.itemCode + ': ' + r.lps.length + ' licence plates merged - Canary7 takes ' +
            'from the oldest (' + r.lps[0] + ') and the destination gets no LP'));
        State.rows.filter((r) => movableQty(r) < r.onHand).forEach((r) =>
          notes.push(r.itemCode + ': allocated stock, max movable ' + movableQty(r) + ' of ' + r.onHand));
        if (notes.length && !quiet) Status.show('warn', 'Check these lines before moving', notes);
        if (!quiet && R.to) setTimeout(() => R.to.focus(), 60);
      }
    } catch (e) {
      State.from = null;
      const msg = String((e && e.message) || e);
      R.fromMsg.className = 'mtr-loc-msg bad';
      R.fromMsg.textContent = msg;
      Log.err('FROM ' + clean + ': ' + msg);
      Status.show('err', 'From location: ' + msg, ['Scanned: ' + clean]);
      Audio.chime('error');
      buzz('error');
    } finally {
      setBusy(false);
      refreshGo();
    }
  }

  async function checkTo(code) {
    const clean = _normaliseScan(String(code || '').trim()).toUpperCase();
    if (R.to) R.to.value = clean;
    if (R.toMsg) { R.toMsg.className = 'mtr-loc-msg'; R.toMsg.textContent = ''; }
    if (!clean) { State.to = null; refreshGo(); return; }
    Audio.chime('scan');
    setBusy(true);
    try {
      const loc = await resolveLocation(clean);
      if (State.from && String(loc.id) === String(State.from.id)) {
        throw new Error('TO is the same as FROM');
      }
      State.to = loc;
      R.toMsg.className = 'mtr-loc-msg ok';
      R.toMsg.textContent = 'TO ' + loc.location_code + ' (id ' + loc.id + ')';
      Log.ok('TO ' + loc.location_code + ' ready');
      if (loc.allow_multiple_items === 0) {
        Status.show('warn', loc.location_code + ' holds one item only',
          ['A mixed transfer into this bin may be rejected.']);
      }
    } catch (e) {
      State.to = null;
      const msg = String((e && e.message) || e);
      R.toMsg.className = 'mtr-loc-msg bad';
      R.toMsg.textContent = msg;
      Log.err('TO ' + clean + ': ' + msg);
      Status.show('err', 'To location: ' + msg, ['Scanned: ' + clean]);
      Audio.chime('error');
      buzz('error');
    } finally {
      setBusy(false);
      refreshGo();
    }
  }

  async function doTransfer() {
    if (State.busy) return;
    if (!State.from) {
      Status.show('err', 'Scan a FROM location first'); Audio.chime('error'); buzz('error'); return;
    }
    if (!State.to) {
      Status.show('err', 'Scan a TO location first'); Audio.chime('error'); buzz('error'); return;
    }
    if (String(State.from.id) === String(State.to.id)) {
      Status.show('err', 'FROM and TO are the same location');
      Audio.chime('error'); buzz('error');
      return;
    }
    const picked = State.rows.filter((r) => r.checked);
    if (!picked.length) {
      Status.show('warn', 'Nothing moved', ['No lines were ticked.']);
      Audio.chime('warn');
      return;
    }
    const bad = picked.map((r) => ({ r, err: validateRow(r) })).filter((x) => x.err);
    if (bad.length) {
      Status.show('err', 'Nothing moved - fix ' + bad.length +
        ' line' + (bad.length === 1 ? '' : 's'), bad.map((x) => x.r.itemCode + ': ' + x.err));
      bad.forEach((x) => Log.err(x.r.itemCode + ': ' + x.err));
      Audio.chime('error');
      buzz('error');
      return;
    }

    setBusy(true);
    Status.clear();
    Log.step('TRANSFER ' + State.from.location_code + ' → ' + State.to.location_code +
             '  (' + picked.length + ' lines)');

    const failures = [];
    let okCount = 0, failCount = 0;
    // Sequential on purpose: C7 resolves stock oldest-record-first, so parallel
    // calls against one bin could race.
    for (const g of picked) {
      const sendQty = g.qty / g.factor;
      const label = g.itemCode + (g.batchNo ? ' [' + g.batchNo + ']' : '') +
        ' ×' + g.qty + (g.factor > 1 ? ' (' + sendQty + ' ' + g.uomName + ')' : '');
      if (g.lps.length > 1) {
        Log.warn(g.itemCode + ' spans LPs ' + g.lps.join(', ') +
          ' - C7 takes from the oldest and the destination gets no LP');
      }
      try {
        await performTransfer(g, State.from.id, State.to.id);
        okCount++;
        Log.ok(label + ' moved');
      } catch (e) {
        failCount++;
        const why = String((e && e.message) || e);
        failures.push(g.itemCode + (g.batchNo ? ' [' + g.batchNo + ']' : '') + ' - ' + why);
        Log.err(label + ' FAILED - ' + why);
      }
    }

    // The adjust response echoes PRE-move data, so confirm from a fresh read.
    const confirmed = [];
    try {
      const after = await readLocationStock(State.to.location_code);
      const rows = groupRows(after, State.to.id);
      for (const g of picked) {
        const m = rows.find((x) => x.itemId === g.itemId && x.iuomId === g.iuomId &&
          (x.batchNo || null) === (g.batchNo || null) && x.status === g.status);
        if (m) {
          confirmed.push(g.itemCode + (g.batchNo ? ' [' + g.batchNo + ']' : '') +
            ' - ' + State.to.location_code + ' now holds ' + m.onHand);
        }
      }
      Log.info('verified: ' + confirmed.length + '/' + picked.length + ' visible at destination');
    } catch (e) {
      Log.warn('Could not verify destination: ' + ((e && e.message) || e));
    }

    const route = State.from.location_code + ' → ' + State.to.location_code;
    if (failCount === 0) {
      Status.show('ok', okCount + ' line' + (okCount === 1 ? '' : 's') + ' moved to ' +
        State.to.location_code, confirmed);
      Audio.chime('ok');
      buzz('ok');
    } else if (okCount === 0) {
      Status.show('err', 'Transfer failed - nothing moved', failures);
      Audio.chime('error');
      buzz('error');
    } else {
      Status.show('warn', 'Partly done - ' + okCount + ' moved, ' + failCount + ' failed',
        failures.concat(['Moved lines are already at ' + State.to.location_code + '.']));
      Audio.chime('error');
      buzz('error');
    }
    Log.step(route + ': ' + okCount + ' ok, ' + failCount + ' failed');

    setBusy(false);
    // Refresh FROM to reality. quiet:true leaves the result banner on screen.
    await loadFrom(State.from.location_code, { quiet: true });
  }

  // ---------------------------------------------------------------------------
  // 12. FOCUS RECOVERY  (TC51 sleeps / notifications steal focus)
  // ---------------------------------------------------------------------------
  function _refocusScanInput() {
    if (!document.getElementById('mtr-tab-view')) return;
    if (State.busy) return;
    const id = R._armed === 'mtr-to' ? 'mtr-to' : 'mtr-from';
    const el = document.getElementById(id);
    if (!el || !document.contains(el)) return;
    const ae = document.activeElement;
    // Don't steal focus from a qty box the operator is typing in.
    if (ae && ae !== document.body && ae.tagName === 'INPUT' && ae.type === 'number') return;
    if (ae === el) return;
    el.focus();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') setTimeout(_refocusScanInput, 300);
  });
  window.addEventListener('focus', () => setTimeout(_refocusScanInput, 200));
  setInterval(() => { _refocusScanInput(); }, 2500);

  // ---------------------------------------------------------------------------
  // 13. OPEN / CLOSE / KEYBOARD
  // ---------------------------------------------------------------------------
  function openTransfer() {
    if (document.getElementById('mtr-tab-view')) return;
    try {
      injectCSS();
      buildShell();
      renderMain();
      Log.info('Malpa Transfer v' + VERSION + ' · warehouse ' + WAREHOUSE_ID);
      if (!getToken()) {
        Status.show('err', 'Not logged in to Canary7',
          ['Log into Canary7 in this tab, then reopen Malpa Transfer.']);
      }
    } catch (err) {
      console.error(TAG, 'openTransfer error:', err);
      const errDiv = document.createElement('div');
      errDiv.style.cssText = 'position:fixed;top:80px;left:20px;right:20px;z-index:2147483001;' +
        'background:#7f1d1d;color:#fff;padding:16px 20px;font-family:monospace;font-size:13px;' +
        'white-space:pre-wrap;';
      errDiv.textContent = TAG + ' Error: ' + err.message + '\n\n' + err.stack;
      const cls = document.createElement('button');
      cls.textContent = 'x';
      cls.style.cssText = 'float:right;background:none;border:none;color:#fff;font-size:20px;cursor:pointer';
      cls.onclick = () => errDiv.remove();
      errDiv.prepend(cls);
      document.body.appendChild(errDiv);
    }
  }

  function closeUI() {
    document.removeEventListener('keydown', onGlobalKey);
    window.removeEventListener('resize', measureHeight);

    if (!R._sidebarWasMinimized) document.body.classList.remove('sidebar-minimized');
    if (!R._brandWasMinimized) document.body.classList.remove('brand-minimized');

    document.getElementById('mtr-tab-li')?.remove();
    document.getElementById('mtr-tab-view')?.remove();

    // Restore whichever tab + panel was active before we opened.
    if (R._mode === 'tab') {
      if (R._prevActiveLi && document.contains(R._prevActiveLi)) {
        R._prevActiveLi.classList.add('active');
        const a = R._prevActiveLi.querySelector('a.nav-link');
        if (a) { a.classList.add('active'); a.setAttribute('aria-selected', 'true'); }
      } else {
        const tabBar = document.querySelector('ul.nav.nav-tabs[role="tablist"]');
        const lastLi = tabBar && Array.from(tabBar.querySelectorAll('li.nav-item')).pop();
        if (lastLi) {
          lastLi.classList.add('active');
          const a = lastLi.querySelector('a.nav-link');
          if (a) { a.classList.add('active'); a.setAttribute('aria-selected', 'true'); }
        }
      }
      if (R._prevActivePanel && document.contains(R._prevActivePanel)) {
        R._prevActivePanel.classList.add('active');
        R._prevActivePanel.style.display = '';
      } else {
        const tabContent = document.querySelector('div.tab-content');
        const panels = tabContent
          ? Array.from(tabContent.querySelectorAll(':scope > tab, :scope > .tab-pane'))
          : [];
        if (panels.length) {
          const last = panels[panels.length - 1];
          last.classList.add('active');
          last.style.display = '';
        }
      }
    }

    State.reset();
    R = {};
  }

  function onGlobalKey(e) {
    if (!document.getElementById('mtr-tab-view')) return;
    if (e.key === 'Escape') { e.preventDefault(); closeUI(); }
  }

  // ---------------------------------------------------------------------------
  // 14. DEBUG HANDLE  (troubleshooting on-device + offline test harness)
  // ---------------------------------------------------------------------------
  window.__malpaTransfer = {
    VERSION, State, Status, open: openTransfer, close: closeUI,
    apiGet, apiPost, getToken,
    groupRows, validateRow, movableQty, buildTransferBody,
    resolveLocation, readLocationStock, injectNav,
    apiBase: () => API_BASE, warehouseId: () => String(WAREHOUSE_ID),
    hasToken: () => !!getToken(), normaliseScan: _normaliseScan,
    CONFIG: { transferAdjustmentTypeId: TRANSFER_ADJUSTMENT_TYPE_ID, comment: COMMENT },
  };

  // ---------------------------------------------------------------------------
  // 15. BOOT  (retry until Angular renders the sidebar, then keep watching)
  // ---------------------------------------------------------------------------
  let _attempts = 0;
  function tryInject() {
    if (document.querySelector('div.sidebar nav li.nav-item')) {
      injectCSS();
      injectNav();
      return;
    }
    if (++_attempts < 80) setTimeout(tryInject, 500);
  }

  // Angular tears the sidebar down and rebuilds it on route change - re-inject.
  if (typeof MutationObserver === 'function' && document.body) {
    new MutationObserver(() => {
      if (!document.getElementById('mtr-nav') &&
          document.querySelector('div.sidebar nav li.nav-item')) {
        injectNav();
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  tryInject();
})();

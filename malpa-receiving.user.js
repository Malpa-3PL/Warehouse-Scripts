// ==UserScript==
// @name         Malpa Receiving
// @namespace    https://malpa.canary7.com
// @version      2.0.0
// @description  Fast receiving interface for Canary7 WMS - TC51 optimised
// @author       Malpa 3PL
// @updateURL    https://raw.githubusercontent.com/zaynnev/malpa3pl/main/malpa-receiving.user.js
// @downloadURL  https://raw.githubusercontent.com/zaynnev/malpa3pl/main/malpa-receiving.user.js
// @match        https://*.canary7.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 0. CONSTANTS
  // ---------------------------------------------------------------------------

  const API_BASE     = 'https://stgauth.canary7.com/index.php?r=';
  const WMS_BASE     = 'https://malpa.canary7.com/inbound/api/wms/v1/';
  const WAREHOUSE_ID = 10;

  // Receiving profile is ALWAYS Putaway (one-step: check in + locate together).
  // Matched by receiving_process === 3, name fallback 'Putaway'.
  const PUTAWAY_PROCESS_ID = 3;

  // Storage location class - the only class an operator may put away into.
  const STORAGE_CLASS_ID = 1;

  // The location endpoint pages at 20 rows unless per-page is supplied.
  const LOCATION_PAGE_SIZE = 200;

  // QUANTITY SEMANTICS - confirmed against a live factor-6 receive:
  // the `quantity` sent to checkin is in BASE units, NOT in the selected UoM.
  // A 100-each line received as 10 cartons (factor 6) posts quantity=60 with
  // item_unit_of_measure_id set to the carton UoM, and the line's open_quantity
  // drops 100 -> 40. So the operator types base units, and when the selected UoM
  // has factor > 1 that number must divide evenly by the factor.

  // The receipt_detail object C7 expects inside the checkin body - EXACTLY these keys.
  // The header expand hangs a nested `item` (and friends) off each detail; sending
  // that back would bloat the payload and can trip C7's model validation, so the
  // detail is whitelisted down to these fields before every write.
  const DETAIL_KEYS = [
    'id', 'receipt_header_id', 'item_id', 'quantity', 'erp_order_line_number',
    'receipt_date', 'created_at', 'updated_at', 'created_by', 'updated_by',
    'open_quantity', 'locating_rule_id', 'line_item_id', 'expected_batch_no',
    'presale', 'order_line_number', 'automatic_locating_assignment', 'line_number',
    'original_qty', 'allocation_reference', 'expected_batch_expiry', 'reason_code',
    'comments', 'custom_field_1', 'custom_field_2',
  ];

  function sanitizeDetail(detail) {
    const out = {};
    for (const k of DETAIL_KEYS) out[k] = detail?.[k] ?? null;
    return out;
  }

  // Locating-rule responses that mean "no existing home for this item".
  const NO_LOCATION_TOKENS = ['new', 'n/a', 'none', ''];

  // ---------------------------------------------------------------------------
  // 1. AUTH + API LAYER   (lifted from Malpa Pick 4.9.0 - same session plumbing)
  // ---------------------------------------------------------------------------

  function getToken() {
    for (const store of [localStorage, sessionStorage]) {
      try {
        for (const key of ['access_token', 'token', 'id_token', 'auth_token']) {
          const v = store.getItem(key);
          if (v && v.length > 20) return v;
        }
      } catch (_) {}
    }
    return null;
  }

  let _sessionId = null;

  function captureSessionId() {
    if (_sessionId) return;
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
    // Steal x-session-id off the next Angular XHR
    if (!window._mrcXHRPatched) {
      window._mrcXHRPatched = true;
      const origSet = XMLHttpRequest.prototype.setRequestHeader;
      XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        if (name.toLowerCase() === 'x-session-id' && value && !_sessionId) {
          _sessionId = String(value);
          XMLHttpRequest.prototype.setRequestHeader = origSet;
          window._mrcXHRPatched = false;
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

  async function _handle(res) {
    if (res.status === 401) {
      _showSessionExpired();
      throw new Error('Session expired');
    }
    if (res.status === 404) {
      const e = new Error('Not found');
      e.notFound = true;
      throw e;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const e = new Error(body.message || `API error ${res.status}`);
      // C7 returns business rejections as a 500 carrying a numeric `code`
      // (e.g. 1087 "Multiple Items not allowed in this location"). Those are
      // deterministic refusals, NOT transport failures - never retry them.
      if (body.code !== undefined && body.code !== null) e.c7Code = body.code;
      e.httpStatus = res.status;
      throw e;
    }
    return res.json();
  }

  async function apiGet(path) {
    await waitForSession();
    return _handle(await fetch(API_BASE + path, { method: 'GET', headers: mkHeaders() }));
  }

  async function apiPost(path, data) {
    await waitForSession();
    return _handle(await fetch(API_BASE + path, {
      method: 'POST', headers: mkHeaders(), body: JSON.stringify(data),
    }));
  }

  // Second Canary7 surface - location master lives here, not on index.php?r=
  async function wmsGet(path) {
    await waitForSession();
    return _handle(await fetch(WMS_BASE + path, { method: 'GET', headers: mkHeaders() }));
  }

  let _sessionExpiredShown = false;
  function _showSessionExpired() {
    if (_sessionExpiredShown) return;
    _sessionExpiredShown = true;
    const root = document.getElementById('mrc-root');
    if (!root) return;
    const banner = document.createElement('div');
    banner.style.cssText = [
      'position:absolute;inset:0;z-index:9999;background:rgba(0,0,0,.78)',
      'display:flex;flex-direction:column;align-items:center;justify-content:center',
      'padding:24px;gap:14px;text-align:center',
    ].join(';');
    banner.innerHTML = `
      <div style="font-size:20px;font-weight:700;color:#fff">LOCKED</div>
      <div style="font-size:18px;font-weight:700;color:#fff">Session Expired</div>
      <div style="font-size:13px;color:rgba(255,255,255,.75);line-height:1.5">
        Your C7 session has timed out.<br>Log back in to continue receiving.
      </div>
      <button id="mrc-session-dismiss" style="margin-top:8px;padding:12px 24px;background:#20a8d8;
        color:#fff;border:none;font-size:15px;font-weight:600;font-family:Roboto,sans-serif;
        cursor:pointer;border-radius:4px;">Dismiss</button>`;
    root.style.position = 'relative';
    root.appendChild(banner);
    document.getElementById('mrc-session-dismiss')?.addEventListener('click', () => {
      banner.remove();
      _sessionExpiredShown = false;
      State.resetReceipt();
      renderReceiptEntry();
    });
  }

  // ---------------------------------------------------------------------------
  // 2. STATE
  // ---------------------------------------------------------------------------

  const State = {
    screen: 'RECEIPT_ENTRY',

    profile:   null,   // Putaway receiving profile
    header:    null,   // receipt header record
    receiptId: '',     // exactly what the operator scanned, uppercased
    companyId: null,
    details:   [],     // receiptDetails, open_quantity maintained locally

    // Caches - each fetched ONCE per receipt / per session
    itemsById:  {},    // item_id  -> item (with itemUnitOfMeasures expanded)
    refMap:     {},    // barcode/ref lower -> { itemId, uomId }
    locByCode:  {},    // LOCATION-CODE -> location record
    locsLoaded: false,

    // Current line being received
    cur: null,         // { detail, item, uom, qty, batchNo, expiry, location, suggested }

    // Keep Location - overrides the suggestion with the last location used
    keepLocation: (() => {
      try { return sessionStorage.getItem('mrc_keeploc') === '1'; } catch (_) { return false; }
    })(),
    lastLocation: null,

    voiceEnabled: (() => {
      try { const v = sessionStorage.getItem('mrc_voice'); return v === null ? true : v === '1'; }
      catch (_) { return true; }
    })(),

    done: 0,           // check-ins performed against this receipt
    totalLines: 0,     // open lines at load - stable progress denominator
    linesDone: new Set(), // detail ids driven fully to zero (accurate line count)
    failedItems: [],   // item codes whose verify call failed - must be surfaced

    resetReceipt() {
      this.header = null;
      this.receiptId = '';
      this.companyId = null;
      this.details = [];
      this.itemsById = {};
      this.refMap = {};
      this.cur = null;
      this.done = 0;
      this.totalLines = 0;
      this.linesDone = new Set();
      this.failedItems = [];
      // keepLocation / lastLocation / voice deliberately persist
    },
  };

  let R = {};   // live DOM refs

  // ---------------------------------------------------------------------------
  // 3. CSS
  // ---------------------------------------------------------------------------

  function injectCSS() {
    if (document.getElementById('mrc-styles')) return;
    const style = document.createElement('style');
    style.id = 'mrc-styles';
    style.textContent = `
      #mrc-tab-view {
        display:flex; flex-direction:column;
        height:calc(100vh - 55px); max-height:100vh;
        overflow:hidden; background:#fff; padding:0; position:relative;
      }
      #mrc-root {
        flex:1; display:flex; flex-direction:column; overflow:hidden;
        font-family:Roboto,sans-serif; font-size:.875rem; color:#384042;
        box-sizing:border-box; min-width:0; justify-content:flex-start;
      }
      #mrc-root *, #mrc-root *::before, #mrc-root *::after { box-sizing:border-box; }
      #mrc-root input[inputmode="none"] { caret-color:transparent; -webkit-user-select:text; user-select:text; }

      /* ---- buttons ---- */
      #mrc-root .mrc-btn {
        display:inline-flex; align-items:center; justify-content:center;
        min-height:44px; padding:.5rem 1rem; font-size:.875rem; font-weight:400;
        font-family:Roboto,sans-serif; border:1px solid transparent; border-radius:0;
        cursor:pointer; transition:all .2s ease-in-out; white-space:nowrap; width:100%;
        -webkit-tap-highlight-color:transparent; touch-action:manipulation; text-align:center;
      }
      #mrc-root .mrc-btn:active { opacity:.85; }
      #mrc-root .mrc-btn-primary   { background:#20a8d8; border-color:#20a8d8; color:#fff; }
      #mrc-root .mrc-btn-primary:disabled { opacity:.55; cursor:not-allowed; }
      #mrc-root .mrc-btn-secondary { background:#fff; border-color:#e1e6ef; color:#384042; }
      #mrc-root .mrc-btn-danger    { background:#ff5454; border-color:#ff5454; color:#fff; }

      #mrc-root .mrc-input {
        display:block; width:100%; padding:.5rem .75rem; font-size:16px;
        font-family:Roboto,sans-serif; color:#020202; background:#fff;
        border:1px solid #e1e6ef; border-radius:0; outline:none; min-height:44px;
        transition:border-color .15s ease-in-out; -webkit-tap-highlight-color:transparent;
      }
      #mrc-root .mrc-input:focus { border-color:#8ad4ee; }
      #mrc-root .mrc-input::placeholder { color:#c0cadd; }
      #mrc-root .mrc-input.big {
        font-size:30px; font-weight:700; text-align:center; min-height:56px; letter-spacing:.04em;
      }
      #mrc-root .mrc-input.nolocation { border:2px solid #ff5454; background:#fff8f8; }

      #mrc-root .mrc-select {
        display:block; width:100%; min-height:44px; padding:.5rem .75rem; font-size:15px;
        font-family:Roboto,sans-serif; color:#020202; border:1px solid #e1e6ef;
        border-radius:0; outline:none; -webkit-appearance:none; appearance:none; cursor:pointer;
        background:#fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%239faecb' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 12px center;
      }
      #mrc-root .mrc-select:focus { border-color:#8ad4ee; }

      /* ---- sidebar nav ---- */
      #mrc-nav-li { order:-1; }
      #mrc-nav {
        display:flex !important; align-items:center; gap:10px; padding:10px 12px;
        color:#79c447 !important; font-weight:500; cursor:pointer; transition:background .1s;
        text-decoration:none !important; position:relative;
      }
      #mrc-nav:hover { background:rgba(121,196,71,.10); }
      #mrc-nav .mrc-nav-icon {
        width:20px; height:20px; flex-shrink:0; border-radius:4px; overflow:hidden;
        display:flex; align-items:center; justify-content:center;
      }
      #mrc-nav .mrc-nav-label { font-size:17px; font-weight:500; }

      /* ---- generic screen frame (never scrolls) ---- */
      /* position:relative keeps the keyboard and modal overlays inside the screen
         area, so the action bar underneath stays visible and tappable. */
      .mrc-screen {
        flex:1; min-height:0; display:flex; flex-direction:column; overflow:hidden;
        background:#f5f7fa; position:relative;
      }
      .mrc-hdr { background:#20a8d8; padding:8px 14px 7px; flex-shrink:0; }
      .mrc-hdr.green  { background:#3a8f3a; }
      .mrc-hdr.amber  { background:#d18700; }
      .mrc-hdr.red    { background:#d13b3b; }
      .mrc-hdr-top {
        display:flex; align-items:center; justify-content:space-between; margin-bottom:3px; gap:6px;
      }
      .mrc-hdr-label {
        font-size:10px; font-weight:600; color:rgba(255,255,255,.72);
        text-transform:uppercase; letter-spacing:.08em;
      }
      .mrc-hdr-right { display:flex; align-items:center; gap:6px; flex-shrink:0; }
      .mrc-hdr-prog { font-size:10px; font-weight:600; color:rgba(255,255,255,.72); letter-spacing:.04em; }
      .mrc-hdr-code {
        font-size:22px; font-weight:700; color:#fff; letter-spacing:.03em; line-height:1.1;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
      }
      .mrc-hdr-sub { font-size:10px; color:rgba(255,255,255,.72); font-weight:500; margin-top:1px; }
      .mrc-prog-track { height:3px; background:rgba(255,255,255,.25); width:100%; margin-top:6px; border-radius:2px; }
      .mrc-prog-fill  { height:3px; background:#fff; transition:width .35s ease; min-width:3px; border-radius:2px; }

      .mrc-voice {
        display:inline-flex; align-items:center; justify-content:center;
        width:30px; height:26px; border:none; border-radius:4px;
        background:rgba(255,255,255,.18); color:#fff; font-size:14px; cursor:pointer;
        -webkit-tap-highlight-color:transparent; touch-action:manipulation; flex-shrink:0;
      }
      .mrc-voice.muted { opacity:.45; background:rgba(0,0,0,.15); }

      /* ---- item block ---- */
      .mrc-item {
        padding:10px 14px 8px; flex-shrink:0; background:#fff; border-bottom:1px solid #e1e6ef;
        display:flex; flex-direction:column; align-items:center; text-align:center;
      }
      .mrc-item.verified { background:#f0fff4; border-bottom-color:#79c447; }
      .mrc-item-sku { font-size:16px; font-weight:700; color:#384042; letter-spacing:.01em; }
      .mrc-item-desc {
        font-size:11px; color:#9faecb; font-weight:500; margin-top:1px; line-height:1.25;
        max-height:2.5em; overflow:hidden;
      }
      .mrc-open-row { display:flex; gap:16px; margin-top:6px; align-items:flex-end; }
      .mrc-open-cell { display:flex; flex-direction:column; align-items:center; }
      .mrc-open-lbl {
        font-size:9px; font-weight:600; color:#9faecb; letter-spacing:.08em; text-transform:uppercase;
      }
      .mrc-open-val { font-size:26px; font-weight:700; color:#384042; line-height:1.05; }
      .mrc-open-val.hi { color:#20a8d8; }

      /* ---- body / scan zone ---- */
      .mrc-body {
        flex:1; min-height:0; display:flex; flex-direction:column;
        justify-content:center; padding:10px 16px; gap:8px; overflow:hidden;
      }
      .mrc-zone {
        width:100%; border:2px dashed #20a8d8; background:#f0f8fd; border-radius:6px;
        padding:12px 14px; display:flex; flex-direction:column; align-items:center; gap:5px;
        position:relative;
      }
      .mrc-zone.amber { border-color:#e0a300; background:#fffbef; }
      .mrc-zone.red   { border-color:#ff5454; background:#fff5f5; }
      .mrc-zone-lbl {
        font-size:11px; font-weight:700; color:#20a8d8; text-transform:uppercase; letter-spacing:.1em;
      }
      .mrc-zone.amber .mrc-zone-lbl { color:#ba8a00; }
      .mrc-zone.red   .mrc-zone-lbl { color:#d13b3b; }
      .mrc-arrows { font-size:20px; color:#b8dff5; letter-spacing:4px; line-height:1; }
      .mrc-hidden-in {
        position:absolute; width:1px; height:1px; opacity:0; top:0; left:0;
        caret-color:transparent; -webkit-user-select:text; user-select:text;
      }
      .mrc-fb { font-size:12px; font-weight:600; min-height:17px; text-align:center; }
      .mrc-fb.ok { color:#79c447; } .mrc-fb.err { color:#ff5454; } .mrc-fb.dim { color:#9faecb; }

      .mrc-field-lbl {
        font-size:11px; font-weight:600; color:#9faecb; text-transform:uppercase;
        letter-spacing:.07em; margin-bottom:-2px;
      }
      .mrc-warn-red {
        font-size:12px; font-weight:700; color:#ff5454; text-align:center; letter-spacing:.02em;
      }

      /* ---- keep-location pill ---- */
      .mrc-keep {
        display:flex; align-items:center; justify-content:center; gap:8px;
        padding:8px 12px; border:1px solid #e1e6ef; background:#fff; cursor:pointer;
        -webkit-tap-highlight-color:transparent; touch-action:manipulation; flex-shrink:0;
      }
      .mrc-keep.on { border-color:#79c447; background:#f0fff4; }
      .mrc-keep-box {
        width:18px; height:18px; border:2px solid #9faecb; border-radius:3px; flex-shrink:0;
        display:flex; align-items:center; justify-content:center; font-size:13px;
        font-weight:700; color:#fff; line-height:1;
      }
      .mrc-keep.on .mrc-keep-box { border-color:#79c447; background:#79c447; }
      .mrc-keep-txt { font-size:13px; font-weight:600; color:#384042; }
      .mrc-keep-sub { font-size:11px; color:#9faecb; font-weight:500; }

      /* ---- action bar ---- */
      .mrc-actions {
        display:flex; gap:8px; padding:7px 14px 9px; flex-shrink:0;
        border-top:1px solid #e1e6ef; background:#fff;
      }
      .mrc-actions .mrc-btn { flex:1; min-height:44px; font-size:13px; padding:0 8px; }

      /* ---- overlays ---- */
      .mrc-ov {
        position:absolute; inset:0; background:rgba(0,0,0,.62); display:flex;
        align-items:center; justify-content:center; z-index:200; padding:18px;
      }
      .mrc-ov-card { background:#fff; width:100%; border-radius:8px; overflow:hidden; }
      .mrc-ov-hdr {
        padding:11px 15px; font-size:14px; font-weight:700; color:#fff; background:#ff5454;
      }
      .mrc-ov-body { padding:15px; font-size:13px; color:#384042; line-height:1.5; }
      .mrc-ov-body strong { color:#ff5454; font-weight:700; }
      .mrc-ov-acts { display:flex; flex-direction:column; gap:8px; padding:0 15px 15px; }

      /* ---- edit-location pencil ---- */
      .mrc-edit {
        display:inline-flex; align-items:center; justify-content:center;
        width:30px; height:26px; border:none; border-radius:4px; flex-shrink:0;
        background:rgba(255,255,255,.20); color:#fff; font-size:14px; cursor:pointer;
        -webkit-tap-highlight-color:transparent; touch-action:manipulation;
      }
      .mrc-edit:active { background:rgba(255,255,255,.42); }
      .mrc-hdr-code-row { display:flex; align-items:center; gap:8px; }
      .mrc-hdr-code-row .mrc-hdr-code { flex:1; min-width:0; }

      /* ---- custom on-screen keyboard (native keyboard is suppressed) ---- */
      .mrc-kb-ov {
        position:absolute; inset:0; background:rgba(0,0,0,.45);
        display:flex; align-items:flex-end; z-index:300;
      }
      .mrc-kb {
        width:100%; background:#fff; border-radius:10px 10px 0 0; padding:7px;
        display:flex; flex-direction:column; gap:4px;
        box-shadow:0 -2px 14px rgba(0,0,0,.28);
      }
      .mrc-kb-disp {
        display:flex; flex-direction:column; align-items:center;
        padding:3px 6px 5px; border-bottom:2px solid #e1e6ef;
      }
      .mrc-kb-disp-lbl {
        font-size:10px; font-weight:600; color:#9faecb;
        text-transform:uppercase; letter-spacing:.08em;
      }
      .mrc-kb-disp-val {
        font-size:25px; font-weight:700; color:#384042; letter-spacing:.04em;
        min-height:31px; line-height:1.2; text-align:center; word-break:break-all;
      }
      .mrc-kb-disp-val .cur { color:#20a8d8; font-weight:400; animation:mrc-blink 1s step-end infinite; }
      @keyframes mrc-blink { 50% { opacity:0; } }
      .mrc-kb-row { display:flex; gap:4px; }
      .mrc-kb-key {
        flex:1; min-width:0; height:41px; display:flex; align-items:center;
        justify-content:center; font-size:17px; font-weight:600; color:#384042;
        background:#f5f7fa; border:none; border-radius:5px; cursor:pointer;
        font-family:Roboto,sans-serif; -webkit-tap-highlight-color:transparent;
        touch-action:manipulation; -webkit-user-select:none; user-select:none;
      }
      .mrc-kb-key:active { background:#20a8d8; color:#fff; }
      .mrc-kb-key.del  { background:#fff0f0; color:#d13b3b; }
      .mrc-kb-key.mode { background:#eef2f7; color:#5b6b82; font-size:13px; }
      .mrc-kb-key.go   { background:#20a8d8; color:#fff; flex:2.2; font-size:16px; }
      .mrc-kb-key.go:active { background:#1985ac; }
      /* Numeric layout has far fewer keys, so make them noticeably bigger. */
      .mrc-kb-num .mrc-kb-key { height:47px; font-size:21px; }

      .mrc-flash {
        position:absolute; inset:0; z-index:9999; opacity:0; pointer-events:none;
        transition:opacity .06s ease-in;
      }
      .mrc-flash.ok  { background:#79c447; }
      .mrc-flash.err { background:#ff5454; }

      .mrc-spinner {
        display:inline-block; width:20px; height:20px; border:2px solid #e1e6ef;
        border-top-color:#20a8d8; border-radius:50%; animation:mrc-spin .7s linear infinite;
        flex-shrink:0;
      }
      @keyframes mrc-spin { to { transform:rotate(360deg); } }
      .mrc-loading {
        flex:1; display:flex; align-items:center; justify-content:center; gap:10px;
        color:#9faecb; font-size:13px;
      }
      .mrc-err-banner {
        margin:0 14px; padding:9px 13px; background:#fff5f5; border:1px solid #ffcdd2;
        color:#c62828; font-size:12px; flex-shrink:0; line-height:1.4;
      }
      .mrc-spacer { flex:1; min-height:6px; max-height:20px; }
      .mrc-center {
        flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center;
        gap:9px; text-align:center; padding:16px; overflow:hidden;
      }
    `;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // 4. NAV INJECTION
  // ---------------------------------------------------------------------------

  const NAV_ICON = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" rx="4" fill="#79c447"/>` +
    `<path d="M4 13.5V7l3 2.6L10 7l3 2.6L16 7v6.5" fill="none" stroke="#fff" stroke-width="1.7" ` +
    `stroke-linecap="round" stroke-linejoin="round"/></svg>`
  );

  let _navClickAttached = false;
  function _attachNavClickListener() {
    if (_navClickAttached) return;
    _navClickAttached = true;
    document.addEventListener('click', (e) => {
      const nav = document.getElementById('mrc-nav');
      if (!nav) return;
      if (nav === e.target || nav.contains(e.target)) openReceiving();
    }, true);
  }

  let _prefetched = false;
  function injectNav() {
    _attachNavClickListener();
    if (document.getElementById('mrc-nav')) return;
    const ul = document.querySelector('div.sidebar nav ul.nav');
    if (!ul) return;

    const li = document.createElement('li');
    li.id = 'mrc-nav-li';
    li.className = 'nav-item ng-star-inserted';
    const a = document.createElement('a');
    a.id = 'mrc-nav';
    a.className = 'nav-link ng-star-inserted';
    a.setAttribute('href', 'javascript:void(0)');
    a.innerHTML =
      `<span class="mrc-nav-icon"><img src="${NAV_ICON}" style="width:20px;height:20px"/></span>` +
      `<span class="mrc-nav-label">Malpa Receiving</span>`;
    li.appendChild(a);
    ul.insertBefore(li, ul.firstChild);

    // Warm the profile + location caches while the operator is still on C7,
    // so the very first receipt loads with zero cold-start cost.
    if (!_prefetched) {
      _prefetched = true;
      setTimeout(() => { loadProfile().catch(() => {}); loadLocations().catch(() => {}); }, 600);
    }
  }

  // ---------------------------------------------------------------------------
  // 5. SHELL
  // ---------------------------------------------------------------------------

  // True only when our tab is built AND in front of C7's tabs.
  function isForeground() {
    const p = document.getElementById('mrc-tab-view');
    return !!p && p.classList.contains('active');
  }

  function measureHeight() {
    const panel = document.getElementById('mrc-tab-view');
    if (!panel || !panel.classList.contains('active')) return;
    const rect = panel.getBoundingClientRect();
    const available = Math.floor(window.innerHeight - rect.top);
    if (available > 100) {
      panel.style.height    = available + 'px';
      panel.style.maxHeight = available + 'px';
      panel.style.minHeight = available + 'px';
    }
  }

  // --- C7 panel bookkeeping -------------------------------------------------
  // We hide C7's own tab panels while our tab is in front. That has to be done
  // with an inline style (class removal alone is not reliable across C7's tab
  // markup), but an inline style BEATS the .active class - so if it is left
  // behind, clicking any other C7 tab shows a blank panel: Angular adds .active
  // and our display:none quietly wins. Every panel we touch is recorded here and
  // put back exactly as found, both when stepping aside and when closing.
  let _hiddenPanels = [];

  function hideC7Panels(tabContent) {
    tabContent.querySelectorAll(':scope > tab, :scope > .tab-pane').forEach(p => {
      if (p.id === 'mrc-tab-view') return;
      _hiddenPanels.push({ el: p, display: p.style.display });
      p.classList.remove('active');
      p.style.display = 'none';
    });
  }

  // Hand display control back to C7's stylesheet.
  function restoreC7Panels() {
    for (const rec of _hiddenPanels) {
      if (document.contains(rec.el)) rec.el.style.display = rec.display;
    }
    _hiddenPanels = [];
  }

  function _setTabActive(li, on) {
    if (!li) return;
    li.classList.toggle('active', on);
    const a = li.querySelector('a.nav-link');
    if (a) {
      a.classList.toggle('active', on);
      a.setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }

  // Step aside so a C7 tab can take the foreground. Our tab and state stay put,
  // so tapping "Malpa Receiving" again resumes mid-receipt.
  function minimiseSelf() {
    const panel = document.getElementById('mrc-tab-view');
    if (!panel) return;
    Keyboard.close();
    restoreC7Panels();
    panel.classList.remove('active');
    panel.style.display = 'none';
    _setTabActive(document.getElementById('mrc-tab-li'), false);
    if (!R._sidebarWasMinimized) document.body.classList.remove('sidebar-minimized');
    if (!R._brandWasMinimized)   document.body.classList.remove('brand-minimized');
  }

  function activateSelf() {
    const tabBar     = document.querySelector('ul.nav.nav-tabs[role="tablist"]');
    const tabContent = document.querySelector('div.tab-content');
    const li         = document.getElementById('mrc-tab-li');
    const panel      = document.getElementById('mrc-tab-view');
    if (!tabBar || !tabContent || !panel) return;

    // Remember where to hand control back to on close.
    const curLi    = tabBar.querySelector('li.nav-item.active');
    const curPanel = tabContent.querySelector(':scope > .tab-pane.active, :scope > tab.active');
    if (curLi    && curLi    !== li)    R._prevActiveLi    = curLi;
    if (curPanel && curPanel !== panel) R._prevActivePanel = curPanel;

    tabBar.querySelectorAll('li.nav-item').forEach(x => { if (x !== li) _setTabActive(x, false); });
    hideC7Panels(tabContent);

    panel.style.display = '';
    panel.classList.add('active');
    _setTabActive(li, true);
    document.body.classList.add('sidebar-minimized', 'brand-minimized');
    setTimeout(measureHeight, 50);
  }

  // Capture-phase, so we clear our inline styles BEFORE Angular switches tab.
  function attachTabSwitchGuard(tabBar) {
    if (R._tabGuard) return;
    R._tabGuard = (e) => {
      if (!document.getElementById('mrc-tab-view')) return;
      const li = e.target.closest && e.target.closest('li.nav-item');
      if (!li || li.id === 'mrc-tab-li') return;
      minimiseSelf();
    };
    tabBar.addEventListener('click', R._tabGuard, true);
  }

  function buildShell() {
    if (document.getElementById('mrc-tab-view')) return;
    const tabBar     = document.querySelector('ul.nav.nav-tabs[role="tablist"]');
    const tabContent = document.querySelector('div.tab-content');
    if (!tabBar || !tabContent) {
      console.warn('[MalpaRecv] C7 tab bar / tab content not found.');
      return;
    }

    const tabLi = document.createElement('li');
    tabLi.id = 'mrc-tab-li';
    tabLi.className = 'nav-item active';
    tabLi.innerHTML = `
      <a class="nav-link active" aria-selected="true" href="javascript:void(0)"
         style="display:inline-flex;align-items:center;gap:6px;padding-right:8px;">
        Malpa Receiving
        <span id="mrc-tab-close" title="Close (Esc)" style="display:inline-flex;align-items:center;
          justify-content:center;width:18px;height:18px;border-radius:3px;font-size:14px;line-height:1;
          color:#384042;cursor:pointer;opacity:.6;margin-left:2px;
          -webkit-tap-highlight-color:transparent;">x</span>
      </a>`;
    tabBar.appendChild(tabLi);
    tabLi.querySelector('#mrc-tab-close').addEventListener('click', (e) => {
      e.stopPropagation(); closeUI();
    });
    // Clicking our own tab label brings us back to the front, mid-receipt.
    tabLi.querySelector('a.nav-link').addEventListener('click', (e) => {
      if (e.target.closest('#mrc-tab-close')) return;
      activateSelf();
    });

    const panel = document.createElement('div');
    panel.id = 'mrc-tab-view';
    panel.className = 'tab-pane';
    panel.innerHTML = `<div id="mrc-root"></div>`;
    tabContent.appendChild(panel);

    document.addEventListener('keydown', onGlobalKey);

    R._sidebarWasMinimized = document.body.classList.contains('sidebar-minimized');
    R._brandWasMinimized   = document.body.classList.contains('brand-minimized');

    attachTabSwitchGuard(tabBar);
    activateSelf();   // records the outgoing tab, hides C7's panels, shows ours

    window.addEventListener('resize', measureHeight);

    Audio.init();
    renderReceiptEntry();

    // Make sure profile + locations are in hand (no-ops if prefetch already ran)
    loadProfile().catch(e => console.warn('[MalpaRecv] profile load:', e.message));
    loadLocations().catch(e => console.warn('[MalpaRecv] location load:', e.message));
  }

  // ---------------------------------------------------------------------------
  // 6. DATA LOADERS  (each cached - fetched once, not per scan)
  // ---------------------------------------------------------------------------

  async function loadProfile() {
    if (State.profile) return State.profile;
    const data = await apiGet('configuration/receiving-profile/my-list&expand=dynamicInput');
    const list = Array.isArray(data) ? data : (data?.items || []);
    // Always Putaway - the operator never picks a profile.
    State.profile =
      list.find(p => p.receiving_process === PUTAWAY_PROCESS_ID) ||
      list.find(p => (p.name || '').trim().toLowerCase() === 'putaway') ||
      list[0] || null;
    return State.profile;
  }

  async function loadLocations() {
    if (State.locsLoaded) return;
    // Without per-page this endpoint returns only 20 rows.
    const data = await wmsGet(
      `location?warehouse_id=${WAREHOUSE_ID}&location_class_id=${STORAGE_CLASS_ID}` +
      `&per-page=${LOCATION_PAGE_SIZE}&page=1&search=`
    );
    const list = Array.isArray(data) ? data : (data?.items || []);
    const map = {};
    for (const l of list) {
      if (l?.location_code) map[String(l.location_code).trim().toUpperCase()] = l;
    }
    State.locByCode = map;
    State.locsLoaded = true;
    console.log('[MalpaRecv] cached', Object.keys(map).length, 'storage locations');
  }

  // Resolve a scanned location code. Cache first; single-location lookup as fallback
  // so a brand-new bin that post-dates the cache still works.
  async function resolveLocation(code) {
    const key = String(code || '').trim().toUpperCase();
    if (!key) return null;
    if (State.locByCode[key]) return State.locByCode[key];
    try {
      const data = await wmsGet(
        `location?warehouse_id=${WAREHOUSE_ID}&location_class_id=${STORAGE_CLASS_ID}` +
        `&search=${encodeURIComponent(key)}`
      );
      const list = Array.isArray(data) ? data : (data?.items || []);
      const hit = list.find(l => String(l.location_code).trim().toUpperCase() === key);
      if (hit) State.locByCode[key] = hit;
      return hit || null;
    } catch (_) { return null; }
  }

  async function fetchReceiptHeader(receiptId) {
    const EXPAND = [
      'company', 'warehouse', 'receiptDetails', 'receipt_preference',
      'receiptDetails.item', 'receiptDetails.item.inventory',
      'receiptDetails.item.inventory.batch',
      'receiptDetails.item.uniqueBatchInventory.batch',
      'receiptDetails.item.defaultImage',
    ].join(',');
    const dock = State.profile?.default_receiving_dock_code || 'REC-01';
    const ref  = State.profile?.checkin_reference ?? 1;
    const data = await apiGet(
      `receiving/receipt-header/get-by-num&id=${encodeURIComponent(receiptId)}` +
      `&location_code=${encodeURIComponent(dock)}&checkin_reference=${ref}` +
      `&expand=${encodeURIComponent(EXPAND)}`
    );
    const arr = Array.isArray(data) ? data : (data ? [data] : []);
    return arr[0] || null;
  }

  // ONE verify call per distinct item on the receipt, run in parallel, cached.
  // C7 fires this on every single scan - we do not.
  async function buildItemCache(header) {
    const EXPAND = [
      'itemUnitOfMeasures.unitOfMeasure',
      'itemUnitOfMeasures.itemUnitOfMeasureReference',
      'permanentLocation', 'defaultImage',
    ].join(',');

    const codes = [...new Set(
      (header.receiptDetails || [])
        .map(d => d.item?.item_code)
        .filter(Boolean)
    )];

    const results = await Promise.all(codes.map(code =>
      apiGet(
        `receiving/receiving/verify-item-and-reference-by-code&id=${header.id}` +
        `&item_code=${encodeURIComponent(code)}&company_id=${header.company_id}` +
        `&expand=${encodeURIComponent(EXPAND)}`
      ).catch(e => {
        console.warn('[MalpaRecv] verify failed for', code, e.message);
        return null;
      })
    ));

    const itemsById = {};
    const refMap    = {};
    const failed    = [];

    results.forEach((item, i) => {
      if (!item?.id) { failed.push(codes[i]); return; }
      itemsById[item.id] = item;

      // UoM references first, so a reference always carries its UoM. Doing the
      // item_code mapping first would leave uomId null for items where a UoM
      // reference happens to equal the item code (very common in C7), and the
      // scan would then fall back to a guessed UoM.
      for (const uom of (item.itemUnitOfMeasures || [])) {
        for (const r of (uom.itemUnitOfMeasureReference || [])) {
          const key = String(r.reference || '').trim().toLowerCase();
          if (key && !(key in refMap)) refMap[key] = { itemId: item.id, uomId: uom.id };
        }
      }
      // item_code is always scannable, but must not overwrite a reference above.
      const codeKey = String(item.item_code).trim().toLowerCase();
      if (!(codeKey in refMap)) refMap[codeKey] = { itemId: item.id, uomId: null };
    });

    State.itemsById   = itemsById;
    State.refMap      = refMap;
    State.failedItems = failed;
    console.log('[MalpaRecv] cached', Object.keys(itemsById).length, 'items,',
      Object.keys(refMap).length, 'barcodes');
  }

  // Suggested putaway bin from the locating rule.
  async function fetchSuggestedLocation(detail, item, uom, qty, batchNo) {
    const p = State.profile;
    const path =
      `receiving/receipt-detail/get-location-by-locating-rule` +
      `&item_id=${item.id}` +
      `&locating_rule_id=${detail.locating_rule_id}` +
      `&default_receiving_dock_id=${p.default_receiving_dock}` +
      `&default_inventory_status=${encodeURIComponent(p.default_inventory_status || 'available')}` +
      `&item_uom_id=${uom.id}` +
      `&quantity=${qty}` +
      `&receiving_process_id=${p.receiving_process}` +
      `&receipt_number=${encodeURIComponent(State.header.receipt_num)}` +
      `&pre_check=true` +
      `&batch=${batchNo ? encodeURIComponent(batchNo) : 'null'}`;
    try { return await apiGet(path); } catch (_) { return null; }
  }

  // Refresh a single detail line - used only on a checkin retry, never on the happy path.
  async function refreshDetail(detail, item) {
    const cur = State.cur;
    const path =
      `receiving/receipt-detail/get-detail-by-item` +
      `&receipt_header_id=${State.header.id}&item_id=${item.id}` +
      `&profile_id=${State.profile.id}` +
      `&batch_no=${cur?.batchNo ? encodeURIComponent(cur.batchNo) : 'null'}` +
      `&expiry=${cur?.expiry ? encodeURIComponent(cur.expiry) : 'null'}` +
      `&detail_id=${detail.id}`;
    return apiGet(path);
  }

  // The write. Mirrors the C7 payload exactly, with label_quantity and
  // no_of_pieces hard-wired to 0 and the profile hard-wired to Putaway.
  async function postCheckin(detail, item, uom, qty, locationId) {
    const p = State.profile;
    return apiPost('receiving/receiving/checkin', {
      receipt_detail:          sanitizeDetail(detail),
      label_quantity:          0,
      receipt_id:              State.receiptId,
      receiving_profile_id:    p.id,
      item_id:                 item.id,
      item_unit_of_measure_id: uom.id,
      quantity:                qty,
      reason_code:             null,
      comments:                null,
      license_plate_no:        '',
      to_location_id:          locationId,
      location_id:             null,
      no_of_pieces:            0,
      id:                      State.header.id,
      check_in_by:             p.check_in_by ?? 1,
    });
  }

  // ---------------------------------------------------------------------------
  // 7. VOICE + AUDIO  (carried over from Malpa Pick)
  // ---------------------------------------------------------------------------

  function _formatLocForSpeech(loc, prevLoc) {
    if (!loc) return '';
    const segs     = String(loc).split('-');
    const prevSegs = prevLoc ? String(prevLoc).split('-') : [];
    let skip = 0;
    for (let i = 0; i < segs.length - 1; i++) {
      if (prevSegs[i] && prevSegs[i].toUpperCase() === segs[i].toUpperCase()) skip++;
      else break;
    }
    return segs.slice(skip).map(seg => {
      const m = seg.match(/^([A-Za-z]*)(\d+)$/);
      if (!m) return seg;
      const letters = m[1], num = parseInt(m[2], 10);
      return letters ? letters + ' ' + num : String(num);
    }).join(', ');
  }

  const Voice = {
    speak(text) {
      if (!State.voiceEnabled || !window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text));
      u.rate = 1.8; u.pitch = 1.0; u.volume = 1.0;
      window.speechSynthesis.speak(u);
    },
    announcePutaway(qty, uomName, locCode, prevLoc) {
      let uomStr = '';
      if (uomName && uomName.toLowerCase() !== 'each') {
        const plural = qty > 1 && !uomName.toLowerCase().endsWith('s') ? uomName + 's' : uomName;
        uomStr = ' ' + plural;
      }
      this.speak(`Put ${qty}${uomStr} to ${_formatLocForSpeech(locCode, prevLoc)}`);
    },
    announceNoLocation() { this.speak('No existing location. Scan a bin.'); },
    cancel() { if (window.speechSynthesis) window.speechSynthesis.cancel(); },
    // Errors bypass the mute toggle - an operator must always hear a reject.
    error(msg) {
      if (!window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(msg));
      u.rate = 1.7; u.pitch = 1.0; u.volume = 1.0;
      window.speechSynthesis.speak(u);
    },
  };

  const Audio = {
    _ctx: null,
    init() {
      if (this._ctx) return;
      try { this._ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { console.warn('[MalpaRecv] AudioContext unavailable:', e.message); }
    },
    _tone(freq, dur, type = 'sine', gainVal = 0.4, delay = 0) {
      if (!this._ctx) return;
      try {
        const osc = this._ctx.createOscillator();
        const g   = this._ctx.createGain();
        osc.connect(g); g.connect(this._ctx.destination);
        osc.type = type;
        osc.frequency.setValueAtTime(freq, this._ctx.currentTime + delay);
        g.gain.setValueAtTime(gainVal, this._ctx.currentTime + delay);
        g.gain.exponentialRampToValueAtTime(0.001, this._ctx.currentTime + delay + dur);
        osc.start(this._ctx.currentTime + delay);
        osc.stop(this._ctx.currentTime + delay + dur);
      } catch (_) {}
    },
    chime(type) {
      this.init();
      if (!this._ctx) return;
      if (this._ctx.state === 'suspended') this._ctx.resume();
      if (type === 'item_ok') {            // item verified
        this._tone(880, 0.15, 'sine', 0.35, 0);
        this._tone(880, 0.10, 'sine', 0.15, 0.15);
      } else if (type === 'line_done') {   // detail checked in
        this._tone(660, 0.12, 'sine', 0.30, 0);
        this._tone(880, 0.20, 'sine', 0.40, 0.13);
      } else if (type === 'receipt_done') { // whole receipt finished
        this._tone(660, 0.12, 'sine', 0.30, 0);
        this._tone(880, 0.12, 'sine', 0.35, 0.13);
        this._tone(1175, 0.24, 'sine', 0.40, 0.26);
      } else if (type === 'error') {
        this._tone(180, 0.08, 'square', 0.30, 0);
        this._tone(180, 0.08, 'square', 0.30, 0.12);
      } else if (type === 'warn') {        // over-receive prompt
        this._tone(420, 0.14, 'triangle', 0.32, 0);
        this._tone(330, 0.18, 'triangle', 0.32, 0.15);
      }
    },
  };

  // ---------------------------------------------------------------------------
  // 8. HELPERS
  // ---------------------------------------------------------------------------

  function _esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // TC51 scanners occasionally emit shifted digits when Android's shift state
  // is stuck during focus(). Same fix as Malpa Pick.
  const _SHIFT_NUMS = {
    '!': '1', '@': '2', '#': '3', '$': '4', '%': '5',
    '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  };
  function _normaliseScan(val) {
    return String(val).split('').map(c => _SHIFT_NUMS[c] || c).join('');
  }

  // ---------------------------------------------------------------------------
  // 8b. ON-SCREEN KEYBOARD
  // ---------------------------------------------------------------------------
  // Every input carries inputmode="none" so Android's keyboard never appears -
  // it is cramped, covers the screen unpredictably and fights the scanner. This
  // keyboard is a proxy for the real input: keys write into it and fire an
  // `input` event, so the hardware scanner keeps working the whole time the
  // keyboard is up (keys use pointerdown + preventDefault so focus never moves).

  const KB_LAYOUTS = {
    num: [
      ['1', '2', '3'],
      ['4', '5', '6'],
      ['7', '8', '9'],
      ['-', '0', '⌫'],
    ],
    alpha: [
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
      ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
      ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', '-'],
      ['Z', 'X', 'C', 'V', 'B', 'N', 'M', '⌫'],
    ],
  };
  const KB_DEL = '⌫';

  const Keyboard = {
    targetId: null, mode: 'alpha', onEnter: null, label: '',

    get input() { return this.targetId ? document.getElementById(this.targetId) : null; },
    isOpen() { return !!document.getElementById('mrc-kb-ov'); },
    close() { document.getElementById('mrc-kb-ov')?.remove(); },

    open(targetId, mode, onEnter, label) {
      this.targetId = targetId;
      this.mode     = mode || 'alpha';
      this.onEnter  = onEnter || null;
      this.label    = label || '';
      this.render();
    },

    toggle(targetId, mode, onEnter, label) {
      if (this.isOpen() && this.targetId === targetId) {
        this.close(); this.focusInput();
      } else {
        this.open(targetId, mode, onEnter, label);
      }
    },

    render() {
      const screen = document.getElementById('mrc-screen');
      if (!screen) return;
      this.close();

      const rows = KB_LAYOUTS[this.mode] || KB_LAYOUTS.alpha;
      const ov = document.createElement('div');
      ov.className = 'mrc-kb-ov';
      ov.id = 'mrc-kb-ov';
      ov.innerHTML = `
        <div class="mrc-kb${this.mode === 'num' ? ' mrc-kb-num' : ''}">
          <div class="mrc-kb-disp">
            <span class="mrc-kb-disp-lbl">${_esc(this.label)}</span>
            <span class="mrc-kb-disp-val" id="mrc-kb-val"></span>
          </div>
          ${rows.map(r => `<div class="mrc-kb-row">${r.map(k =>
            `<button class="mrc-kb-key${k === KB_DEL ? ' del' : ''}" data-k="${_esc(k)}"
              >${_esc(k)}</button>`).join('')}</div>`).join('')}
          <div class="mrc-kb-row">
            <button class="mrc-kb-key mode" data-k="@mode">${this.mode === 'num' ? 'ABC' : '123'}</button>
            <button class="mrc-kb-key mode" data-k="@clear">Clear</button>
            <button class="mrc-kb-key go"   data-k="@enter">Enter</button>
          </div>
        </div>`;
      screen.appendChild(ov);

      // pointerdown + preventDefault: acts instantly and never steals focus
      // from the input, so a scan mid-typing still lands in the right place.
      ov.querySelectorAll('.mrc-kb-key').forEach(b => {
        b.addEventListener('pointerdown', (e) => { e.preventDefault(); this.press(b.dataset.k); });
      });
      ov.addEventListener('pointerdown', (e) => {
        if (e.target === ov) { e.preventDefault(); this.close(); this.focusInput(); }
      });

      // Mirror hardware-scanner input into the keyboard display.
      const i = this.input;
      if (i && i.dataset.kbSync !== '1') {
        i.dataset.kbSync = '1';
        i.addEventListener('input', () => this.sync());
      }
      this.sync();
      this.focusInput();
    },

    focusInput() {
      const i = this.input;
      if (i && !i.disabled) setTimeout(() => i.focus(), 0);
    },

    sync() {
      const el = document.getElementById('mrc-kb-val');
      if (el) el.innerHTML = _esc(this.input?.value ?? '') + '<span class="cur">|</span>';
    },

    press(k) {
      const i = this.input;
      if (!i) return;
      if (k === '@mode') { this.mode = this.mode === 'num' ? 'alpha' : 'num'; this.render(); return; }
      if (k === '@enter') {
        const fn = this.onEnter, val = i.value;
        this.close();
        if (fn) fn(val);
        return;
      }
      if (k === '@clear')     i.value = '';
      else if (k === KB_DEL)  i.value = i.value.slice(0, -1);
      else                    i.value += k;
      i.dispatchEvent(new Event('input', { bubbles: true }));
      this.sync();
      this.focusInput();
    },
  };

  // Standard "Keyboard" button for screens where typing is the exception.
  function kbButtonHtml() {
    return `<button id="mrc-kb-btn" class="mrc-btn mrc-btn-secondary">Keyboard</button>`;
  }
  function wireKbButton(targetId, mode, onEnter, label) {
    document.getElementById('mrc-kb-btn')?.addEventListener('click', () =>
      Keyboard.toggle(targetId, mode, onEnter, label));
  }

  function setFb(msg, type) {
    const fb = document.getElementById('mrc-fb');
    if (fb) {
      fb.textContent = msg;
      fb.className = 'mrc-fb ' + (type || 'dim');
    }
    if (type === 'ok' || type === 'err') {
      const screen = document.getElementById('mrc-screen');
      if (screen) {
        const flash = document.createElement('div');
        flash.className = 'mrc-flash ' + type;
        screen.style.position = 'relative';
        screen.appendChild(flash);
        requestAnimationFrame(() => {
          flash.style.opacity = '0.32';
          setTimeout(() => {
            flash.style.opacity = '0';
            setTimeout(() => flash.remove(), 80);
          }, 80);
        });
      }
      if (navigator.vibrate) navigator.vibrate(type === 'ok' ? [30] : [60, 30, 60]);
    }
  }

  function reject(msg, spoken) {
    setFb(msg, 'err');
    Audio.chime('error');
    Voice.error(spoken || msg);
  }

  // Total open units still to receive on this receipt (base units).
  function openUnits() {
    return State.details.reduce((s, d) => s + Math.max(0, d.open_quantity || 0), 0);
  }
  function openLines() {
    return State.details.filter(d => (d.open_quantity || 0) > 0).length;
  }
  // Progress is measured in DETAIL LINES: how many of the receipt's details are
  // fully received, out of how many details exist. A part-received line is not
  // counted as complete, and the denominator never moves.
  function linesCompleted() {
    return State.details.filter(d => (d.open_quantity || 0) <= 0).length;
  }
  function totalDetailLines() {
    return State.details.length;
  }

  // Fallback UoM when a bare item_code was scanned. Deliberately biased to the
  // BASE unit: guessing a carton would silently multiply the received quantity
  // by its factor, so the smallest/base unit is always the safe default.
  function defaultUomFor(item) {
    const uoms = item?.itemUnitOfMeasures || [];
    if (!uoms.length) return null;
    return uoms.find(u => u.unit_of_measure_id === item.base_unit_of_measure)
        || uoms.find(u => (u.factor || 1) === 1)
        || uoms.slice().sort((a, b) => (a.factor || 1) - (b.factor || 1))[0];
  }

  function uomName(uom) {
    return uom?.unitOfMeasure?.name || uom?.unitOfMeasure?.description || 'Each';
  }

  // C7 returns enable_batch as 1/0 on some payloads and true/false on others.
  function isBatch(item) {
    return item?.enable_batch === 1 || item?.enable_batch === true;
  }

  // Step back one screen from the location stage.
  function backFromLocation() {
    if (isBatch(State.cur?.item)) renderBatch(); else renderQty();
  }

  // Pick the open detail line for an item. Lowest line_number with qty still open.
  function openDetailForItem(itemId) {
    const candidates = State.details
      .filter(d => d.item_id === itemId && (d.open_quantity || 0) > 0)
      .sort((a, b) => (a.line_number || 0) - (b.line_number || 0));
    return candidates[0] || null;
  }

  // showEdit renders the pencil beside the code, for changing the location.
  function progressHtml(label, code, sub, tone, showEdit) {
    const done  = linesCompleted();
    const total = totalDetailLines();
    const pct   = total > 0 ? Math.round((done / total) * 100) : 0;
    return `
      <div class="mrc-hdr${tone ? ' ' + tone : ''}">
        <div class="mrc-hdr-top">
          <span class="mrc-hdr-label">${_esc(label)}</span>
          <div class="mrc-hdr-right">
            <span class="mrc-hdr-prog">${done} / ${total} lines completed</span>
            <button class="mrc-voice${State.voiceEnabled ? '' : ' muted'}" id="mrc-voice-btn"
              title="Toggle voice" aria-label="Toggle voice">${State.voiceEnabled ? '🔊' : '🔇'}</button>
          </div>
        </div>
        <div class="mrc-hdr-code-row">
          <div class="mrc-hdr-code">${_esc(code)}</div>
          ${showEdit ? `<button class="mrc-edit" id="mrc-edit-loc" title="Change location"
            aria-label="Change location">&#9998;</button>` : ''}
        </div>
        ${sub ? `<div class="mrc-hdr-sub">${sub}</div>` : ''}
        <div class="mrc-prog-track"><div class="mrc-prog-fill" style="width:${pct}%"></div></div>
      </div>`;
  }

  // Clear the location outright and drop the operator into a blank scan field.
  function wireEditLocation() {
    document.getElementById('mrc-edit-loc')?.addEventListener('click', () => {
      const c = State.cur;
      if (!c) return;
      Keyboard.close();
      c.location = null;
      c.suggested = null;
      c.viaKeep = false;
      if (navigator.vibrate) navigator.vibrate([20]);
      renderLocationScan();
    });
  }

  function wireVoiceBtn(refocusId) {
    document.getElementById('mrc-voice-btn')?.addEventListener('click', () => {
      State.voiceEnabled = !State.voiceEnabled;
      try { sessionStorage.setItem('mrc_voice', State.voiceEnabled ? '1' : '0'); } catch (_) {}
      const btn = document.getElementById('mrc-voice-btn');
      if (btn) {
        btn.textContent = State.voiceEnabled ? '🔊' : '🔇';
        btn.classList.toggle('muted', !State.voiceEnabled);
      }
      if (!State.voiceEnabled) Voice.cancel();
      if (refocusId) setTimeout(() => document.getElementById(refocusId)?.focus(), 60);
    });
  }

  // Tap anywhere (other than a control) puts focus back on the scan input.
  function wireTapRefocus(inputId) {
    document.getElementById('mrc-screen')?.addEventListener('click', (e) => {
      if (e.target.closest('button, select, input, label, .mrc-keep')) return;
      setTimeout(() => document.getElementById(inputId)?.focus(), 40);
    });
  }

  // ---------------------------------------------------------------------------
  // 9. SCREEN A - RECEIPT NUMBER ENTRY
  // ---------------------------------------------------------------------------

  function renderReceiptEntry(errorMsg) {
    const root = document.getElementById('mrc-root');
    if (!root) return;
    State.screen = 'RECEIPT_ENTRY';
    State.cur = null;

    let last = '';
    try { last = sessionStorage.getItem('mrc_lastreceipt') || ''; } catch (_) {}

    root.innerHTML = `
      <div class="mrc-screen" id="mrc-screen">
        ${progressHtml('Malpa Receiving', 'Declare Receipt', 'Putaway - one step check in &amp; locate', 'green')}
        <div class="mrc-body">
          ${errorMsg ? `<div class="mrc-err-banner">${_esc(errorMsg)}</div>` : ''}
          <div class="mrc-field-lbl">Receipt number</div>
          <div class="mrc-zone">
            <div class="mrc-zone-lbl">Scan or type receipt</div>
            <input id="mrc-receipt-in" class="mrc-input big" type="text" inputmode="none"
              autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false"
              placeholder="RET-" value="${_esc(last)}"/>
          </div>
          <div class="mrc-fb dim" id="mrc-fb">Ready to scan</div>
        </div>
      </div>
      <div class="mrc-actions">
        ${kbButtonHtml()}
        <button id="mrc-load-btn" class="mrc-btn mrc-btn-primary">Load Receipt</button>
      </div>`;

    const inp = document.getElementById('mrc-receipt-in');
    const go  = (v) => { const s = _normaliseScan(String(v || '').trim()); if (s) loadReceipt(s); };
    inp?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); go(inp.value); }
    });
    document.getElementById('mrc-load-btn')?.addEventListener('click', () => go(inp?.value));
    wireVoiceBtn('mrc-receipt-in');
    wireKbButton('mrc-receipt-in', 'alpha', go, 'Receipt number');
    setTimeout(measureHeight, 30);
    // Receipt numbers get typed as often as scanned, so bring the keyboard up.
    setTimeout(() => Keyboard.open('mrc-receipt-in', 'alpha', go, 'Receipt number'), 120);
  }

  async function loadReceipt(receiptRaw) {
    const receiptId = receiptRaw.toUpperCase();
    const root = document.getElementById('mrc-root');
    if (root) root.innerHTML = `<div class="mrc-loading"><div class="mrc-spinner"></div>Loading receipt...</div>`;
    State.screen = 'TRANSITIONING';

    try {
      await loadProfile();
      if (!State.profile) throw new Error('No Putaway receiving profile available');

      const header = await fetchReceiptHeader(receiptId).catch(e => {
        if (e.notFound) return null;
        throw e;
      });

      if (!header) {
        renderReceiptEntry(`Receipt ${receiptId} not found, or it has nothing left to check in.`);
        return;
      }

      State.header    = header;
      State.receiptId = receiptId;
      State.companyId = header.company_id;
      State.details   = (header.receiptDetails || []).map(d => ({ ...d }));
      State.done       = 0;
      State.linesDone  = new Set();
      State.failedItems = [];
      State.totalLines = State.details.filter(d => (d.open_quantity || 0) > 0).length;
      try { sessionStorage.setItem('mrc_lastreceipt', receiptId); } catch (_) {}

      if (!State.details.length) {
        renderReceiptEntry(`Receipt ${receiptId} has no detail lines to receive.`);
        return;
      }

      // Cache every item on the receipt in one parallel burst.
      await buildItemCache(header);
      // Locations may still be warming - do not block on it.
      loadLocations().catch(() => {});

      renderScanItem();
    } catch (err) {
      console.error('[MalpaRecv] loadReceipt:', err);
      renderReceiptEntry('Could not load receipt: ' + err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // 10. SCREEN B - SCAN ITEM
  // ---------------------------------------------------------------------------

  function renderScanItem(msg, msgType) {
    const root = document.getElementById('mrc-root');
    if (!root) return;
    State.screen = 'SCAN_ITEM';
    State.cur = null;

    const lines = openLines();
    const units = openUnits();
    const company = State.header?.company?.company_code || '';

    root.innerHTML = `
      <div class="mrc-screen" id="mrc-screen">
        ${progressHtml('Receipt', State.header?.receipt_num || State.receiptId,
          `${company ? _esc(company) + ' &middot; ' : ''}${lines} line${lines === 1 ? '' : 's'} open &middot; ${units} unit${units === 1 ? '' : 's'} to receive`)}
        <div class="mrc-body">
          <div class="mrc-zone">
            <div class="mrc-zone-lbl">Scan item or barcode</div>
            <div class="mrc-arrows">&gt;&gt;&gt;</div>
            <input id="mrc-scan-in" class="mrc-hidden-in" type="text" inputmode="none"
              autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"/>
          </div>
          <div class="mrc-fb ${msgType || 'dim'}" id="mrc-fb">${_esc(msg || 'Ready to scan')}</div>
          ${State.failedItems.length ? `<div class="mrc-err-banner">Could not load ${
            _esc(State.failedItems.join(', '))} - use the standard C7 window for
            ${State.failedItems.length === 1 ? 'that line' : 'those lines'}.</div>` : ''}
          ${renderKeepHtml()}
        </div>
      </div>
      <div class="mrc-actions">
        <button id="mrc-newreceipt-btn" class="mrc-btn mrc-btn-secondary">New Receipt</button>
      </div>`;

    const inp = document.getElementById('mrc-scan-in');
    inp?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.keyCode !== 13) return;
      e.preventDefault();
      const raw = inp.value.trim();
      inp.value = '';
      if (raw) onItemScan(_normaliseScan(raw));
    });
    // Straight back to the receipt prompt to start the next one.
    document.getElementById('mrc-newreceipt-btn')?.addEventListener('click', () => {
      State.resetReceipt();
      renderReceiptEntry();
    });
    wireVoiceBtn('mrc-scan-in');
    wireKeepToggle('mrc-scan-in');
    wireTapRefocus('mrc-scan-in');
    setTimeout(() => inp?.focus(), 90);
    setTimeout(measureHeight, 30);
  }

  function onItemScan(barcode) {
    const key = barcode.trim().toLowerCase();
    const hit = State.refMap[key];

    if (!hit) {
      // Distinguish "wrong item" from "we failed to load this item's data".
      const onReceipt = State.details.some(d =>
        String(d.item?.item_code || '').trim().toLowerCase() === key);
      if (onReceipt) reject('Item data failed to load - use C7 for this line', 'Item data error');
      else reject('Not on this receipt', 'Item not on this receipt');
      return;
    }

    const item   = State.itemsById[hit.itemId];
    const detail = openDetailForItem(hit.itemId);

    if (!item) { reject('Item data missing - rescan', 'Item error'); return; }
    if (!detail) {
      reject('No open quantity left on this item', 'Line already complete');
      return;
    }

    // Auto-select the UoM the scanned reference belongs to; operator can still change it.
    let uom = hit.uomId
      ? (item.itemUnitOfMeasures || []).find(u => u.id === hit.uomId)
      : null;
    if (!uom) uom = defaultUomFor(item);
    if (!uom) { reject('Item has no unit of measure', 'Item error'); return; }

    State.cur = {
      detail, item, uom,
      qty: null,
      batchNo: detail.expected_batch_no || '',
      expiry:  detail.expected_batch_expiry || '',
      location: null,
      suggested: null,
      scannedRef: barcode,
    };

    setFb('Item verified', 'ok');
    Audio.chime('item_ok');
    renderQty();
  }

  // ---------------------------------------------------------------------------
  // 11. SCREEN C - QUANTITY (+ UoM override)
  // ---------------------------------------------------------------------------

  function renderQty(errMsg) {
    const root = document.getElementById('mrc-root');
    if (!root) return;
    State.screen = 'QTY';
    const c = State.cur;
    if (!c) { renderScanItem(); return; }

    const factor   = c.uom.factor || 1;
    const openBase = c.detail.open_quantity || 0;

    const uomOpts = (c.item.itemUnitOfMeasures || []).map(u =>
      `<option value="${u.id}"${u.id === c.uom.id ? ' selected' : ''}>` +
      `${_esc(uomName(u))}${(u.factor || 1) > 1 ? ` (x${u.factor})` : ''}</option>`
    ).join('');

    root.innerHTML = `
      <div class="mrc-screen" id="mrc-screen">
        ${progressHtml('Quantity', State.header?.receipt_num || State.receiptId,
          `Line ${c.detail.line_number ?? '-'}`)}
        <div class="mrc-item">
          <div class="mrc-item-sku">${_esc(c.item.item_code)}</div>
          <div class="mrc-item-desc">${_esc(c.item.description || '')}</div>
          <div class="mrc-open-row">
            <div class="mrc-open-cell">
              <span class="mrc-open-lbl">Open</span>
              <span class="mrc-open-val hi">${openBase}</span>
            </div>
            ${factor > 1 ? `<div class="mrc-open-cell">
              <span class="mrc-open-lbl">${_esc(uomName(c.uom))} x${factor}</span>
              <span class="mrc-open-val" style="font-size:18px;color:#9faecb">${
                openBase % factor === 0 ? openBase / factor : (openBase / factor).toFixed(2)}</span>
            </div>` : ''}
          </div>
        </div>
        <div class="mrc-body">
          ${errMsg ? `<div class="mrc-err-banner">${_esc(errMsg)}</div>` : ''}
          <div class="mrc-field-lbl">Unit of measure</div>
          <select id="mrc-uom-sel" class="mrc-select">${uomOpts}</select>
          <div class="mrc-field-lbl">Quantity${factor > 1 ? ' (base units)' : ''}</div>
          <input id="mrc-qty-in" class="mrc-input big" type="text" inputmode="none"
            autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
            placeholder="0 of ${openBase}" value=""/>
          <div class="mrc-fb dim" id="mrc-fb">Enter to continue</div>
        </div>
      </div>
      <div class="mrc-actions">
        <button id="mrc-back-btn" class="mrc-btn mrc-btn-secondary">&lt;- Back</button>
        <button id="mrc-next-btn" class="mrc-btn mrc-btn-primary">Next -&gt;</button>
      </div>`;

    const qtyIn = document.getElementById('mrc-qty-in');
    const uomSel = document.getElementById('mrc-uom-sel');

    // Live readout so the operator sees the carton count as they type, and knows
    // immediately when the number does not divide by the factor.
    const syncHint = () => {
      if (factor <= 1) return;
      const n = parseFloat(_normaliseScan((qtyIn?.value || '').trim()));
      const fb = document.getElementById('mrc-fb');
      if (!fb) return;
      if (isNaN(n) || n <= 0) { fb.textContent = 'Enter to continue'; fb.className = 'mrc-fb dim'; return; }
      if (n % factor !== 0) {
        const lo = Math.floor(n / factor) * factor, hi = lo + factor;
        fb.textContent = `${n} is not a whole ${uomName(c.uom)} - try ${lo || factor} or ${hi}`;
        fb.className = 'mrc-fb err';
      } else {
        fb.textContent = `= ${n / factor} ${uomName(c.uom)}${n / factor === 1 ? '' : 's'}`;
        fb.className = 'mrc-fb ok';
      }
    };

    uomSel?.addEventListener('change', () => {
      const nu = (c.item.itemUnitOfMeasures || []).find(u => String(u.id) === uomSel.value);
      if (nu) { c.uom = nu; renderQty(); }
    });
    qtyIn?.addEventListener('input', syncHint);
    qtyIn?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); submitQty(); }
    });
    syncHint();
    document.getElementById('mrc-next-btn')?.addEventListener('click', submitQty);
    document.getElementById('mrc-back-btn')?.addEventListener('click', () => {
      Keyboard.close(); renderScanItem();
    });
    wireVoiceBtn('mrc-qty-in');
    setTimeout(measureHeight, 30);
    // Quantity is always typed, so the keypad comes up automatically.
    setTimeout(() => Keyboard.open('mrc-qty-in', 'num', () => submitQty(),
      `Quantity${factor > 1 ? ' - base units' : ''} (open ${openBase})`), 110);
  }

  function submitQty() {
    const c = State.cur;
    if (!c) return;
    const raw = _normaliseScan((document.getElementById('mrc-qty-in')?.value || '').trim());
    const qty = parseFloat(raw);

    if (!raw || isNaN(qty) || qty <= 0) {
      reject('Enter a quantity greater than zero', 'Invalid quantity');
      return;
    }
    // A scan landing on this field would otherwise be read as a quantity.
    // No real receipt line is 100,000 units, so treat long numbers as a misfire.
    if (/^\d{6,}$/.test(raw)) {
      document.getElementById('mrc-qty-in').value = '';
      reject('That looks like a barcode, not a quantity', 'Enter a quantity');
      return;
    }
    if (!Number.isInteger(qty) && !c.item.allow_partial_units) {
      reject('Whole units only for this item', 'Whole units only');
      return;
    }

    const factor   = c.uom.factor || 1;
    const openBase = c.detail.open_quantity || 0;
    const baseQty  = qty;   // C7 takes the quantity in BASE units - see note at top

    // A factor-6 carton cannot hold 13 eaches. Refuse anything that is not a
    // whole number of the selected unit of measure.
    if (factor > 1 && qty % factor !== 0) {
      const lo = Math.floor(qty / factor) * factor, hi = lo + factor;
      reject(
        `${qty} is not a whole ${uomName(c.uom)} (x${factor}) - use ${lo || factor} or ${hi}`,
        `Not a whole ${uomName(c.uom)}`
      );
      return;
    }

    c.qty = qty;

    if (baseQty > openBase) {
      // Over-receive. Profile allows it, but C7 makes the operator type OVER - so do we.
      if (!State.profile.allow_over_receiving) {
        reject(`Over-receiving is off. Open is ${openBase} base units.`, 'Over receiving not allowed');
        return;
      }
      showOverConfirm(qty, baseQty, openBase);
      return;
    }

    afterQty();
  }

  function afterQty() {
    const c = State.cur;
    // Batch + expiry only when the item is actually batch tracked.
    if (isBatch(c.item)) renderBatch();
    else beginLocation();
  }

  // ---------------------------------------------------------------------------
  // 12. OVER-RECEIVE CONFIRM  (type OVER)
  // ---------------------------------------------------------------------------

  function showOverConfirm(qty, baseQty, openBase) {
    const screen = document.getElementById('mrc-screen');
    if (!screen) return;
    document.getElementById('mrc-over-ov')?.remove();
    const prevScreen = State.screen;
    State.screen = 'OVER_CONFIRM';

    Audio.chime('warn');
    Voice.error('Over receiving. Type OVER to confirm.');

    const ov = document.createElement('div');
    ov.className = 'mrc-ov';
    ov.id = 'mrc-over-ov';
    ov.innerHTML = `
      <div class="mrc-ov-card">
        <div class="mrc-ov-hdr">Over-receiving</div>
        <div class="mrc-ov-body">
          You are receiving <strong>${baseQty}</strong> base units against an open quantity of
          <strong>${openBase}</strong>.<br><br>
          Type <strong>OVER</strong> to confirm.
          <input id="mrc-over-in" class="mrc-input big" type="text" inputmode="none"
            autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false"
            placeholder="OVER" style="margin-top:10px"/>
          <div class="mrc-fb err" id="mrc-over-fb" style="margin-top:6px"></div>
        </div>
        <div class="mrc-ov-acts">
          <button id="mrc-over-yes" class="mrc-btn mrc-btn-danger">Confirm Over-Receive</button>
          <button id="mrc-over-no"  class="mrc-btn mrc-btn-secondary">Cancel</button>
        </div>
      </div>`;
    screen.appendChild(ov);

    const inp = document.getElementById('mrc-over-in');
    const fb  = document.getElementById('mrc-over-fb');

    const tryConfirm = () => {
      const v = _normaliseScan((inp?.value || '').trim()).toUpperCase();
      if (v === 'OVER') {
        Keyboard.close();
        ov.remove();
        afterQty();
      } else {
        if (fb) fb.textContent = 'Type OVER exactly to confirm';
        Audio.chime('error');
        if (navigator.vibrate) navigator.vibrate([60, 30, 60]);
        if (inp) { inp.value = ''; inp.focus(); }
      }
    };

    inp?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); tryConfirm(); }
    });
    document.getElementById('mrc-over-yes')?.addEventListener('click', tryConfirm);
    document.getElementById('mrc-over-no')?.addEventListener('click', () => {
      Keyboard.close();
      ov.remove();
      State.screen = prevScreen;
      renderQty();
    });
    setTimeout(() => Keyboard.open('mrc-over-in', 'alpha', tryConfirm, 'Type OVER to confirm'), 130);
  }

  // ---------------------------------------------------------------------------
  // 13. SCREEN D - BATCH + EXPIRY  (batch-tracked items only)
  // ---------------------------------------------------------------------------

  function renderBatch(errMsg) {
    const root = document.getElementById('mrc-root');
    if (!root) return;
    State.screen = 'BATCH';
    const c = State.cur;
    if (!c) { renderScanItem(); return; }

    root.innerHTML = `
      <div class="mrc-screen" id="mrc-screen">
        ${progressHtml('Batch tracked item', State.header?.receipt_num || State.receiptId,
          `${_esc(c.item.item_code)} &middot; ${c.qty} ${_esc(uomName(c.uom))}`, 'amber')}
        <div class="mrc-body">
          ${errMsg ? `<div class="mrc-err-banner">${_esc(errMsg)}</div>` : ''}
          <div class="mrc-field-lbl">Batch number</div>
          <input id="mrc-batch-in" class="mrc-input" type="text" inputmode="none"
            autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false"
            placeholder="Scan or type batch" value="${_esc(c.batchNo || '')}"/>
          <div class="mrc-field-lbl">Expiry date</div>
          <input id="mrc-expiry-in" class="mrc-input" type="date"
            value="${_esc(_toDateInput(c.expiry))}"/>
          <div class="mrc-fb dim" id="mrc-fb">Enter on expiry to continue</div>
        </div>
      </div>
      <div class="mrc-actions">
        <button id="mrc-back-btn" class="mrc-btn mrc-btn-secondary">&lt;- Back</button>
        ${kbButtonHtml()}
        <button id="mrc-next-btn" class="mrc-btn mrc-btn-primary">Next -&gt;</button>
      </div>`;

    const bIn = document.getElementById('mrc-batch-in');
    const eIn = document.getElementById('mrc-expiry-in');

    bIn?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); Keyboard.close(); eIn?.focus(); }
    });
    eIn?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); submitBatch(); }
    });
    document.getElementById('mrc-next-btn')?.addEventListener('click', submitBatch);
    document.getElementById('mrc-back-btn')?.addEventListener('click', () => {
      Keyboard.close(); renderQty();
    });
    wireVoiceBtn('mrc-batch-in');
    wireKbButton('mrc-batch-in', 'alpha', () => { Keyboard.close(); eIn?.focus(); }, 'Batch number');
    setTimeout(() => bIn?.focus(), 90);
    setTimeout(measureHeight, 30);
  }

  function _toDateInput(v) {
    if (!v) return '';
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const n = Number(s);
    if (!isNaN(n) && n > 100000) {
      const d = new Date(n < 1e12 ? n * 1000 : n);
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
    return '';
  }

  function submitBatch() {
    const c = State.cur;
    if (!c) return;
    const batchNo = _normaliseScan((document.getElementById('mrc-batch-in')?.value || '').trim());
    const expiry  = (document.getElementById('mrc-expiry-in')?.value || '').trim();

    if (!batchNo) { reject('Batch number is required', 'Batch required'); return; }

    // If the receipt declared an expected batch, flag a mismatch but let it through.
    if (c.detail.expected_batch_no &&
        String(c.detail.expected_batch_no).trim().toLowerCase() !== batchNo.toLowerCase()) {
      Audio.chime('warn');
      setFb(`Expected batch ${c.detail.expected_batch_no}`, 'err');
    }

    c.batchNo = batchNo;
    c.expiry  = expiry;
    beginLocation();
  }

  // ---------------------------------------------------------------------------
  // 14. SCREEN E - LOCATION
  // ---------------------------------------------------------------------------

  async function beginLocation() {
    const c = State.cur;
    if (!c) { renderScanItem(); return; }
    State.screen = 'TRANSITIONING';

    // Keep Location wins outright and skips the locating-rule round trip.
    if (State.keepLocation && State.lastLocation) {
      c.location  = State.lastLocation;
      c.suggested = State.lastLocation;
      c.viaKeep   = true;
      renderCheckDigit();
      return;
    }

    const root = document.getElementById('mrc-root');
    if (root) root.innerHTML = `<div class="mrc-loading"><div class="mrc-spinner"></div>Finding location...</div>`;

    const loc = await fetchSuggestedLocation(c.detail, c.item, c.uom, c.qty, c.batchNo);
    const code = String(loc?.location_code || '').trim();

    // 'NEW' (or nothing at all) means the item has no existing home.
    // Do not suggest anything - make the operator scan a bin.
    const isNoLocation =
      !loc || !loc.id || NO_LOCATION_TOKENS.includes(code.toLowerCase());

    if (isNoLocation) {
      c.location = null;
      c.suggested = null;
      renderLocationScan();
    } else {
      c.location  = loc;
      c.suggested = loc;
      renderCheckDigit();
    }
  }

  // E1 - no suggestion: blank field, red warning, operator scans the bin
  function renderLocationScan(errMsg) {
    const root = document.getElementById('mrc-root');
    if (!root) return;
    State.screen = 'LOCATION_SCAN';
    const c = State.cur;
    if (!c) { renderScanItem(); return; }

    root.innerHTML = `
      <div class="mrc-screen" id="mrc-screen">
        ${progressHtml('Put away', c.item.item_code,
          `${c.qty} ${_esc(uomName(c.uom))}${c.batchNo ? ' &middot; ' + _esc(c.batchNo) : ''}`, 'red')}
        <div class="mrc-body">
          ${errMsg ? `<div class="mrc-err-banner">${_esc(errMsg)}</div>` : ''}
          <div class="mrc-warn-red">NO EXISTING LOCATION</div>
          <div class="mrc-zone red">
            <div class="mrc-zone-lbl">Scan the location you are using</div>
            <input id="mrc-loc-in" class="mrc-input big nolocation" type="text" inputmode="none"
              autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false"
              placeholder="" value=""/>
          </div>
          <div class="mrc-fb dim" id="mrc-fb">Ready to scan</div>
          ${renderKeepHtml()}
        </div>
      </div>
      <div class="mrc-actions">
        <button id="mrc-back-btn" class="mrc-btn mrc-btn-secondary">&lt;- Back</button>
        ${kbButtonHtml()}
      </div>`;

    const inp = document.getElementById('mrc-loc-in');

    const submitLoc = async (rawVal) => {
      const raw = _normaliseScan(String(rawVal ?? inp.value).trim());
      if (!raw) return;
      inp.disabled = true;
      const loc = await resolveLocation(raw);
      inp.disabled = false;
      const retry = (msg) => {
        inp.value = '';
        Keyboard.sync();
        reject(msg, msg);
        setTimeout(() => inp.focus(), 60);
      };
      if (!loc)               return retry('Location not found');
      if (loc.status !== 1)   return retry('Location is inactive');
      Keyboard.close();
      c.location = loc;
      setFb('Location accepted', 'ok');
      Audio.chime('item_ok');
      renderCheckDigit();
    };

    inp?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.keyCode !== 13) return;
      e.preventDefault();
      submitLoc();
    });
    document.getElementById('mrc-back-btn')?.addEventListener('click', () => {
      Keyboard.close(); backFromLocation();
    });
    wireVoiceBtn('mrc-loc-in');
    wireKeepToggle('mrc-loc-in');
    wireTapRefocus('mrc-loc-in');
    wireKbButton('mrc-loc-in', 'alpha', submitLoc, 'Location code');
    setTimeout(() => inp?.focus(), 100);
    setTimeout(measureHeight, 30);
    Voice.announceNoLocation();
  }

  // E2 - location known (suggested or kept): scan its check digit and we are done
  function renderCheckDigit(errMsg) {
    const root = document.getElementById('mrc-root');
    if (!root) return;
    State.screen = 'CHECK_DIGIT';
    const c = State.cur;
    if (!c || !c.location) { renderScanItem(); return; }

    // Every line ends on a deliberate scan. Where the bin has no check digit
    // configured, the location code itself becomes the confirmation - committing
    // on a bare Enter would let a stray scanner terminator receive the line.
    const digit    = String(c.location.check_digit ?? '').trim();
    const locCode  = String(c.location.location_code ?? '').trim();
    const noDigit  = digit === '';
    const expected = noDigit ? locCode : digit;

    // The locating rule will happily hand back a bin that C7 then refuses on
    // check-in (inactive, or single-item and already occupied). Flag it here so
    // the operator finds out at the terminal, not after walking to the aisle.
    const suspect =
      c.location.status !== 1                  ? 'this bin is marked inactive'
      : c.location.allow_multiple_items === 0   ? 'this bin only accepts one item code'
      : '';

    root.innerHTML = `
      <div class="mrc-screen" id="mrc-screen">
        ${progressHtml('Put away', c.location.location_code,
          `${_esc(c.item.item_code)} &middot; ${c.qty} ${_esc(uomName(c.uom))}` +
          `${c.viaKeep ? ' &middot; KEPT' : ''}${c.batchNo ? ' &middot; ' + _esc(c.batchNo) : ''}`,
          'green', true)}
        <div class="mrc-item verified">
          <div class="mrc-item-sku">${_esc(c.item.item_code)}</div>
          <div class="mrc-item-desc">${_esc(c.item.description || '')}</div>
          <div class="mrc-open-row">
            <div class="mrc-open-cell">
              <span class="mrc-open-lbl">Put away</span>
              <span class="mrc-open-val" style="color:#79c447">${c.qty}</span>
            </div>
            <div class="mrc-open-cell">
              <span class="mrc-open-lbl">${_esc(uomName(c.uom))}</span>
              <span class="mrc-open-val" style="font-size:16px;color:#9faecb">x${c.uom.factor || 1}</span>
            </div>
          </div>
        </div>
        <div class="mrc-body">
          ${errMsg ? `<div class="mrc-err-banner">${_esc(errMsg)}</div>` : ''}
          ${!errMsg && suspect ? `<div class="mrc-err-banner">Heads up: ${_esc(suspect)}.
            Check in may be refused - "Other bin" if it is.</div>` : ''}
          <div class="mrc-zone${noDigit ? ' amber' : ''}">
            <div class="mrc-zone-lbl">${noDigit
              ? 'No check digit - scan the location label' : 'Scan check digit'}</div>
            <div class="mrc-arrows">&gt;&gt;&gt;</div>
            <input id="mrc-cd-in" class="mrc-hidden-in" type="text" inputmode="none"
              autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"/>
          </div>
          <div class="mrc-fb dim" id="mrc-fb">Ready to scan</div>
          ${renderKeepHtml()}
        </div>
      </div>
      <div class="mrc-actions">
        <button id="mrc-back-btn" class="mrc-btn mrc-btn-secondary">&lt;- Back</button>
        ${kbButtonHtml()}
      </div>`;

    const inp = document.getElementById('mrc-cd-in');

    const submitCd = (rawVal) => {
      const raw = _normaliseScan(String(rawVal ?? inp.value).trim());
      inp.value = '';
      Keyboard.sync();
      if (!raw) return;
      // Accept the check digit, or the full location code - some C7 location
      // templates set check_digit to the code itself.
      const ok = raw.toLowerCase() === expected.toLowerCase() ||
                 raw.toUpperCase() === locCode.toUpperCase();
      if (ok) { Keyboard.close(); doCheckin(); }
      else {
        const m = noDigit ? 'Wrong location' : 'Wrong check digit';
        reject(m, m);
        setTimeout(() => inp.focus(), 60);
      }
    };

    inp?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.keyCode !== 13) return;
      e.preventDefault();
      submitCd();
    });

    document.getElementById('mrc-back-btn')?.addEventListener('click', () => {
      Keyboard.close(); backFromLocation();
    });
    wireEditLocation();
    wireVoiceBtn('mrc-cd-in');
    wireKeepToggle('mrc-cd-in');
    wireTapRefocus('mrc-cd-in');
    // Check digits are numeric, but the ABC toggle is one tap away.
    wireKbButton('mrc-cd-in', 'num', submitCd, noDigit ? 'Location code' : 'Check digit');
    setTimeout(() => inp?.focus(), 100);
    setTimeout(measureHeight, 30);
    setTimeout(() => Voice.announcePutaway(
      c.qty, uomName(c.uom), c.location.location_code, State.lastLocation?.location_code
    ), 140);
  }

  // ---------------------------------------------------------------------------
  // 15. KEEP LOCATION
  // ---------------------------------------------------------------------------

  function renderKeepHtml() {
    const on   = State.keepLocation;
    const last = State.lastLocation?.location_code;
    return `
      <div class="mrc-keep${on ? ' on' : ''}" id="mrc-keep">
        <span class="mrc-keep-box">${on ? '✓' : ''}</span>
        <span class="mrc-keep-txt">Keep Location</span>
        <span class="mrc-keep-sub">${on
          ? (last ? _esc(last) : 'next bin will be locked in')
          : 'uses suggested bin'}</span>
      </div>`;
  }

  function wireKeepToggle(refocusId) {
    document.getElementById('mrc-keep')?.addEventListener('click', () => {
      State.keepLocation = !State.keepLocation;
      try { sessionStorage.setItem('mrc_keeploc', State.keepLocation ? '1' : '0'); } catch (_) {}
      // If turned on while a location is already on screen, adopt it as the kept bin.
      if (State.keepLocation && State.cur?.location) State.lastLocation = State.cur.location;
      const el = document.getElementById('mrc-keep');
      if (el) el.outerHTML = renderKeepHtml();
      wireKeepToggle(refocusId);
      if (navigator.vibrate) navigator.vibrate([20]);
      if (refocusId) setTimeout(() => document.getElementById(refocusId)?.focus(), 60);
    });
  }

  // ---------------------------------------------------------------------------
  // 16. CHECK IN (the write) + advance
  // ---------------------------------------------------------------------------

  // Hard re-entrancy latch. A double trigger-pull on the check digit, or a
  // scanner that repeats its terminator, must never produce two writes.
  let _writeInFlight = false;

  async function doCheckin() {
    const c = State.cur;
    if (!c || !c.location || _writeInFlight) return;
    _writeInFlight = true;

    State.screen = 'TRANSITIONING';
    Keyboard.close();
    setFb('Checking in...', 'dim');
    document.querySelector('.mrc-item')?.classList.add('verified');

    // Freeze every control that could mutate State.cur mid-flight. "Other bin"
    // in particular would null out c.location while the write is in the air.
    const cdIn = document.getElementById('mrc-cd-in');
    if (cdIn) cdIn.disabled = true;
    document.querySelectorAll('.mrc-actions .mrc-btn').forEach(b => { b.disabled = true; });

    // Snapshot everything the success path needs, so nothing can be pulled out
    // from under us between the await and the render.
    const detailId   = c.detail.id;
    const locRec     = c.location;
    const qty        = c.qty;
    const uomLabel   = uomName(c.uom);
    const baseQty    = qty;   // quantity is already in base units
    const openBefore = c.detail.open_quantity || 0;

    try {
      let result, recoveredOpen = null;

      try {
        result = await postCheckin(c.detail, c.item, c.uom, qty, locRec.id);
      } catch (firstErr) {
        if (firstErr.message?.includes('Session expired')) throw firstErr;

        // A C7 business rejection (numeric `code`, e.g. 1087 "Multiple Items not
        // allowed in this location") is deterministic - it committed nothing and
        // re-posting would only fail again. Surface it straight away.
        if (firstErr.c7Code) throw firstErr;

        // The first POST may well have COMMITTED before the error surfaced -
        // proxy timeout, dropped socket, or a non-JSON 200. C7's checkin has no
        // idempotency key, so blindly re-posting would double-receive the stock.
        // Ask C7 what the line looks like now and only retry if it clearly did
        // not land.
        const fresh = await refreshDetail(c.detail, c.item).catch(() => null);

        if (fresh && typeof fresh.open_quantity === 'number' &&
            fresh.open_quantity <= openBefore - baseQty) {
          console.warn('[MalpaRecv] first checkin landed despite error - NOT retrying');
          recoveredOpen = Math.max(0, fresh.open_quantity);
          result = { total: recoveredOpen, location: null };
        } else {
          if (fresh?.id) {
            c.detail = { ...c.detail, ...fresh };
            const i = State.details.findIndex(d => d.id === fresh.id);
            if (i >= 0) State.details[i] = { ...State.details[i], ...fresh };
          }
          await new Promise(r => setTimeout(r, 400));
          result = await postCheckin(c.detail, c.item, c.uom, qty, locRec.id);
        }
      }

      // ---- committed ----
      Audio.chime('line_done');
      if (navigator.vibrate) navigator.vibrate([30]);
      State.done++;
      State.lastLocation = locRec;

      // Maintain open_quantity locally so the next scan costs no round trip.
      let idx = State.details.findIndex(d => d.id === detailId);
      if (idx < 0) idx = State.details.findIndex(d => d.id === c.detail.id);
      if (idx >= 0) {
        const d = State.details[idx];
        d.open_quantity = recoveredOpen !== null
          ? recoveredOpen
          : Math.max(0, (d.open_quantity || 0) - baseQty);
        // updated_at is deliberately NOT touched - C7 owns that value and a
        // locally-invented timestamp could fail an optimistic-lock check.
        c.detail = d;
        if (d.open_quantity <= 0) State.linesDone.add(d.id);
      } else {
        // Should not happen, but never guess: re-read the receipt rather than
        // leave a line that can be received twice or block completion.
        console.warn('[MalpaRecv] detail', detailId, 'not in local state - reloading');
        await reloadDetails();
      }

      // C7 returns `total` = open quantity remaining across the WHOLE receipt
      // (verified: a 101-unit receipt returned 41 after a 60-unit check-in).
      // That is authoritative, so prefer it over local arithmetic.
      const remaining = (result && typeof result.total === 'number')
        ? result.total : openUnits();

      if (remaining <= 0) renderReceiptComplete();
      else renderScanItem(`Checked in ${qty} ${uomLabel} to ${locRec.location_code}`, 'ok');

    } catch (err) {
      console.error('[MalpaRecv] checkin failed:', err);
      Audio.chime('error');
      Voice.error('Check in failed');
      if (navigator.vibrate) navigator.vibrate([60, 30, 60]);
      // Nothing was committed, so the line is untouched and rescanning is safe.
      State.screen = 'CHECK_DIGIT';
      // 1087 = the bin already holds a different item and is flagged single-item.
      // Retrying the same bin can never work, so point at "Other bin" instead.
      const hint = err.c7Code === 1087
        ? ' - this bin will not take a second item. Tap "Other bin".'
        : ' - nothing was received. Scan again to retry.';
      renderCheckDigit('Check in failed: ' + err.message + hint);
    } finally {
      _writeInFlight = false;
    }
  }

  // Re-read the receipt's detail lines from C7 and rebuild local state.
  async function reloadDetails() {
    try {
      const header = await fetchReceiptHeader(State.receiptId);
      if (!header) { State.details = []; return; }
      State.header  = header;
      State.details = (header.receiptDetails || []).map(d => ({ ...d }));
    } catch (e) {
      console.warn('[MalpaRecv] reloadDetails failed:', e.message);
    }
  }

  // ---------------------------------------------------------------------------
  // 17. RECEIPT COMPLETE
  // ---------------------------------------------------------------------------

  function renderReceiptComplete() {
    const root = document.getElementById('mrc-root');
    if (!root) return;
    State.screen = 'RECEIPT_COMPLETE';
    const num = State.header?.receipt_num || State.receiptId;

    root.innerHTML = `
      <div class="mrc-screen" id="mrc-screen">
        ${progressHtml('Receipt complete', num, 'All lines checked in and located', 'green')}
        <div class="mrc-center">
          <div style="font-size:44px;line-height:1;color:#79c447;font-weight:700">&#10003;</div>
          <div style="font-size:19px;font-weight:700;color:#3a8f3a">Receipt complete</div>
          <div style="font-size:13px;color:#9faecb">${linesCompleted()} of ${
            totalDetailLines()} line${totalDetailLines() === 1 ? '' : 's'} completed${
            State.done > linesCompleted() ? ` in ${State.done} put-aways` : ''}</div>
          <div style="font-size:12px;color:#9faecb">${_esc(State.header?.company?.company_code || '')}</div>
        </div>
      </div>
      <div class="mrc-actions">
        <button id="mrc-next-receipt" class="mrc-btn mrc-btn-primary">Next Receipt</button>
      </div>`;

    Audio.chime('receipt_done');
    Voice.speak('Receipt complete');
    if (navigator.vibrate) navigator.vibrate([30, 50, 30, 50, 60]);

    document.getElementById('mrc-next-receipt')?.addEventListener('click', () => {
      State.resetReceipt();
      renderReceiptEntry();
    });
    setTimeout(measureHeight, 30);
  }

  // ---------------------------------------------------------------------------
  // 18. FOCUS RECOVERY  (TC51 sleep / notification steals focus)
  // ---------------------------------------------------------------------------

  const _FOCUS_MAP = {
    RECEIPT_ENTRY: 'mrc-receipt-in',
    SCAN_ITEM:     'mrc-scan-in',
    QTY:           'mrc-qty-in',
    BATCH:         'mrc-batch-in',
    LOCATION_SCAN: 'mrc-loc-in',
    CHECK_DIGIT:   'mrc-cd-in',
    OVER_CONFIRM:  'mrc-over-in',
  };

  function _refocus() {
    // Never pull focus while we are minimised behind a C7 tab - the operator is
    // typing in Canary7, not in us.
    if (!isForeground()) return;
    const id = _FOCUS_MAP[State.screen];
    if (!id) return;
    const el = document.getElementById(id);
    if (!el || !document.contains(el)) return;
    if (document.activeElement === el) return;
    el.focus();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') setTimeout(_refocus, 300);
  });
  window.addEventListener('focus', () => setTimeout(_refocus, 200));
  setInterval(() => {
    if (!isForeground()) return;
    _refocus();
  }, 2500);

  // ---------------------------------------------------------------------------
  // 19. CLOSE / KEYBOARD
  // ---------------------------------------------------------------------------

  function closeUI() {
    document.removeEventListener('keydown', onGlobalKey);
    window.removeEventListener('resize', measureHeight);
    Voice.cancel();
    Keyboard.close();

    if (!R._sidebarWasMinimized) document.body.classList.remove('sidebar-minimized');
    if (!R._brandWasMinimized)   document.body.classList.remove('brand-minimized');

    // Clear our inline display:none off EVERY C7 panel we hid. Missing any one
    // of them leaves that tab permanently blank, even after we are gone.
    restoreC7Panels();

    const tabBar     = document.querySelector('ul.nav.nav-tabs[role="tablist"]');
    const tabContent = document.querySelector('div.tab-content');

    document.getElementById('mrc-tab-li')?.remove();
    document.getElementById('mrc-tab-view')?.remove();

    if (tabBar && R._tabGuard) {
      tabBar.removeEventListener('click', R._tabGuard, true);
      R._tabGuard = null;
    }

    // Hand the foreground back to whichever C7 tab we took it from.
    const li = (R._prevActiveLi && document.contains(R._prevActiveLi))
      ? R._prevActiveLi
      : (tabBar && Array.from(tabBar.querySelectorAll('li.nav-item')).pop());
    _setTabActive(li, true);

    const panels = tabContent
      ? Array.from(tabContent.querySelectorAll(':scope > tab, :scope > .tab-pane')) : [];
    const panel = (R._prevActivePanel && document.contains(R._prevActivePanel))
      ? R._prevActivePanel
      : panels[panels.length - 1];
    if (panel) {
      panel.classList.add('active');
      panel.style.display = '';
    }

    State.resetReceipt();
    State.screen = 'RECEIPT_ENTRY';
    R = {};
  }

  function onGlobalKey(e) {
    // Esc must not close us while the operator is working in a C7 tab.
    if (!isForeground()) return;
    if (e.key === 'Escape') { e.preventDefault(); closeUI(); }
  }

  // ---------------------------------------------------------------------------
  // 20. OPEN
  // ---------------------------------------------------------------------------

  function openReceiving() {
    // Already built - we may just be minimised behind a C7 tab, so come forward
    // rather than no-op. State is untouched, so a part-done receipt resumes.
    if (document.getElementById('mrc-tab-view')) { activateSelf(); return; }
    try {
      injectCSS();
      buildShell();
    } catch (err) {
      console.error('[MalpaRecv] openReceiving error:', err);
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;top:80px;left:210px;right:20px;z-index:99999;' +
        'background:#7f1d1d;color:#fff;padding:16px 20px;border-radius:6px;' +
        'font-family:monospace;font-size:13px;white-space:pre-wrap;';
      d.textContent = '[MalpaRecv Error] ' + err.message + '\n\n' + err.stack;
      const x = document.createElement('button');
      x.textContent = 'x';
      x.style.cssText = 'float:right;background:none;border:none;color:#fff;font-size:20px;' +
        'cursor:pointer;margin:-4px -4px 0 0;';
      x.onclick = () => d.remove();
      d.prepend(x);
      document.body.appendChild(d);
    }
  }

  // ---------------------------------------------------------------------------
  // 21. BOOT
  // ---------------------------------------------------------------------------

  captureSessionId();
  (async () => {
    for (let i = 0; i < 50 && !_sessionId; i++) {
      await new Promise(r => setTimeout(r, 100));
      captureSessionId();
    }
  })();

  let _attempts = 0;
  function tryInject() {
    if (document.querySelector('div.sidebar nav li.nav-item')) {
      injectCSS();
      injectNav();
      return;
    }
    if (++_attempts < 80) setTimeout(tryInject, 500);
  }

  new MutationObserver(() => {
    if (!document.getElementById('mrc-nav') &&
        document.querySelector('div.sidebar nav li.nav-item')) {
      injectNav();
    }
  }).observe(document.body, { childList: true, subtree: true });

  tryInject();
})();

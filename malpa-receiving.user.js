// ==UserScript==
// @name         Malpa Receiving
// @namespace    https://malpa.canary7.com
// @version      2.2.8
// @description  Fast single-screen receiving for Canary7 WMS - TC51 optimised
// @author       Malpa 3PL
// @updateURL    https://raw.githubusercontent.com/Malpa-3PL/Warehouse-Scripts/main/malpa-receiving.user.js
// @downloadURL  https://raw.githubusercontent.com/Malpa-3PL/Warehouse-Scripts/main/malpa-receiving.user.js
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

  // Receiving profile is ALWAYS Putaway (one step: check in + locate together).
  const PUTAWAY_PROCESS_ID = 3;
  // Storage class - the only class an operator may put away into.
  const STORAGE_CLASS_ID   = 1;
  // The location endpoint pages at 20 rows unless per-page is supplied.
  const LOCATION_PAGE_SIZE = 200;

  // A locating rule that returns location_code 'NEW' means the item has no
  // existing home - do not suggest anything, make the operator scan a bin.
  const NO_LOCATION_TOKENS = ['new', 'n/a', 'none', ''];

  // QUANTITY SEMANTICS - confirmed against a live factor-6 receive:
  // `quantity` on checkin is in BASE units, NOT in the selected UoM. A 100-each
  // line received as 10 cartons (factor 6) posts quantity=60 with the carton
  // item_unit_of_measure_id, and open_quantity drops 100 -> 40. So the number
  // must divide evenly by the factor whenever that factor is > 1.

  // The receipt_detail object C7 expects inside the checkin body - EXACTLY these
  // keys. The header expand hangs a nested `item` off each detail; sending that
  // back bloats the payload and can trip C7's validation.
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

  // ---------------------------------------------------------------------------
  // 1. AUTH + API
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
          if (key && (key.toLowerCase().includes('session') || key.toLowerCase().includes('shift')) &&
              val && /^\d+$/.test(val.trim())) {
            _sessionId = val.trim();
            return;
          }
        }
      } catch (_) {}
    }
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
    for (let i = 0; i < 5 && !_sessionId; i++) await new Promise(r => setTimeout(r, 50));
  }

  async function _handle(res) {
    if (res.status === 401) { _showSessionExpired(); throw new Error('Session expired'); }
    if (res.status === 404) { const e = new Error('Not found'); e.notFound = true; throw e; }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const e = new Error(body.message || `API error ${res.status}`);
      // C7 returns business rejections as a 500 carrying a numeric `code`
      // (e.g. 1087 "Multiple Items not allowed in this location"). Deterministic
      // refusals, not transport failures - never retry them.
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
    const b = document.createElement('div');
    b.style.cssText = 'position:absolute;inset:0;z-index:9999;background:rgba(0,0,0,.78);' +
      'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
      'padding:24px;gap:14px;text-align:center';
    b.innerHTML = `
      <div style="font-size:18px;font-weight:500;color:#fff">Session expired</div>
      <div style="font-size:13px;color:rgba(255,255,255,.75);line-height:1.5">
        Your C7 session has timed out.<br>Log back in to continue receiving.
      </div>
      <button id="mrc-sess-x" style="margin-top:8px;padding:11px 22px;background:#20a8d8;color:#fff;
        border:none;font-size:14px;font-family:Roboto,sans-serif;cursor:pointer">Dismiss</button>`;
    root.style.position = 'relative';
    root.appendChild(b);
    document.getElementById('mrc-sess-x')?.addEventListener('click', () => {
      b.remove(); _sessionExpiredShown = false; State.resetReceipt(); render();
    });
  }

  // ---------------------------------------------------------------------------
  // 2. STATE
  // ---------------------------------------------------------------------------

  const State = {
    profile:   null,
    header:    null,
    receiptId: '',
    details:   [],

    itemsById:  {},
    refMap:     {},
    locByCode:  {},
    locsLoaded: false,

    // The line being received. null until an item is verified.
    // { detail, item, uom, qty, batchNo, expiry, location, locResolved, viaKeep }
    cur: null,

    keepLocation: (() => {
      try { return sessionStorage.getItem('mrc_keeploc') === '1'; } catch (_) { return false; }
    })(),
    lastLocation: null,

    voiceEnabled: (() => {
      try { const v = sessionStorage.getItem('mrc_voice'); return v === null ? true : v === '1'; }
      catch (_) { return true; }
    })(),

    done: 0,
    failedItems: [],
    busy: null,        // label shown while an async step runs
    err: '',           // banner text
    notice: '',        // sticky confirmation, e.g. a receipt closing
    fb: '',            // inline feedback under the active field
    fbType: 'dim',
    focusTarget: null, // element id to focus after the next render

    resetReceipt() {
      this.header = null; this.receiptId = ''; this.details = [];
      this.itemsById = {}; this.refMap = {}; this.cur = null;
      this.done = 0; this.failedItems = [];
      this.err = ''; this.fb = ''; this.busy = null; this.notice = '';
    },
    resetLine() {
      this.cur = null; this.fb = ''; this.fbType = 'dim'; this.err = '';
    },
  };

  let R = {};

  // ---------------------------------------------------------------------------
  // 3. CSS  (C7's own form tokens: .form-control padding .5rem .75rem,
  //          border 1px #e1e6ef, focus #8ad4ee, readonly bg #e1e6ef,
  //          .card-header bg #f9f9fa, heading #374767)
  // ---------------------------------------------------------------------------

  function injectCSS() {
    if (document.getElementById('mrc-styles')) return;
    const s = document.createElement('style');
    s.id = 'mrc-styles';
    s.textContent = `
      #mrc-tab-view {
        display:flex; flex-direction:column; height:calc(100vh - 55px);
        max-height:100vh; overflow:hidden; background:#f0f3f6; padding:0; position:relative;
      }
      #mrc-root {
        flex:1; display:flex; flex-direction:column; overflow:hidden; min-width:0;
        font-family:Roboto,sans-serif; font-size:.875rem; color:#374767; box-sizing:border-box;
      }
      #mrc-root *, #mrc-root *::before, #mrc-root *::after { box-sizing:border-box; }

      /* ---- card ---- */
      .mrc-card {
        flex:1; min-height:0; display:flex; flex-direction:column;
        background:#fff; border:1px solid #e1e6ef;
      }
      /* No title bar - the space goes to the fields. Just the running totals. */
      .mrc-card-hdr {
        flex-shrink:0; display:flex; align-items:center; gap:8px;
        padding:.4rem .75rem; background:#f9f9fa; border-bottom:1px solid #e1e6ef;
      }
      .mrc-card-meta {
        flex:1; font-size:12px; color:#374767; font-weight:500;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
      }
      .mrc-prog { height:2px; background:#e1e6ef; flex-shrink:0; }
      .mrc-prog-fill { height:2px; background:#20a8d8; transition:width .3s ease; }

      .mrc-card-body {
        flex:1; min-height:0; overflow-y:auto; -webkit-overflow-scrolling:touch;
        padding:.55rem .75rem .7rem; position:relative;
      }

      /* Hidden scan catcher. inputmode="none" means it holds focus WITHOUT
         opening the native keyboard, so dismissing the keyboard never costs the
         operator the ability to scan. */
      .mrc-catch {
        position:absolute; top:0; left:0; width:1px; height:1px; opacity:0;
        padding:0; border:0; background:transparent; caret-color:transparent;
        pointer-events:none;
      }

      /* With the native keyboard up the visible area is small - tighten rows so
         the live field and its context still fit. The totals stay visible. */
      #mrc-root.compact .mrc-prog { display:none; }
      #mrc-root.compact .mrc-card-hdr { padding:.25rem .6rem; }
      #mrc-root.compact .mrc-card-body { padding:.3rem .6rem .4rem; }
      #mrc-root.compact .mrc-done { padding:2px 0; font-size:13px; }
      #mrc-root.compact .mrc-fg, #mrc-root.compact .mrc-split { margin:.3rem 0 .2rem; }
      #mrc-root.compact .mrc-static { padding:1px 0; }
      #mrc-root.compact .mrc-keep { padding:3px 0 0; }
      #mrc-root.compact .mrc-btn { min-height:36px; }
      /* While the keyboard is up, nothing tappable may sit above it - the
         operator needs neutral space to tap to dismiss the keyboard and see the
         form. Enter still commits, so the buttons lose nothing by hiding. */
      #mrc-root.compact .mrc-actions { display:none; }
      #mrc-root.compact .mrc-card-body { padding:.3rem .6rem 2.75rem; }

      /* ---- completed rows: one compact line each, so the whole flow fits ---- */
      .mrc-done {
        display:flex; align-items:center; gap:7px; padding:5px 0;
        border-bottom:1px solid #f2f4f8; font-size:14px; line-height:1.3;
      }
      .mrc-done-lbl { color:#9faecb; flex-shrink:0; font-size:12px; }
      .mrc-done-val {
        color:#374767; font-weight:500; flex:1; min-width:0;
        overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
      }
      .mrc-done-val.emph { color:#b5551d; }
      .mrc-pencil {
        flex-shrink:0; border:none; background:transparent; color:#20a8d8;
        font-size:16px; line-height:1; padding:2px 5px; cursor:pointer;
        -webkit-tap-highlight-color:transparent; touch-action:manipulation;
      }
      .mrc-pencil:active { color:#1985ac; }

      /* ---- active form group (C7 .form-group / label / .form-control) ---- */
      .mrc-fg { margin:.5rem 0 .35rem; }
      .mrc-lbl { display:block; margin-bottom:.3rem; font-size:13px; color:#5d7d9a; }
      .mrc-fc {
        display:block; width:100%; padding:.5rem .75rem; font-size:15px;
        line-height:1.25; color:#374767; background:#fff; background-image:none;
        border:1px solid #e1e6ef; border-radius:0; outline:none;
        transition:border-color .15s ease-in-out; font-family:Roboto,sans-serif;
        -webkit-tap-highlight-color:transparent;
      }
      .mrc-fc:focus { border-color:#8ad4ee; }
      .mrc-fc::placeholder { color:#c0cadd; }
      .mrc-fc[readonly], .mrc-fc:disabled { background:#e1e6ef; opacity:1; }
      .mrc-fc.big { font-size:21px; font-weight:500; min-height:46px; letter-spacing:.02em; }
      .mrc-fc.qty { font-size:26px; font-weight:500; min-height:50px; color:#b5551d; }
      /* Check digits are 1-3 characters - a full-width box wastes the row. */
      .mrc-fc.cd {
        width:130px; font-size:22px; font-weight:500; min-height:46px;
        text-align:center; letter-spacing:.06em;
      }
      .mrc-fc.nolocation { border:1px solid #ff5454; background:#fff8f8; }
      select.mrc-fc {
        -webkit-appearance:none; appearance:none; cursor:pointer; min-height:40px;
        padding-right:26px;
        background:#fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%239faecb' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 9px center;
      }

      /* item + UoM share one row to save vertical space */
      .mrc-split { display:flex; align-items:flex-end; gap:8px; margin:.5rem 0 .35rem; }
      .mrc-split-l { flex:1; min-width:0; }
      .mrc-split-r { flex:0 0 132px; }
      .mrc-inline-val {
        display:flex; align-items:center; gap:5px; min-height:40px;
        font-size:17px; font-weight:500; color:#374767;
        overflow:hidden; white-space:nowrap; text-overflow:ellipsis;
      }

      .mrc-static { font-size:13px; color:#374767; padding:3px 0; line-height:1.35; }
      .mrc-static b { font-weight:500; }
      .mrc-static .v { color:#b5551d; }

      .mrc-fb { font-size:13px; font-weight:500; min-height:17px; padding-top:3px; }
      .mrc-fb.ok { color:#4a9c2d; } .mrc-fb.err { color:#e03131; } .mrc-fb.dim { color:#9faecb; }

      .mrc-warn-red {
        font-size:12px; font-weight:500; color:#e03131; padding:2px 0 4px; letter-spacing:.01em;
      }
      .mrc-banner {
        padding:7px 10px; margin:0 0 .5rem; background:#fff5f5; border:1px solid #ffcdd2;
        color:#c62828; font-size:12px; line-height:1.4;
      }
      .mrc-banner.info { background:#f0f8fd; border-color:#b8e4f5; color:#1a7fa8; }
      .mrc-banner.ok {
        background:#f1f9ec; border-color:#c6e5b3; color:#3d7a22;
        font-size:14px; font-weight:500;
      }

      /* ---- keep location: ONLY the box is a hit target, not the whole row ---- */
      .mrc-keep { display:flex; align-items:center; gap:8px; padding:7px 0 2px; }
      .mrc-keep-box {
        width:24px; height:24px; border:1px solid #9faecb; flex-shrink:0;
        display:flex; align-items:center; justify-content:center;
        font-size:15px; line-height:1; color:#fff; cursor:pointer; background:#fff;
        -webkit-tap-highlight-color:transparent; touch-action:manipulation;
      }
      .mrc-keep-box:active { border-color:#20a8d8; }
      .mrc-keep.on .mrc-keep-box { border-color:#20a8d8; background:#20a8d8; }
      .mrc-keep-txt { font-size:13px; color:#374767; }
      .mrc-keep-sub { font-size:12px; color:#9faecb; }

      /* ---- buttons ----
         These sit INSIDE the form, below the last field, rather than pinned to
         the bottom edge. Pinned to the footer they hugged the screen edge and
         were far too easy to hit when aiming at empty space below a field. */
      .mrc-actions {
        display:flex; gap:8px; margin:1rem 0 .25rem;
        padding-top:.6rem; border-top:1px solid #e1e6ef;
      }
      .mrc-btn {
        flex:1; min-height:42px; display:inline-flex; align-items:center; justify-content:center;
        padding:.5rem .75rem; font-size:13px; font-family:Roboto,sans-serif;
        border:1px solid transparent; border-radius:0; cursor:pointer; white-space:nowrap;
        -webkit-tap-highlight-color:transparent; touch-action:manipulation;
      }
      .mrc-btn:active { opacity:.85; }
      .mrc-btn-primary { background:#20a8d8; border-color:#20a8d8; color:#fff; }
      .mrc-btn-primary:disabled { opacity:.5; cursor:not-allowed; }
      .mrc-btn-secondary { background:#fff; border-color:#e1e6ef; color:#374767; }
      .mrc-btn-danger { background:#ff5454; border-color:#ff5454; color:#fff; }

      /* ---- overlays ---- */
      .mrc-ov {
        position:absolute; inset:0; background:rgba(0,0,0,.6); display:flex;
        align-items:flex-start; justify-content:center; z-index:200; padding:14px;
      }
      .mrc-ov-card { background:#fff; width:100%; border:1px solid #e1e6ef; }
      .mrc-ov-hdr { padding:10px 14px; font-size:14px; font-weight:500; color:#fff; background:#ff5454; }
      .mrc-ov-body { padding:14px; font-size:13px; color:#374767; line-height:1.5; }
      .mrc-ov-body strong { color:#e03131; font-weight:500; }
      .mrc-ov-acts { display:flex; flex-direction:column; gap:6px; padding:0 14px 14px; }

      .mrc-voice {
        flex-shrink:0; border:none; background:transparent; color:#9faecb;
        font-size:15px; padding:2px 4px; cursor:pointer; line-height:1;
        -webkit-tap-highlight-color:transparent; touch-action:manipulation;
      }
      .mrc-voice.muted { opacity:.45; }

      .mrc-flash {
        position:absolute; inset:0; z-index:9999; opacity:0; pointer-events:none;
        transition:opacity .06s ease-in;
      }
      .mrc-flash.ok { background:#79c447; } .mrc-flash.err { background:#ff5454; }

      .mrc-spin {
        display:inline-block; width:15px; height:15px; border:2px solid #e1e6ef;
        border-top-color:#20a8d8; border-radius:50%; animation:mrc-spin .7s linear infinite;
        vertical-align:-2px; margin-right:6px;
      }
      @keyframes mrc-spin { to { transform:rotate(360deg); } }

      /* ---- sidebar nav ---- */
      #mrc-nav-li { order:-1; }
      #mrc-nav {
        display:flex !important; align-items:center; gap:10px; padding:10px 12px;
        color:#79c447 !important; font-weight:500; cursor:pointer;
        text-decoration:none !important;
      }
      #mrc-nav:hover { background:rgba(121,196,71,.10); }
      #mrc-nav .mrc-nav-label { font-size:17px; font-weight:500; }
    `;
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------------------
  // 4. NAV
  // ---------------------------------------------------------------------------

  const NAV_ICON = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" rx="4" fill="#79c447"/>` +
    `<path d="M4 13.5V7l3 2.6L10 7l3 2.6L16 7v6.5" fill="none" stroke="#fff" stroke-width="1.7" ` +
    `stroke-linecap="round" stroke-linejoin="round"/></svg>`);

  let _navClick = false;
  function attachNavClick() {
    if (_navClick) return;
    _navClick = true;
    document.addEventListener('click', (e) => {
      const nav = document.getElementById('mrc-nav');
      if (nav && (nav === e.target || nav.contains(e.target))) openReceiving();
    }, true);
  }

  let _prefetched = false;
  function injectNav() {
    attachNavClick();
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
    a.innerHTML = `<span style="width:20px;height:20px;display:flex;flex-shrink:0">` +
      `<img src="${NAV_ICON}" style="width:20px;height:20px"/></span>` +
      `<span class="mrc-nav-label">Malpa Receiving</span>`;
    li.appendChild(a);
    ul.insertBefore(li, ul.firstChild);

    if (!_prefetched) {
      _prefetched = true;
      setTimeout(() => { loadProfile().catch(() => {}); loadLocations().catch(() => {}); }, 600);
    }
  }

  // ---------------------------------------------------------------------------
  // 5. TAB SHELL
  // ---------------------------------------------------------------------------
  // C7's panels have to be hidden with an inline style while we are in front,
  // but an inline style BEATS the .active class - so if one is left behind,
  // clicking that C7 tab shows a blank panel. Every panel we touch is recorded
  // and restored exactly, both when stepping aside and when closing.

  let _hiddenPanels = [];

  function hideC7Panels(tabContent) {
    tabContent.querySelectorAll(':scope > tab, :scope > .tab-pane').forEach(p => {
      if (p.id === 'mrc-tab-view') return;
      _hiddenPanels.push({ el: p, display: p.style.display });
      p.classList.remove('active');
      p.style.display = 'none';
    });
  }
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
    if (a) { a.classList.toggle('active', on); a.setAttribute('aria-selected', on ? 'true' : 'false'); }
  }

  function isForeground() {
    const p = document.getElementById('mrc-tab-view');
    return !!p && p.classList.contains('active');
  }

  // Size to the VISUAL viewport, not window.innerHeight. When Android's keyboard
  // slides up, innerHeight often does not change - the visual viewport shrinks
  // instead. Measuring the wrong one leaves the panel full height, so the browser
  // scrolls the document to reach the focused field and the form disappears
  // behind the keyboard. Tracking visualViewport keeps the form in the space
  // above the keyboard, the way C7 behaves.
  function measureHeight() {
    const panel = document.getElementById('mrc-tab-view');
    if (!panel || !panel.classList.contains('active')) return;
    const vv = window.visualViewport;
    const viewH  = vv ? vv.height : window.innerHeight;
    const offset = vv ? vv.offsetTop : 0;
    const top    = panel.getBoundingClientRect().top - offset;
    const avail  = Math.floor(viewH - top);
    if (avail > 80) {
      panel.style.height    = avail + 'px';
      panel.style.maxHeight = avail + 'px';
      panel.style.minHeight = avail + 'px';
    }
    // With the keyboard up there is very little room, so shed the chrome.
    const root = document.getElementById('mrc-root');
    if (root) root.classList.toggle('compact', avail < 330);
  }

  function attachViewportWatch() {
    if (R._vvWatch) return;
    R._vvWatch = () => measureHeight();
    window.addEventListener('resize', R._vvWatch);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', R._vvWatch);
      window.visualViewport.addEventListener('scroll', R._vvWatch);
    }
  }
  function detachViewportWatch() {
    if (!R._vvWatch) return;
    window.removeEventListener('resize', R._vvWatch);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', R._vvWatch);
      window.visualViewport.removeEventListener('scroll', R._vvWatch);
    }
    R._vvWatch = null;
  }

  function c7Lists() {
    const tabBar     = document.querySelector('ul.nav.nav-tabs[role="tablist"]');
    const tabContent = document.querySelector('div.tab-content');
    return {
      tabContent,
      lis: tabBar ? Array.from(tabBar.querySelectorAll('li.nav-item'))
        .filter(x => x.id !== 'mrc-tab-li') : [],
      panels: tabContent ? Array.from(tabContent.querySelectorAll(':scope > tab, :scope > .tab-pane'))
        .filter(p => p.id !== 'mrc-tab-view') : [],
    };
  }

  // Put the active class back on a C7 tab ourselves.
  // Angular will NOT do it for us when there is only one C7 tab: from its point
  // of view that tab is already selected, so clicking it changes nothing and it
  // never re-renders. With two or more tabs the click is a real state change, so
  // it repainted and the bug hid itself. We restore the class either way.
  function activateC7Tab(preferLi) {
    const { lis, panels } = c7Lists();
    if (!lis.length) return;
    let target = (preferLi && lis.includes(preferLi)) ? preferLi : null;
    if (!target && R._prevActiveLi && lis.includes(R._prevActiveLi)) target = R._prevActiveLi;
    if (!target) target = lis[lis.length - 1];

    lis.forEach(x => _setTabActive(x, x === target));

    // Tab bar order maps to tab-content order (ours is appended last and is
    // filtered out of both lists).
    const idx = lis.indexOf(target);
    let panel = panels[idx];
    if (!panel) {
      panel = (R._prevActivePanel && panels.includes(R._prevActivePanel))
        ? R._prevActivePanel : panels[panels.length - 1];
    }
    // Class only - restoreC7Panels already handed inline display back to C7.
    panels.forEach(p => p.classList.toggle('active', p === panel));
  }

  function minimiseSelf(preferLi) {
    const panel = document.getElementById('mrc-tab-view');
    if (!panel) return;
    restoreC7Panels();
    panel.classList.remove('active');
    panel.style.display = 'none';
    _setTabActive(document.getElementById('mrc-tab-li'), false);

    // Only drive the selection ourselves if nothing else is already active -
    // when C7 opened a tab under its own steam it has already done this.
    const { panels } = c7Lists();
    if (!panels.some(p => p.classList.contains('active'))) activateC7Tab(preferLi);

    if (!R._sidebarWasMinimized) document.body.classList.remove('sidebar-minimized');
    if (!R._brandWasMinimized)   document.body.classList.remove('brand-minimized');
  }

  function activateSelf() {
    const tabBar     = document.querySelector('ul.nav.nav-tabs[role="tablist"]');
    const tabContent = document.querySelector('div.tab-content');
    const li         = document.getElementById('mrc-tab-li');
    const panel      = document.getElementById('mrc-tab-view');
    if (!tabBar || !tabContent || !panel) return;

    const curLi    = tabBar.querySelector('li.nav-item.active');
    const curPanel = tabContent.querySelector(':scope > .tab-pane.active, :scope > tab.active');
    if (curLi    && curLi    !== li)    R._prevActiveLi    = curLi;
    if (curPanel && curPanel !== panel) R._prevActivePanel = curPanel;

    tabBar.querySelectorAll('li.nav-item').forEach(x => { if (x !== li) _setTabActive(x, false); });
    hideC7Panels(tabContent);

    panel.style.display = '';
    panel.classList.add('active');
    _setTabActive(li, true);
    R._activatedAt = Date.now();   // opens the brief Angular-repaint window
    document.body.classList.add('sidebar-minimized', 'brand-minimized');
    setTimeout(measureHeight, 50);
  }

  function attachTabSwitchGuard(tabBar) {
    if (R._tabGuard) return;
    R._tabGuard = (e) => {
      if (!document.getElementById('mrc-tab-view')) return;
      const li = e.target.closest && e.target.closest('li.nav-item');
      if (!li || li.id === 'mrc-tab-li') return;
      minimiseSelf(li);   // pass the tab they actually tapped
    };
    tabBar.addEventListener('click', R._tabGuard, true);
  }

  // Keeping our panel hidden whenever a C7 tab is in front.
  //
  // This cannot rely on a captured tab-content reference or on C7's stylesheet:
  // opening a NEW tab appends a pane (sometimes to a container Angular has since
  // replaced), and our panel is a div.tab-pane that C7's CSS will not necessarily
  // hide just because the active class is absent. Left alone it stayed on screen,
  // stacked under the new tab's content. So the rule is enforced on our panel's
  // CURRENT parent, and our own display is always set explicitly.
  function enforceTabVisibility() {
    const panel = document.getElementById('mrc-tab-view');
    if (!panel) return;
    const parent = panel.parentElement;
    if (!parent) return;

    const others = Array.from(parent.children)
      .filter(p => p !== panel && (p.matches?.('tab, .tab-pane')));
    const active   = others.filter(p => p.classList.contains('active'));
    const weActive = panel.classList.contains('active');

    if (weActive && active.length) {
      // A pane we already hid turning itself back on *immediately* after we came
      // to the front is Angular finishing its render, not the operator going
      // somewhere - push it back down and stay put. Anything we have never seen
      // is a new tab, and anything that happens later is real navigation; both
      // mean we step aside.
      const allKnown = active.every(p => _hiddenPanels.some(r => r.el === p));
      const justActivated = Date.now() - (R._activatedAt || 0) < 1200;
      if (allKnown && justActivated) {
        active.forEach(p => { p.classList.remove('active'); p.style.display = 'none'; });
      } else {
        minimiseSelf();
      }
      return;
    }
    // Belt and braces: never visible while not the active tab.
    if (!weActive && panel.style.display !== 'none') panel.style.display = 'none';
    if (weActive && panel.style.display === 'none')  panel.style.display = '';
  }

  function attachPanelWatcher() {
    if (R._panelObs) return;
    R._panelObs = new MutationObserver(enforceTabVisibility);
    // Watch the whole tab region rather than one captured node, so a new tab
    // appended anywhere in there is still noticed.
    const host = document.querySelector('div.tab-content')?.parentElement || document.body;
    R._panelObs.observe(host, {
      attributes: true, attributeFilter: ['class'], childList: true, subtree: true,
    });
    // Cheap safety net for anything the observer cannot see.
    R._visTimer = setInterval(enforceTabVisibility, 400);
  }

  function buildShell() {
    if (document.getElementById('mrc-tab-view')) return;
    const tabBar     = document.querySelector('ul.nav.nav-tabs[role="tablist"]');
    const tabContent = document.querySelector('div.tab-content');
    if (!tabBar || !tabContent) { console.warn('[MalpaRecv] C7 tabs not found'); return; }

    const tabLi = document.createElement('li');
    tabLi.id = 'mrc-tab-li';
    tabLi.className = 'nav-item';
    tabLi.innerHTML = `
      <a class="nav-link" href="javascript:void(0)"
         style="display:inline-flex;align-items:center;gap:6px;padding-right:8px;">
        Malpa Receiving
        <span id="mrc-tab-close" title="Close (Esc)" style="display:inline-flex;align-items:center;
          justify-content:center;width:18px;height:18px;font-size:14px;line-height:1;color:#374767;
          cursor:pointer;opacity:.6;-webkit-tap-highlight-color:transparent;">&times;</span>
      </a>`;
    tabBar.appendChild(tabLi);
    tabLi.querySelector('#mrc-tab-close').addEventListener('click', (e) => {
      e.stopPropagation(); closeUI();
    });
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
    attachPanelWatcher();
    activateSelf();
    attachViewportWatch();

    Audio.init();
    render();
    loadProfile().catch(e => console.warn('[MalpaRecv] profile:', e.message));
    loadLocations().catch(e => console.warn('[MalpaRecv] locations:', e.message));
  }

  // ---------------------------------------------------------------------------
  // 6. LOADERS  (each cached - fetched once, never per scan)
  // ---------------------------------------------------------------------------

  async function loadProfile() {
    if (State.profile) return State.profile;
    const data = await apiGet('configuration/receiving-profile/my-list&expand=dynamicInput');
    const list = Array.isArray(data) ? data : (data?.items || []);
    State.profile =
      list.find(p => p.receiving_process === PUTAWAY_PROCESS_ID) ||
      list.find(p => (p.name || '').trim().toLowerCase() === 'putaway') ||
      list[0] || null;
    return State.profile;
  }

  async function loadLocations() {
    if (State.locsLoaded) return;
    const data = await wmsGet(
      `location?warehouse_id=${WAREHOUSE_ID}&location_class_id=${STORAGE_CLASS_ID}` +
      `&per-page=${LOCATION_PAGE_SIZE}&page=1&search=`);
    const list = Array.isArray(data) ? data : (data?.items || []);
    const map = {};
    for (const l of list) if (l?.location_code) map[String(l.location_code).trim().toUpperCase()] = l;
    State.locByCode = map;
    State.locsLoaded = true;
    console.log('[MalpaRecv] cached', Object.keys(map).length, 'storage locations');
  }

  async function resolveLocation(code) {
    const key = String(code || '').trim().toUpperCase();
    if (!key) return null;
    if (State.locByCode[key]) return State.locByCode[key];
    try {
      const data = await wmsGet(
        `location?warehouse_id=${WAREHOUSE_ID}&location_class_id=${STORAGE_CLASS_ID}` +
        `&per-page=${LOCATION_PAGE_SIZE}&page=1&search=${encodeURIComponent(key)}`);
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
      `&expand=${encodeURIComponent(EXPAND)}`);
    const arr = Array.isArray(data) ? data : (data ? [data] : []);
    return arr[0] || null;
  }

  // ONE verify call per distinct item, in parallel, cached. C7 fires this on
  // every single scan - we do not.
  async function buildItemCache(header) {
    const EXPAND = ['itemUnitOfMeasures.unitOfMeasure',
      'itemUnitOfMeasures.itemUnitOfMeasureReference',
      'permanentLocation', 'defaultImage'].join(',');
    const codes = [...new Set((header.receiptDetails || [])
      .map(d => d.item?.item_code).filter(Boolean))];

    const results = await Promise.all(codes.map(code =>
      apiGet(`receiving/receiving/verify-item-and-reference-by-code&id=${header.id}` +
        `&item_code=${encodeURIComponent(code)}&company_id=${header.company_id}` +
        `&expand=${encodeURIComponent(EXPAND)}`)
        .catch(e => { console.warn('[MalpaRecv] verify', code, e.message); return null; })));

    const itemsById = {}, refMap = {}, failed = [];
    results.forEach((item, i) => {
      if (!item?.id) { failed.push(codes[i]); return; }
      itemsById[item.id] = item;
      // UoM references first, so every reference carries its UoM. Mapping the
      // item_code first would leave uomId null for items where a UoM reference
      // equals the item code (common in C7).
      for (const uom of (item.itemUnitOfMeasures || [])) {
        for (const r of (uom.itemUnitOfMeasureReference || [])) {
          const k = String(r.reference || '').trim().toLowerCase();
          if (k && !(k in refMap)) refMap[k] = { itemId: item.id, uomId: uom.id };
        }
      }
      const ck = String(item.item_code).trim().toLowerCase();
      if (!(ck in refMap)) refMap[ck] = { itemId: item.id, uomId: null };
    });
    State.itemsById = itemsById;
    State.refMap = refMap;
    State.failedItems = failed;
    console.log('[MalpaRecv] cached', Object.keys(itemsById).length, 'items,',
      Object.keys(refMap).length, 'barcodes');
  }

  async function fetchSuggestedLocation(detail, item, uom, qty, batchNo) {
    const p = State.profile;
    const path = `receiving/receipt-detail/get-location-by-locating-rule` +
      `&item_id=${item.id}&locating_rule_id=${detail.locating_rule_id}` +
      `&default_receiving_dock_id=${p.default_receiving_dock}` +
      `&default_inventory_status=${encodeURIComponent(p.default_inventory_status || 'available')}` +
      `&item_uom_id=${uom.id}&quantity=${qty}` +
      `&receiving_process_id=${p.receiving_process}` +
      `&receipt_number=${encodeURIComponent(State.header.receipt_num)}` +
      `&pre_check=true&batch=${batchNo ? encodeURIComponent(batchNo) : 'null'}`;
    try { return await apiGet(path); } catch (_) { return null; }
  }

  async function refreshDetail(detail, item) {
    const c = State.cur;
    return apiGet(`receiving/receipt-detail/get-detail-by-item` +
      `&receipt_header_id=${State.header.id}&item_id=${item.id}` +
      `&profile_id=${State.profile.id}` +
      `&batch_no=${c?.batchNo ? encodeURIComponent(c.batchNo) : 'null'}` +
      `&expiry=${c?.expiry ? encodeURIComponent(c.expiry) : 'null'}` +
      `&detail_id=${detail.id}`);
  }

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
  // 7. VOICE + AUDIO
  // ---------------------------------------------------------------------------

  function _formatLocForSpeech(loc, prevLoc) {
    if (!loc) return '';
    const segs = String(loc).split('-');
    const prev = prevLoc ? String(prevLoc).split('-') : [];
    let skip = 0;
    for (let i = 0; i < segs.length - 1; i++) {
      if (prev[i] && prev[i].toUpperCase() === segs[i].toUpperCase()) skip++; else break;
    }
    return segs.slice(skip).map(seg => {
      const m = seg.match(/^([A-Za-z]*)(\d+)$/);
      if (!m) return seg;
      return m[1] ? m[1] + ' ' + parseInt(m[2], 10) : String(parseInt(m[2], 10));
    }).join(', ');
  }

  const Voice = {
    speak(t) {
      if (!State.voiceEnabled || !window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(t));
      u.rate = 1.8; u.volume = 1;
      window.speechSynthesis.speak(u);
    },
    putaway(qty, uom, loc, prev) {
      let s = '';
      if (uom && uom.toLowerCase() !== 'each') {
        s = ' ' + (qty > 1 && !uom.toLowerCase().endsWith('s') ? uom + 's' : uom);
      }
      this.speak(`Put ${qty}${s} to ${_formatLocForSpeech(loc, prev)}`);
    },
    noLocation() { this.speak('No existing location. Scan a bin.'); },
    cancel() { if (window.speechSynthesis) window.speechSynthesis.cancel(); },
    // Errors bypass the mute toggle - a reject must always be audible.
    error(m) {
      if (!window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(m));
      u.rate = 1.7; u.volume = 1;
      window.speechSynthesis.speak(u);
    },
  };

  const Audio = {
    _ctx: null,
    init() {
      if (this._ctx) return;
      try { this._ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {}
    },
    _tone(f, dur, type = 'sine', g = .4, delay = 0) {
      if (!this._ctx) return;
      try {
        const o = this._ctx.createOscillator(), gain = this._ctx.createGain();
        o.connect(gain); gain.connect(this._ctx.destination);
        o.type = type;
        o.frequency.setValueAtTime(f, this._ctx.currentTime + delay);
        gain.gain.setValueAtTime(g, this._ctx.currentTime + delay);
        gain.gain.exponentialRampToValueAtTime(.001, this._ctx.currentTime + delay + dur);
        o.start(this._ctx.currentTime + delay);
        o.stop(this._ctx.currentTime + delay + dur);
      } catch (_) {}
    },
    chime(t) {
      this.init();
      if (!this._ctx) return;
      if (this._ctx.state === 'suspended') this._ctx.resume();
      if (t === 'item_ok')      { this._tone(880, .15, 'sine', .35); this._tone(880, .10, 'sine', .15, .15); }
      else if (t === 'line_done')    { this._tone(660, .12, 'sine', .30); this._tone(880, .20, 'sine', .40, .13); }
      else if (t === 'receipt_done') { this._tone(660, .12, 'sine', .30); this._tone(880, .12, 'sine', .35, .13); this._tone(1175, .24, 'sine', .40, .26); }
      else if (t === 'error')   { this._tone(180, .08, 'square', .30); this._tone(180, .08, 'square', .30, .12); }
      else if (t === 'warn')    { this._tone(420, .14, 'triangle', .32); this._tone(330, .18, 'triangle', .32, .15); }
    },
  };

  // ---------------------------------------------------------------------------
  // 8. HELPERS
  // ---------------------------------------------------------------------------

  function _esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // TC51 scanners sometimes emit shifted digits when Android's shift state is
  // stuck during focus().
  const _SHIFT_NUMS = { '!': '1', '@': '2', '#': '3', '$': '4', '%': '5',
                        '^': '6', '&': '7', '*': '8', '(': '9', ')': '0' };
  function _normaliseScan(v) {
    return String(v).split('').map(c => _SHIFT_NUMS[c] || c).join('');
  }

  function isBatch(item) { return item?.enable_batch === 1 || item?.enable_batch === true; }
  function uomName(u) { return u?.unitOfMeasure?.name || u?.unitOfMeasure?.description || 'Each'; }

  // Bias to the BASE unit when only an item_code was scanned: guessing a carton
  // would silently multiply the received quantity by its factor.
  function defaultUomFor(item) {
    const u = item?.itemUnitOfMeasures || [];
    if (!u.length) return null;
    return u.find(x => x.unit_of_measure_id === item.base_unit_of_measure)
        || u.find(x => (x.factor || 1) === 1)
        || u.slice().sort((a, b) => (a.factor || 1) - (b.factor || 1))[0];
  }

  function openLines()  { return State.details.filter(d => (d.open_quantity || 0) > 0).length; }
  function openUnits()  { return State.details.reduce((s, d) => s + Math.max(0, d.open_quantity || 0), 0); }
  // Progress is DETAIL LINES: fully-received details out of total details.
  function linesCompleted() { return State.details.filter(d => (d.open_quantity || 0) <= 0).length; }
  function totalDetailLines() { return State.details.length; }

  function openDetailForItem(itemId) {
    return State.details
      .filter(d => d.item_id === itemId && (d.open_quantity || 0) > 0)
      .sort((a, b) => (a.line_number || 0) - (b.line_number || 0))[0] || null;
  }

  // Every barcode that identifies the current item (its code + all UoM refs).
  function refsForItem(item) {
    const out = [String(item.item_code || '').trim().toLowerCase()];
    for (const u of (item.itemUnitOfMeasures || [])) {
      for (const r of (u.itemUnitOfMeasureReference || [])) {
        const k = String(r.reference || '').trim().toLowerCase();
        if (k) out.push(k);
      }
    }
    return out.filter(Boolean);
  }

  function flash(type) {
    const card = document.querySelector('.mrc-card');
    if (card) {
      const f = document.createElement('div');
      f.className = 'mrc-flash ' + type;
      card.style.position = 'relative';
      card.appendChild(f);
      requestAnimationFrame(() => {
        f.style.opacity = '.3';
        setTimeout(() => { f.style.opacity = '0'; setTimeout(() => f.remove(), 80); }, 80);
      });
    }
    if (navigator.vibrate) navigator.vibrate(type === 'ok' ? [30] : [60, 30, 60]);
  }

  function say(msg, type) { State.fb = msg; State.fbType = type || 'dim'; }

  function reject(msg, spoken) {
    say(msg, 'err');
    Audio.chime('error');
    Voice.error(spoken || msg);
    flash('err');
    render();
  }

  // ---------------------------------------------------------------------------
  // 9. THE SINGLE-SCREEN FORM
  // ---------------------------------------------------------------------------
  // One card. Rows are revealed as the previous ones are satisfied, and rows
  // already satisfied collapse to a compact one-line summary so the whole flow
  // stays on screen. Inputs are ordinary text fields, so Canary7's native
  // keyboard is what the operator gets.

  function doneRow(label, value, opts = {}) {
    return `
      <div class="mrc-done">
        <span class="mrc-done-lbl">${_esc(label)}</span>
        <span class="mrc-done-val${opts.emph ? ' emph' : ''}">${_esc(value)}</span>
        ${opts.editId ? `<button class="mrc-pencil" id="${opts.editId}"
          title="Change" aria-label="Change ${_esc(label)}">&#9998;</button>` : ''}
      </div>`;
  }

  function fieldRow(label, inputHtml, extra = '') {
    return `<div class="mrc-fg"><label class="mrc-lbl">${label}</label>${inputHtml}${extra}</div>`;
  }

  // True when focus is ours to take: either it is already inside our form, or
  // nothing at all holds it. If the operator has tapped into a C7 field, the
  // sidebar, or any other control, we must leave focus exactly where it is.
  function focusIsOurs() {
    const root = document.getElementById('mrc-root');
    const a = document.activeElement;
    if (!a || a === document.body || a === document.documentElement) return true;
    return !!root && root.contains(a);
  }

  function render() {
    const root = document.getElementById('mrc-root');
    if (!root) return;
    // Decide BEFORE the rebuild wipes activeElement.
    const mayFocus = focusIsOurs();

    const c       = State.cur;
    const hasRcpt = !!State.header;
    const hasItem = !!c;
    const batch   = hasItem && isBatch(c.item);
    const hasLoc  = hasItem && !!c.location;

    // Which single row is live? Everything before it collapses to one line.
    // Completion is tracked with explicit flags, not by testing for emptiness -
    // a batch line can arrive with expected_batch_no already filled in, and the
    // operator must still see and confirm that row.
    let stage;
    if (!hasRcpt)                     stage = 'receipt';
    else if (!hasItem)                stage = 'item';
    else if (!c.qtyDone)              stage = 'qty';
    else if (batch && !c.batchDone)   stage = 'batch';
    else if (!c.locResolved)          stage = 'wait';
    else if (!c.location)             stage = 'location';
    else                              stage = 'checkdigit';
    const needsLoc = stage === 'location';

    const done  = linesCompleted(), total = totalDetailLines();
    const pct   = total > 0 ? Math.round((done / total) * 100) : 0;

    let rows = '';

    // -- receipt -------------------------------------------------------------
    if (stage === 'receipt') {
      rows += fieldRow('Receipt Number',
        `<input id="mrc-receipt" class="mrc-fc big" type="text" autocomplete="off"
           autocorrect="off" autocapitalize="characters" spellcheck="false"
           placeholder="Scan or type receipt" value="${_esc(State.receiptId)}"/>`);
    } else {
      rows += doneRow('Receipt', State.header.receipt_num || State.receiptId,
        { editId: 'mrc-edit-receipt' });
    }

    // -- item (+ UoM sharing the row) ---------------------------------------
    if (hasRcpt && stage === 'item') {
      rows += fieldRow('Enter Item Code or Reference',
        `<input id="mrc-item" class="mrc-fc big" type="text" autocomplete="off"
           autocorrect="off" autocapitalize="characters" spellcheck="false"
           placeholder="Scan item"/>`);
    }

    // -- uom + quantity ------------------------------------------------------
    if (hasItem) {
      const factor   = c.uom.factor || 1;
      const openBase = c.detail.open_quantity || 0;

      if (stage === 'qty') {
        // Item and Unit of Measure share one row - the item is already known, so
        // it only needs reading, and that buys a whole row back.
        const opts = (c.item.itemUnitOfMeasures || []).map(u =>
          `<option value="${u.id}"${u.id === c.uom.id ? ' selected' : ''}>` +
          `${_esc(uomName(u))}(${u.factor || 1})</option>`).join('');
        rows += `
          <div class="mrc-split">
            <div class="mrc-split-l">
              <label class="mrc-lbl">Item</label>
              <div class="mrc-inline-val">
                <span style="overflow:hidden;text-overflow:ellipsis">${_esc(c.item.item_code)}</span>
                <button class="mrc-pencil" id="mrc-edit-item" title="Change item"
                  aria-label="Change item">&#9998;</button>
              </div>
            </div>
            <div class="mrc-split-r">
              <label class="mrc-lbl">Unit of Measure</label>
              <select id="mrc-uom" class="mrc-fc">${opts}</select>
            </div>
          </div>`;
        rows += `<div class="mrc-static"><b>Item Description :</b>
          <span class="v">${_esc(c.item.description || '')}</span></div>`;
        rows += fieldRow(`Check-In Quantity(open quantity : ${openBase})`,
          `<input id="mrc-qty" class="mrc-fc qty" type="text" inputmode="numeric"
             autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
             value="${c.qty != null ? c.qty : ''}"/>`,
          factor > 1
            ? `<div class="mrc-fb dim" id="mrc-qty-hint">Scan again to add ${factor}</div>` : '');
      } else {
        rows += doneRow('Item', `${c.item.item_code}  ${uomName(c.uom)}(${factor})`,
          { editId: 'mrc-edit-item' });
        rows += doneRow('Quantity', `${c.qty} of ${openBase}`, { emph: true, editId: 'mrc-edit-qty' });
      }
    }

    // -- batch / expiry (batch-tracked items only) ---------------------------
    if (hasItem && batch && c.qtyDone) {
      if (stage === 'batch') {
        rows += fieldRow('Batch Number',
          `<input id="mrc-batch" class="mrc-fc" type="text" autocomplete="off"
             autocorrect="off" autocapitalize="characters" spellcheck="false"
             placeholder="Scan or type batch" value="${_esc(c.batchNo || '')}"/>`);
        rows += fieldRow('Expiry Date',
          `<input id="mrc-expiry" class="mrc-fc" type="date" value="${_esc(_toDateInput(c.expiry))}"/>`);
      } else if (c.batchNo) {
        rows += doneRow('Batch', c.batchNo + (c.expiry ? '  exp ' + _toDateInput(c.expiry) : ''),
          { editId: 'mrc-edit-batch' });
      }
    }

    // -- location ------------------------------------------------------------
    if (stage === 'wait') {
      rows += `<div class="mrc-static" style="padding-top:6px">
        <span class="mrc-spin"></span>Finding location...</div>`;
    } else if (needsLoc) {
      // Only warn when the locating RULE found no home. If the operator opened
      // this row themselves with the pencil, they already know - saying it then
      // reads like an error.
      if (!c.locManual) rows += `<div class="mrc-warn-red">NO EXISTING LOCATION</div>`;
      rows += fieldRow('Location',
        `<input id="mrc-loc" class="mrc-fc big${c.locManual ? '' : ' nolocation'}" type="text"
           autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false"
           placeholder="Scan the bin you are using"/>`);
    } else if (hasLoc) {
      rows += `<div class="mrc-done">
        <span class="mrc-done-lbl">Location :</span>
        <span class="mrc-done-val">${_esc(c.location.location_code)}${c.viaKeep ? '  (kept)' : ''}</span>
        <button class="mrc-pencil" id="mrc-edit-loc" title="Change location"
          aria-label="Change location">&#9998;</button>
      </div>`;
      const digit   = String(c.location.check_digit ?? '').trim();
      const noDigit = digit === '';
      // Every line ends on a deliberate scan. Where the bin has no check digit,
      // the location code itself is the confirmation - committing on a bare
      // Enter would let a stray scanner terminator receive the line.
      rows += fieldRow(noDigit ? 'Check Digit (none set - scan the location label)' : 'Check Digit',
        `<input id="mrc-cd" class="mrc-fc ${noDigit ? 'big' : 'cd'}"
           type="text" inputmode="${noDigit ? 'text' : 'numeric'}"
           autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false"
           placeholder="${noDigit ? 'Scan location code' : ''}"/>`);
      // The locating rule will hand back bins C7 then refuses on check-in.
      if (c.location.status !== 1) {
        rows += `<div class="mrc-banner">Heads up: this bin is marked inactive.
          Check in may be refused - use the pencil to pick another.</div>`;
      } else if (c.location.allow_multiple_items === 0) {
        rows += `<div class="mrc-banner">Heads up: this bin only accepts one item code.
          Check in may be refused - use the pencil to pick another.</div>`;
      }
    }

    // -- keep location -------------------------------------------------------
    if (hasRcpt) {
      const on = State.keepLocation, last = State.lastLocation?.location_code;
      rows += `<div class="mrc-keep${on ? ' on' : ''}">
        <span class="mrc-keep-box" id="mrc-keep-box" role="checkbox"
          aria-checked="${on}" aria-label="Keep Location">${on ? '&#10003;' : ''}</span>
        <span class="mrc-keep-txt">Keep Location</span>
        <span class="mrc-keep-sub">${on ? (last ? _esc(last) : 'locks in the next bin')
                                        : 'uses suggested bin'}</span>
      </div>`;
    }

    // The primary button always performs the CURRENT step, so no stage can dead
    // end. This matters most on the batch row: its date field opens Android's
    // native picker, which swallows Enter, so a button is the only way out.
    const primary = {
      receipt:    { label: 'Load Receipt', on: true },
      item:        { label: 'Find Item',   on: true },
      qty:         { label: 'Next',        on: true },
      batch:       { label: 'Next',        on: true },
      location:    { label: 'Next',        on: true },
      checkdigit:  { label: 'Check In',    on: true },
      wait:        { label: 'Next',        on: false },
    }[stage] || { label: 'Next', on: false };

    root.innerHTML = `
      <div class="mrc-card">
        <div class="mrc-card-hdr">
          <span class="mrc-card-meta">${hasRcpt
            ? `${done} / ${total} lines completed &middot; ${openUnits()} units open`
            : 'Putaway &middot; one step check in &amp; locate'}</span>
          <button class="mrc-voice${State.voiceEnabled ? '' : ' muted'}" id="mrc-voice"
            title="Toggle voice" aria-label="Toggle voice">${State.voiceEnabled ? '&#128266;' : '&#128263;'}</button>
        </div>
        <div class="mrc-prog"><div class="mrc-prog-fill" style="width:${pct}%"></div></div>
        <div class="mrc-card-body" id="mrc-body">
          ${State.notice ? `<div class="mrc-banner ok">${_esc(State.notice)}</div>` : ''}
          ${State.err ? `<div class="mrc-banner">${_esc(State.err)}</div>` : ''}
          ${State.failedItems.length ? `<div class="mrc-banner">Could not load ${
            _esc(State.failedItems.join(', '))} - use the standard C7 window for those lines.</div>` : ''}
          ${State.busy ? `<div class="mrc-static"><span class="mrc-spin"></span>${_esc(State.busy)}</div>` : ''}
          ${rows}
          <div class="mrc-fb ${State.fbType}" id="mrc-fb">${_esc(State.fb)}</div>
          <div class="mrc-actions">
            ${hasItem
              ? `<button id="mrc-cancel" class="mrc-btn mrc-btn-secondary">Cancel line</button>`
              : `<button id="mrc-newrcpt" class="mrc-btn mrc-btn-secondary">New receipt</button>`}
            <button id="mrc-go" class="mrc-btn mrc-btn-primary"
              ${primary.on && !State.busy ? '' : 'disabled'}>${primary.label}</button>
          </div>
          <input id="mrc-catch" class="mrc-catch" type="text" inputmode="none"
            autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
            tabindex="-1" aria-hidden="true"/>
        </div>
      </div>`;

    wire(stage);
    if (mayFocus) focusStage(stage);
    setTimeout(measureHeight, 20);
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

  // Set when the operator taps neutral space to put the keyboard away. While it
  // holds, focus goes to the hidden catcher instead of the live field, so the
  // keyboard stays down but scans still land. Cleared the moment they tap a real
  // field again.
  let _kbDismissed = false;

  function focusStage(stage) {
    if (_kbDismissed) {
      setTimeout(() => {
        const cc = document.getElementById('mrc-catch');
        if (!cc) return;
        try { cc.focus({ preventScroll: true }); } catch (_) { cc.focus(); }
      }, 40);
      return;
    }
    const id = { receipt: 'mrc-receipt', item: 'mrc-item', qty: 'mrc-qty',
                 batch: 'mrc-batch', location: 'mrc-loc', checkdigit: 'mrc-cd' }[stage];
    if (!id) return;
    setTimeout(() => {
      const el = document.getElementById(id);
      if (!el) return;
      el.focus();
      // Select the value so a scan replaces it rather than appending.
      if (el.value) { try { el.select(); } catch (_) {} }
      // Keeps the live row clear of the native keyboard once it slides up.
      try { el.scrollIntoView({ block: 'nearest' }); } catch (_) {}
    }, 60);
  }

  function onEnter(el, fn) {
    el?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); fn(el.value); }
    });
  }

  function wire(stage) {
    const body    = document.getElementById('mrc-body');
    const catcher = document.getElementById('mrc-catch');

    // Tap neutral space to put the keyboard away. Focus moves to the hidden
    // catcher rather than being dropped, so the scanner keeps working with the
    // keyboard down and the whole form visible.
    body?.addEventListener('pointerdown', (e) => {
      if (e.target.closest('input, select, textarea, button, .mrc-keep-box, .mrc-pencil')) return;
      _kbDismissed = true;
      // preventScroll: the catcher sits at the top of the body, and without this
      // focusing it would jump the form back to the first row.
      try { catcher?.focus({ preventScroll: true }); } catch (_) { catcher?.focus(); }
      setTimeout(measureHeight, 250);
    });

    // Tapping a real field means they want to type again.
    body?.addEventListener('focusin', (e) => {
      if (e.target !== catcher && e.target.matches('input, select, textarea')) _kbDismissed = false;
    });

    // A scan that arrives at the catcher is handled exactly as if it had been
    // typed into whichever row is live.
    onEnter(catcher, (v) => {
      catcher.value = '';
      const raw = String(v || '').trim();
      if (!raw) return;
      if (stage === 'batch') {
        const b = document.getElementById('mrc-batch');
        if (b) b.value = raw;
        submitBatch();
        return;
      }
      ({ receipt: loadReceipt, item: submitItem, qty: submitQty,
         location: submitLocation, checkdigit: submitCheckDigit }[stage] || (() => {}))(raw);
    });

    document.getElementById('mrc-voice')?.addEventListener('click', () => {
      State.voiceEnabled = !State.voiceEnabled;
      try { sessionStorage.setItem('mrc_voice', State.voiceEnabled ? '1' : '0'); } catch (_) {}
      if (!State.voiceEnabled) Voice.cancel();
      render();
    });

    // Deliberately bound to the box alone - the whole row was far too easy to
    // hit by accident.
    document.getElementById('mrc-keep-box')?.addEventListener('click', () => {
      State.keepLocation = !State.keepLocation;
      try { sessionStorage.setItem('mrc_keeploc', State.keepLocation ? '1' : '0'); } catch (_) {}
      if (State.keepLocation && State.cur?.location) State.lastLocation = State.cur.location;
      if (navigator.vibrate) navigator.vibrate([20]);
      render();
    });

    document.getElementById('mrc-newrcpt')?.addEventListener('click', () => {
      State.resetReceipt(); render();
    });
    document.getElementById('mrc-cancel')?.addEventListener('click', () => {
      State.resetLine(); render();
    });
    // One button, whatever the current step happens to be.
    document.getElementById('mrc-go')?.addEventListener('click', () => {
      const v = (id) => document.getElementById(id)?.value || '';
      if (stage === 'receipt')         loadReceipt(v('mrc-receipt'));
      else if (stage === 'item')       submitItem(v('mrc-item'));
      else if (stage === 'qty')        submitQty(v('mrc-qty'));
      else if (stage === 'batch')      submitBatch();
      else if (stage === 'location')   submitLocation(v('mrc-loc'));
      else if (stage === 'checkdigit') submitCheckDigit(v('mrc-cd'));
    });

    // -- pencils: step back to a row already filled in ----------------------
    document.getElementById('mrc-edit-receipt')?.addEventListener('click', () => {
      State.resetReceipt(); render();
    });
    document.getElementById('mrc-edit-item')?.addEventListener('click', () => {
      State.resetLine(); render();
    });
    document.getElementById('mrc-edit-qty')?.addEventListener('click', () => {
      const c = State.cur;
      if (!c) return;
      c.qtyDone = false;
      c.location = null; c.locResolved = false; c.viaKeep = false;
      say('', 'dim'); render();
    });
    document.getElementById('mrc-edit-batch')?.addEventListener('click', () => {
      const c = State.cur;
      if (!c) return;
      c.batchDone = false;
      c.location = null; c.locResolved = false; c.viaKeep = false;
      render();
    });
    // Clear the location entirely so a new bin can be scanned.
    document.getElementById('mrc-edit-loc')?.addEventListener('click', () => {
      const c = State.cur;
      if (!c) return;
      c.location = null; c.suggested = null; c.viaKeep = false;
      c.locResolved = true; c.locManual = true;   // their choice, not a missing home
      if (navigator.vibrate) navigator.vibrate([20]);
      say('', 'dim');
      render();
    });

    onEnter(document.getElementById('mrc-receipt'), loadReceipt);
    onEnter(document.getElementById('mrc-item'), submitItem);
    onEnter(document.getElementById('mrc-qty'), submitQty);
    onEnter(document.getElementById('mrc-loc'), submitLocation);
    onEnter(document.getElementById('mrc-cd'), submitCheckDigit);

    const bIn = document.getElementById('mrc-batch');
    const eIn = document.getElementById('mrc-expiry');
    // Enter on the batch field completes the step using whatever expiry is
    // already set. It deliberately does NOT jump into the date field - doing so
    // popped Android's date picker every time, which is what made it feel like
    // the app kept demanding a date.
    onEnter(bIn, () => submitBatch());
    onEnter(eIn, () => submitBatch());
    // Hold onto a picked date immediately. Without this it lived only in the DOM
    // and was lost on the next re-render, so the step could never be satisfied.
    eIn?.addEventListener('change', () => {
      if (State.cur) State.cur.expiry = eIn.value;
    });

    const uom = document.getElementById('mrc-uom');
    uom?.addEventListener('change', () => {
      const c = State.cur;
      const nu = (c.item.itemUnitOfMeasures || []).find(u => String(u.id) === uom.value);
      // Switching pack size restarts the count at one pack of the new UoM.
      if (nu) { c.uom = nu; c.qty = nu.factor || 1; say('', 'dim'); render(); }
    });

    // Live pack-count readout while typing the quantity.
    const q = document.getElementById('mrc-qty');
    q?.addEventListener('input', updateQtyHint);
    if (stage === 'qty') updateQtyHint();
  }

  function updateQtyHint() {
    const c = State.cur, el = document.getElementById('mrc-qty-hint');
    if (!c || !el) return;
    const factor = c.uom.factor || 1;
    const open   = c.detail.open_quantity || 0;
    const n = parseFloat(_normaliseScan((document.getElementById('mrc-qty')?.value || '').trim()));
    if (isNaN(n) || n <= 0) { el.textContent = `Scan again to add ${factor}`; el.className = 'mrc-fb dim'; return; }
    if (n > open) {
      el.textContent = `${n} exceeds the ${open} open - you will be asked to confirm`;
      el.className = 'mrc-fb err'; return;
    }
    if (n % factor !== 0) {
      const lo = Math.floor(n / factor) * factor, hi = lo + factor;
      el.textContent = `${n} is not a whole ${uomName(c.uom)} - try ${lo || factor} or ${hi}`;
      el.className = 'mrc-fb err'; return;
    }
    el.textContent = `= ${n / factor} ${uomName(c.uom)}${n / factor === 1 ? '' : 's'}`;
    el.className = 'mrc-fb ok';
  }

  // ---------------------------------------------------------------------------
  // 10. STEP HANDLERS
  // ---------------------------------------------------------------------------

  async function loadReceipt(raw) {
    const id = _normaliseScan(String(raw || '').trim()).toUpperCase();
    if (!id) return;
    State.busy = 'Loading receipt...';
    State.err = ''; State.fb = ''; State.notice = '';
    State.receiptId = id;
    render();
    try {
      await loadProfile();
      if (!State.profile) throw new Error('No Putaway receiving profile available');

      const header = await fetchReceiptHeader(id).catch(e => { if (e.notFound) return null; throw e; });
      State.busy = null;
      if (!header) {
        State.header = null;
        State.err = `Receipt ${id} not found, or nothing left to check in.`;
        render(); Audio.chime('error'); Voice.error('Receipt not found');
        return;
      }
      State.header  = header;
      State.details = (header.receiptDetails || []).map(d => ({ ...d }));
      State.done    = 0;
      State.failedItems = [];
      try { sessionStorage.setItem('mrc_lastreceipt', id); } catch (_) {}

      if (!State.details.length) {
        State.header = null;
        State.err = `Receipt ${id} has no detail lines to receive.`;
        render(); return;
      }
      State.busy = 'Caching items...';
      render();
      await buildItemCache(header);
      loadLocations().catch(() => {});
      State.busy = null;
      say(`${openLines()} line${openLines() === 1 ? '' : 's'} to receive`, 'ok');
      Audio.chime('item_ok');
      render();
    } catch (err) {
      State.busy = null;
      State.header = null;
      State.err = 'Could not load receipt: ' + err.message;
      render();
    }
  }

  function submitItem(raw) {
    const key = _normaliseScan(String(raw || '').trim()).toLowerCase();
    if (!key) return;
    const hit = State.refMap[key];
    if (!hit) {
      const onReceipt = State.details.some(d =>
        String(d.item?.item_code || '').trim().toLowerCase() === key);
      reject(onReceipt ? 'Item data failed to load - use C7 for this line'
                       : 'Not on this receipt',
             onReceipt ? 'Item data error' : 'Item not on this receipt');
      return;
    }
    const item = State.itemsById[hit.itemId];
    const detail = openDetailForItem(hit.itemId);
    if (!item)   { reject('Item data missing - rescan', 'Item error'); return; }
    if (!detail) { reject('No open quantity left on this item', 'Line already complete'); return; }

    // Auto-select the UoM the scanned reference belongs to; still editable.
    let uom = hit.uomId ? (item.itemUnitOfMeasures || []).find(u => u.id === hit.uomId) : null;
    if (!uom) uom = defaultUomFor(item);
    if (!uom) { reject('Item has no unit of measure', 'Item error'); return; }

    State.cur = {
      detail, item, uom,
      // One scan = one pack. Scanning again on the quantity row adds another
      // factor; typing replaces. Same count-up behaviour as Malpa Pack.
      qty: uom.factor || 1,
      batchNo: detail.expected_batch_no || '',
      expiry:  detail.expected_batch_expiry || '',
      qtyDone: false, batchDone: false,
      location: null, suggested: null, locResolved: false, viaKeep: false,
    };
    say('Item verified', 'ok');
    Audio.chime('item_ok');
    flash('ok');
    render();
  }

  function submitQty(raw) {
    const c = State.cur;
    if (!c) return;
    const val    = _normaliseScan(String(raw || '').trim());
    const factor = c.uom.factor || 1;
    const open   = c.detail.open_quantity || 0;

    // A scan landing in this field is a count-up, not a quantity. Match the whole
    // value, or a barcode appended to what was already there ("6yenahyenah").
    const refs = refsForItem(c.item);
    const low  = val.toLowerCase();
    let scanned = refs.includes(low);
    let base    = null;
    if (!scanned) {
      for (const ref of refs) {
        if (low.length > ref.length && low.endsWith(ref)) {
          const prefix = low.slice(0, -ref.length);
          if (prefix === '' || /^\d+$/.test(prefix)) { scanned = true; base = prefix; break; }
        }
      }
    }
    if (scanned) {
      const from = base !== null ? (parseFloat(base) || 0) : (parseFloat(c.qty) || 0);
      c.qty = from + factor;
      Audio.chime('item_ok');
      if (navigator.vibrate) navigator.vibrate([25]);
      const el = document.getElementById('mrc-qty');
      if (el) { el.value = String(c.qty); el.select(); }
      updateQtyHint();
      return;
    }

    const qty = parseFloat(val);
    if (!val || isNaN(qty) || qty <= 0) { reject('Enter a quantity greater than zero', 'Invalid quantity'); return; }
    if (!Number.isInteger(qty) && !c.item.allow_partial_units) {
      reject('Whole units only for this item', 'Whole units only'); return;
    }
    // A factor-6 carton cannot hold 13 eaches.
    if (factor > 1 && qty % factor !== 0) {
      const lo = Math.floor(qty / factor) * factor, hi = lo + factor;
      reject(`${qty} is not a whole ${uomName(c.uom)} (x${factor}) - use ${lo || factor} or ${hi}`,
             `Not a whole ${uomName(c.uom)}`);
      return;
    }
    c.qty = qty;

    if (qty > open) {
      if (!State.profile.allow_over_receiving) {
        reject(`Over-receiving is off. Open is ${open}.`, 'Over receiving not allowed'); return;
      }
      showOverConfirm(qty, open);
      return;
    }
    afterQty();
  }

  function afterQty() {
    const c = State.cur;
    c.qtyDone = true;
    say('', 'dim');
    if (isBatch(c.item) && !c.batchDone) { render(); return; }   // batch row next
    beginLocation();
  }

  function submitBatch() {
    const c = State.cur;
    if (!c) return;
    const b = _normaliseScan((document.getElementById('mrc-batch')?.value || '').trim());
    // Fall back to state: on Android the picker can commit a value without the
    // element still being in the DOM we read from.
    const e = (document.getElementById('mrc-expiry')?.value || c.expiry || '').trim();
    if (!b) { reject('Batch number is required', 'Batch required'); return; }
    // Expiry is not blocked on - C7 accepts a null expiry, and refusing to move
    // on because a picker was dismissed is exactly the trap being fixed here.
    if (c.detail.expected_batch_no &&
        String(c.detail.expected_batch_no).trim().toLowerCase() !== b.toLowerCase()) {
      Audio.chime('warn');
      say(`Expected batch ${c.detail.expected_batch_no}`, 'err');
    } else {
      say('', 'dim');
    }
    c.batchNo = b; c.expiry = e; c.batchDone = true;
    beginLocation();
  }

  async function beginLocation() {
    const c = State.cur;
    if (!c) return;

    // Keep Location wins outright and skips the locating-rule round trip.
    if (State.keepLocation && State.lastLocation) {
      c.location = State.lastLocation; c.suggested = State.lastLocation;
      c.viaKeep = true; c.locResolved = true;
      render();
      Voice.putaway(c.qty, uomName(c.uom), c.location.location_code, null);
      return;
    }

    c.locResolved = false;
    c.locManual   = false;   // this is the rule's answer, not the operator's
    render();
    const loc  = await fetchSuggestedLocation(c.detail, c.item, c.uom, c.qty, c.batchNo);
    const code = String(loc?.location_code || '').trim();
    // 'NEW' (or nothing) means the item has no existing home - suggest nothing.
    const none = !loc || !loc.id || NO_LOCATION_TOKENS.includes(code.toLowerCase());

    c.locResolved = true;
    if (none) {
      c.location = null; c.suggested = null;
      render();
      Voice.noLocation();
    } else {
      c.location = loc; c.suggested = loc;
      render();
      Voice.putaway(c.qty, uomName(c.uom), loc.location_code, State.lastLocation?.location_code);
    }
  }

  async function submitLocation(raw) {
    const c = State.cur;
    if (!c) return;
    const code = _normaliseScan(String(raw || '').trim());
    if (!code) return;
    State.busy = 'Checking location...';
    render();
    const loc = await resolveLocation(code);
    State.busy = null;
    if (!loc)             { reject('Location not found', 'Location not found'); return; }
    if (loc.status !== 1) { reject('Location is inactive', 'Location inactive'); return; }
    // No "accepted" message - an unacceptable bin never gets this far, so
    // confirming the obvious is just noise.
    c.location = loc;
    say('', 'dim');
    Audio.chime('item_ok');
    render();
    Voice.putaway(c.qty, uomName(c.uom), loc.location_code, State.lastLocation?.location_code);
  }

  function submitCheckDigit(raw) {
    const c = State.cur;
    if (!c || !c.location) return;
    const digit   = String(c.location.check_digit ?? '').trim();
    const locCode = String(c.location.location_code ?? '').trim();
    const noDigit = digit === '';
    const expect  = noDigit ? locCode : digit;
    const val = _normaliseScan(String(raw || '').trim());
    if (!val) return;
    // Accept the check digit, or the location code - some C7 templates set
    // check_digit to the code itself.
    if (val.toLowerCase() === expect.toLowerCase() ||
        val.toUpperCase() === locCode.toUpperCase()) {
      doCheckin();
    } else {
      const el = document.getElementById('mrc-cd');
      if (el) el.value = '';
      reject(noDigit ? 'Wrong location' : 'Wrong check digit',
             noDigit ? 'Wrong location' : 'Wrong check digit');
    }
  }

  // ---------------------------------------------------------------------------
  // 11. OVER-RECEIVE (type OVER)
  // ---------------------------------------------------------------------------

  function showOverConfirm(qty, open) {
    const card = document.querySelector('.mrc-card');
    if (!card) return;
    document.getElementById('mrc-over-ov')?.remove();
    Audio.chime('warn');
    Voice.error('Over receiving. Type OVER to confirm.');

    const ov = document.createElement('div');
    ov.className = 'mrc-ov';
    ov.id = 'mrc-over-ov';
    ov.innerHTML = `
      <div class="mrc-ov-card">
        <div class="mrc-ov-hdr">Over-receiving</div>
        <div class="mrc-ov-body">
          Receiving <strong>${qty}</strong> against an open quantity of <strong>${open}</strong>.<br><br>
          Type <strong>OVER</strong> to confirm.
          <input id="mrc-over" class="mrc-fc big" type="text" autocomplete="off"
            autocorrect="off" autocapitalize="characters" spellcheck="false"
            placeholder="OVER" style="margin-top:9px"/>
          <div class="mrc-fb err" id="mrc-over-fb" style="min-height:15px"></div>
        </div>
        <div class="mrc-ov-acts">
          <button id="mrc-over-yes" class="mrc-btn mrc-btn-danger">Confirm over-receive</button>
          <button id="mrc-over-no"  class="mrc-btn mrc-btn-secondary">Cancel</button>
        </div>
      </div>`;
    card.style.position = 'relative';
    card.appendChild(ov);

    const inp = document.getElementById('mrc-over');
    const fb  = document.getElementById('mrc-over-fb');
    const go = () => {
      if (_normaliseScan((inp?.value || '').trim()).toUpperCase() === 'OVER') {
        ov.remove(); afterQty();
      } else {
        if (fb) fb.textContent = 'Type OVER exactly to confirm';
        Audio.chime('error');
        if (navigator.vibrate) navigator.vibrate([60, 30, 60]);
        if (inp) { inp.value = ''; inp.focus(); }
      }
    };
    onEnter(inp, go);
    document.getElementById('mrc-over-yes')?.addEventListener('click', go);
    document.getElementById('mrc-over-no')?.addEventListener('click', () => { ov.remove(); render(); });
    setTimeout(() => inp?.focus(), 90);
  }

  // ---------------------------------------------------------------------------
  // 12. CHECK IN (the write)
  // ---------------------------------------------------------------------------

  // Hard re-entrancy latch: a double trigger-pull on the check digit, or a
  // scanner repeating its terminator, must never produce two writes.
  let _writeInFlight = false;

  async function doCheckin() {
    const c = State.cur;
    if (!c || !c.location || _writeInFlight) return;
    _writeInFlight = true;

    State.busy = 'Checking in...';
    State.fb = '';
    render();
    document.querySelectorAll('#mrc-root input, #mrc-root select, #mrc-root button')
      .forEach(el => { el.disabled = true; });

    // Snapshot the success path's inputs so nothing can be pulled out from
    // under us between the await and the render.
    const detailId   = c.detail.id;
    const locRec     = c.location;
    const qty        = c.qty;
    const uomLabel   = uomName(c.uom);
    const baseQty    = qty;                       // quantity is already base units
    const openBefore = c.detail.open_quantity || 0;

    try {
      let result, recoveredOpen = null;
      try {
        result = await postCheckin(c.detail, c.item, c.uom, qty, locRec.id);
      } catch (firstErr) {
        if (firstErr.message?.includes('Session expired')) throw firstErr;
        // Deterministic refusal - nothing was written, so surface it now.
        if (firstErr.c7Code) throw firstErr;

        // The first POST may have COMMITTED before the error surfaced (proxy
        // timeout, dropped socket, non-JSON 200). Checkin has no idempotency
        // key, so blindly re-posting would double-receive. Ask C7 what the line
        // looks like now and only retry if the stock clearly did not land.
        const fresh = await refreshDetail(c.detail, c.item).catch(() => null);
        if (fresh && typeof fresh.open_quantity === 'number' &&
            fresh.open_quantity <= openBefore - baseQty) {
          console.warn('[MalpaRecv] first checkin landed despite error - NOT retrying');
          recoveredOpen = Math.max(0, fresh.open_quantity);
          result = { total: null };
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

      let idx = State.details.findIndex(d => d.id === detailId);
      if (idx < 0) idx = State.details.findIndex(d => d.id === c.detail.id);
      if (idx >= 0) {
        const d = State.details[idx];
        d.open_quantity = recoveredOpen !== null
          ? recoveredOpen
          : Math.max(0, (d.open_quantity || 0) - baseQty);
        // updated_at is deliberately NOT touched - C7 owns that value.
      } else {
        console.warn('[MalpaRecv] detail', detailId, 'not local - reloading');
        await reloadDetails();
      }

      // `total` is the open quantity remaining across the WHOLE receipt
      // (verified: a 101-unit receipt returned 41 after a 60-unit check-in).
      const remaining = (result && typeof result.total === 'number') ? result.total : openUnits();

      State.busy = null;
      State.cur  = null;

      if (remaining <= 0) {
        // Receipt is closed. Say so plainly and go back to the receipt prompt -
        // leaving the item row up would invite scans against a finished receipt.
        const num   = State.header?.receipt_num || State.receiptId;
        const lines = totalDetailLines();
        Audio.chime('receipt_done');
        Voice.speak('Receipt complete');
        if (navigator.vibrate) navigator.vibrate([30, 50, 30, 50, 60]);
        State.resetReceipt();
        State.notice = `${num} closed - all ${lines} line${lines === 1 ? '' : 's'} received. ` +
                       `Scan the next receipt.`;
      } else {
        say(`Checked in ${qty} ${uomLabel} to ${locRec.location_code}`, 'ok');
      }
      flash('ok');
      // Lands on the item row with the receipt still open, or on the receipt
      // row once it has closed - either way the next scan has a home.
      render();
    } catch (err) {
      console.error('[MalpaRecv] checkin failed:', err);
      Audio.chime('error');
      Voice.error('Check in failed');
      if (navigator.vibrate) navigator.vibrate([60, 30, 60]);
      State.busy = null;
      // 1087 = bin already holds a different item and is flagged single-item.
      State.err = 'Check in failed: ' + err.message + (err.c7Code === 1087
        ? ' - this bin will not take a second item. Use the pencil to pick another.'
        : ' - nothing was received.');
      render();
    } finally {
      _writeInFlight = false;
    }
  }

  async function reloadDetails() {
    try {
      const header = await fetchReceiptHeader(State.receiptId);
      if (!header) { State.details = []; return; }
      State.header = header;
      State.details = (header.receiptDetails || []).map(d => ({ ...d }));
    } catch (e) { console.warn('[MalpaRecv] reloadDetails:', e.message); }
  }

  // ---------------------------------------------------------------------------
  // 13. FOCUS RECOVERY  (TC51 sleep / notification steals focus)
  // ---------------------------------------------------------------------------

  // Recover the scan target after the TC51 sleeps or a notification steals
  // focus. Deliberately timid: it only acts when NOTHING holds focus, so it can
  // never pull the cursor out of a C7 field or another menu.
  function _refocus() {
    if (!isForeground()) return;
    const a = document.activeElement;
    if (a && a !== document.body && a !== document.documentElement) return;
    const root = document.getElementById('mrc-root');
    if (!root) return;
    // If the operator put the keyboard away, recover onto the catcher so it
    // stays down.
    const el = _kbDismissed
      ? document.getElementById('mrc-catch')
      : root.querySelector('input:not([disabled]):not(.mrc-catch), select:not([disabled])');
    if (el) { try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); } }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') setTimeout(_refocus, 300);
  });
  window.addEventListener('focus', () => setTimeout(_refocus, 200));

  // ---------------------------------------------------------------------------
  // 14. CLOSE / KEYBOARD
  // ---------------------------------------------------------------------------

  function closeUI() {
    document.removeEventListener('keydown', onGlobalKey);
    detachViewportWatch();
    if (R._panelObs) { R._panelObs.disconnect(); R._panelObs = null; }
    if (R._visTimer) { clearInterval(R._visTimer); R._visTimer = null; }
    Voice.cancel();

    if (!R._sidebarWasMinimized) document.body.classList.remove('sidebar-minimized');
    if (!R._brandWasMinimized)   document.body.classList.remove('brand-minimized');

    // Clear our inline display:none off EVERY C7 panel we hid - missing one
    // leaves that tab permanently blank.
    restoreC7Panels();

    const tabBar     = document.querySelector('ul.nav.nav-tabs[role="tablist"]');
    const tabContent = document.querySelector('div.tab-content');

    document.getElementById('mrc-tab-li')?.remove();
    document.getElementById('mrc-tab-view')?.remove();

    if (tabBar && R._tabGuard) {
      tabBar.removeEventListener('click', R._tabGuard, true);
      R._tabGuard = null;
    }

    const li = (R._prevActiveLi && document.contains(R._prevActiveLi))
      ? R._prevActiveLi
      : (tabBar && Array.from(tabBar.querySelectorAll('li.nav-item')).pop());
    _setTabActive(li, true);

    const panels = tabContent
      ? Array.from(tabContent.querySelectorAll(':scope > tab, :scope > .tab-pane')) : [];
    const panel = (R._prevActivePanel && document.contains(R._prevActivePanel))
      ? R._prevActivePanel : panels[panels.length - 1];
    if (panel) { panel.classList.add('active'); panel.style.display = ''; }

    State.resetReceipt();
    R = {};
  }

  function onGlobalKey(e) {
    if (!isForeground()) return;
    // Esc must not fire while the operator is typing in a field.
    if (e.key === 'Escape' && !document.getElementById('mrc-root')?.contains(document.activeElement)) {
      e.preventDefault(); closeUI();
    }
  }

  // ---------------------------------------------------------------------------
  // 15. OPEN
  // ---------------------------------------------------------------------------

  function openReceiving() {
    // Already built - we may just be minimised behind a C7 tab, so come forward
    // rather than no-op. State is untouched, so a part-done receipt resumes.
    if (document.getElementById('mrc-tab-view')) { activateSelf(); return; }
    try {
      injectCSS();
      buildShell();
    } catch (err) {
      console.error('[MalpaRecv] open error:', err);
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;top:80px;left:210px;right:20px;z-index:99999;' +
        'background:#7f1d1d;color:#fff;padding:16px 20px;font-family:monospace;' +
        'font-size:13px;white-space:pre-wrap;';
      d.textContent = '[MalpaRecv] ' + err.message + '\n\n' + err.stack;
      const x = document.createElement('button');
      x.textContent = '×';
      x.style.cssText = 'float:right;background:none;border:none;color:#fff;font-size:20px;cursor:pointer';
      x.onclick = () => d.remove();
      d.prepend(x);
      document.body.appendChild(d);
    }
  }

  // ---------------------------------------------------------------------------
  // 16. BOOT
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
    if (document.querySelector('div.sidebar nav li.nav-item')) { injectCSS(); injectNav(); return; }
    if (++_attempts < 80) setTimeout(tryInject, 500);
  }

  new MutationObserver(() => {
    if (!document.getElementById('mrc-nav') &&
        document.querySelector('div.sidebar nav li.nav-item')) injectNav();
  }).observe(document.body, { childList: true, subtree: true });

  tryInject();
})();

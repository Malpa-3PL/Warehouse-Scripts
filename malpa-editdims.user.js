// ==UserScript==
// @name         Malpa Edit Dimensions
// @namespace    https://malpa.canary7.com
// @version      1.1
// @description  Adds an "Edit Dimensions" button to the Canary7 consigning screen so a packer can correct a container's weight / length / width / height
// @author       Malpa 3PL
// @homepageURL  https://github.com/zaynnev/malpa3pl
// @supportURL   https://github.com/zaynnev/malpa3pl/issues
// @updateURL    https://raw.githubusercontent.com/Malpa-3PL/Warehouse-Scripts/main/malpa-editdims.user.js
// @downloadURL  https://raw.githubusercontent.com/Malpa-3PL/Warehouse-Scripts/main/malpa-editdims.user.js
// @match        https://*.canary7.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* =============================================================================
 * malpa-editdims  -  Edit Dimensions button, Canary7 consigning screen
 *
 * WHAT THIS DOES
 *   Injects one button next to C7's own "Edit Weight" button on the consigning
 *   screen. It scrapes the location code, container number and shipment number
 *   off the screen, resolves them to ids through the legacy monolith, lists the
 *   containers on the shipment, and lets the operator correct weight / length /
 *   width / height on the one they pick.
 *
 * WHY @grant none
 *   Everything is on *.canary7.com - the UI on malpa.canary7.com and the
 *   monolith API on stgauth.canary7.com. No non-Canary7 host is touched, so no
 *   grant is needed, and staying out of Tampermonkey's sandbox is what lets a
 *   plain fetch() carry the app's own session.
 *
 * HOUSE RULES OBSERVED
 *   - Adds to C7's chrome only. The button is inserted as a SIBLING of the
 *     existing one (insertAdjacentElement('afterend')). No C7 node is moved,
 *     restyled, or given an inline display:none.
 *   - Every id and class is prefixed `edim`.
 *   - getToken() / mkHeaders() / API_ROOT / WAREHOUSE_ID are lifted verbatim
 *     from malpa-transfer.user.js v2.6.1. No auth scheme was invented here.
 *
 * -----------------------------------------------------------------------------
 * CONFIRMED API BEHAVIOUR
 *   Probed read-only against the staging tenant on 2026-08-31, company 46
 *   (MA-TRL, the sandbox trial account), warehouse 10 (Darra - the only live
 *   warehouse; never target 9). Base for all four calls is the legacy monolith
 *   https://stgauth.canary7.com/index.php?r=<route>
 *
 *   (a) GET configuration/location?location_code=WDD-02&warehouse_id=10
 *         -> [{ id: 72037, location_code: "WDD-02", warehouse_id: 10,
 *               status: 1, location_type_id: 32, location_class_id: 6,
 *               enable_license_plate: 1 }]
 *       [0].id is close_to_location_id. An EMPTY ARRAY means the location is
 *       unknown - surface it, never guess an id.
 *
 *   (b) GET shipment/shipment-header?shipment_number=LA_TEST_SHIPMENT_20250822.1%23%237
 *           &warehouse_id=10
 *         -> [{ id: 737834, warehouse_id: 10, company_id: 46,
 *               consignment_id: 1235000, no_of_containers: 1,
 *               leading_status_id: 7, trailing_status_id: 7 }]
 *       [0].id is shipment_header_id.
 *
 *       '#' MUST BE PERCENT-ENCODED. The test shipment number contains '##'.
 *       An unencoded '#' truncates the URL at the fragment and the call
 *       silently returns the wrong thing. Every query string here goes through
 *       buildQuery()/encodeURIComponent - never string concatenation.
 *
 *   (c) GET shipment/shipment-container?shipment_header_id=737834
 *         -> [{ id: 1449741, container_no: "LA_TEST_SHIPMENT_20250822.1##7",
 *               status_id: 7, shipment_header_id: 737834,
 *               staging_dock_id: 72037, container_type_id: 39,
 *               consignment_id: 1235000, parent_id: null,
 *               weight: 0.84, length: 6, width: 2, height: 5,
 *               to_container: 1, job_instruction_id: 2592845 }]
 *
 *       TRAP: `shipment_header_id` is the working filter. `shipment_id` is
 *       SILENTLY IGNORED - it returns an unfiltered page of unrelated
 *       containers. Do not use it.
 *       `container_no` also filters and returns the same single row; it is used
 *       here only as a cross-check that the container on screen is in the list.
 *       `staging_dock_id` equals the location id from (a) - asserted, and a
 *       mismatch is warned about in the modal rather than silently accepted.
 *
 *   (d) THE WRITE (a GET, per the confirmed reference call):
 *       GET shipment/shipment-container/close-to-container
 *           &close_to_location_id=72037&container_id=1449741&profile_id=14
 *           &weight=0.84&length=6&width=2&height=5
 *
 *   DO NOT TRUST THE RESPONSE. Several Canary7 writes echo pre-write state and
 *   business rejections arrive as HTTP 500 with a numeric code. After the write
 *   this script RE-READS (c) and compares the four fields against what was
 *   submitted; success is only shown when the re-read matches. On a mismatch it
 *   prints submitted values, re-read values and the raw body, and does NOT
 *   auto-retry.
 *
 * -----------------------------------------------------------------------------
 * ASSUMED, NOT CONFIRMED (change here if the floor says otherwise)
 *   - profile_id is hard-coded 14 per the requirement. The sample URL supplied
 *     with the requirement showed 7. See PROFILE_ID below - one line to change.
 *   - The consigning route is matched on /consign/i against location.href +
 *     location.hash. The exact route was not observed live, so the first time
 *     the "Edit Weight" anchor is seen the real URL is logged (see
 *     logRouteOnce) so the guard can be tightened to an exact path later.
 *   - The consigning table's header text. Location / Container / Shipment are
 *     matched by normalised header text with aliases; column INDEX is never
 *     hard-coded. If the headers differ, the modal names the lookup that failed.
 *   - Which table on the screen is THE table. Only one was seen live. Because a
 *     second table would silently pair the right location with the wrong
 *     container, location + container are only accepted when they come from the
 *     SAME table and the SAME row; anything else is an error, never a merge.
 *     (Shipment number legitimately lives outside the table - see the <span>
 *     fallback, which is flagged low-confidence.)
 *   - Which row of that table the operator means. A row marked
 *     active/selected/highlight is preferred; falling back to the first row is
 *     recorded in `sources` and warned about in the modal.
 *   - UNITS. Nothing in the confirmed API says `weight` is kilograms, or that
 *     `length`/`width`/`height` are centimetres - the container record carries
 *     bare numbers. So the four inputs and the container option label carry NO
 *     unit at all. Add one here only once the floor or Canary7 confirms it;
 *     labelling weight "kg" on a guess is how a 0.84 becomes an 840.
 * ========================================================================== */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 0. CONSTANTS
  // ---------------------------------------------------------------------------
  const TAG          = '[Edit Dims]';
  const VERSION      = '1.1';                   // keep in step with @version
  const API_ROOT     = 'https://stgauth.canary7.com';
  const API_BASE     = API_ROOT + '/index.php?r=';
  const WAREHOUSE_ID = 10;                      // 10 = Darra (Malpa's only live WH)

  // Fixed at 14 per the requirement. The sample URL supplied with the
  // requirement showed profile_id=7 - change this one line if 7 turns out right.
  const PROFILE_ID   = 14;

  const ROUTE_LOCATION  = 'configuration/location';
  const ROUTE_SHIPMENT  = 'shipment/shipment-header';
  const ROUTE_CONTAINER = 'shipment/shipment-container';
  const ROUTE_WRITE     = 'shipment/shipment-container/close-to-container';

  const ANCHOR_TEXT = 'Edit Weight';            // C7's own button, our anchor
  const BTN_TEXT    = 'Edit Dimensions';

  // Every id/class this script owns. Unique prefix: edim.
  const ID = {
    style:    'edim-style',
    btn:      'edim-btn',
    backdrop: 'edim-backdrop',
    modal:    'edim-modal',
    ctx:      'edim-ctx',
    select:   'edim-select',
    fields:   'edim-fields',
    weight:   'edim-weight',
    length:   'edim-length',
    width:    'edim-width',
    height:   'edim-height',
    diff:     'edim-diff',
    msg:      'edim-msg',
    yes:      'edim-yes',
    no:       'edim-no',
    crash:    'edim-crash',
  };

  console.log(TAG, 'script loaded v' + VERSION);

  // ---------------------------------------------------------------------------
  // 1. AUTH  (lifted verbatim from malpa-transfer.user.js v2.6.1)
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

  // ---------------------------------------------------------------------------
  // 2. API LAYER
  // ---------------------------------------------------------------------------

  // Build a query string with encodeURIComponent on BOTH key and value.
  // '#' -> %23 is the whole reason this exists; see the header comment.
  function buildQuery(params) {
    const parts = [];
    const p = params || {};
    for (const k of Object.keys(p)) {
      const v = p[k];
      if (v === undefined || v === null || v === '') continue;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    }
    return parts.join('&');
  }

  // The route itself is NOT encoded - it is part of the ?r= value and Canary7
  // wants the slashes raw (shipment/shipment-container/close-to-container).
  function apiUrl(route, params) {
    const q = buildQuery(params);
    return API_BASE + route + (q ? '&' + q : '');
  }

  function classifyStatus(status) {
    if (status === 401 || status === 403) return 'auth';
    if (status >= 500) return 'server';
    if (status >= 400) return 'client';
    return 'ok';
  }

  // Every call goes through here so every URL and body lands in the console
  // under the [Edit Dims] prefix, and in window.__editDims.lastResponse.
  async function apiGet(route, params) {
    const url = apiUrl(route, params);
    console.log(TAG, 'GET', url);

    let res;
    try {
      res = await fetch(url, { method: 'GET', headers: mkHeaders() });
    } catch (e) {
      const err = new Error('Network error - the request never reached Canary7. ' + (e && e.message ? e.message : e));
      err.kind = 'network';
      err.url = url;
      R.lastResponse = { url, kind: 'network', error: String(e && e.message ? e.message : e) };
      console.error(TAG, 'NETWORK FAIL', url, e);
      throw err;
    }

    let raw = '';
    try { raw = await res.text(); } catch (_) { raw = ''; }

    let json = null;
    if (raw) { try { json = JSON.parse(raw); } catch (_) { json = null; } }

    const out = { url, status: res.status, ok: !!res.ok, raw, json, kind: classifyStatus(res.status) };
    R.lastResponse = out;
    console.log(TAG, 'RES', res.status, url, json !== null ? json : raw);

    if (!res.ok) {
      const code = json && (json.code || json.error_code);
      const err = new Error(
        (out.kind === 'auth' ? 'Session expired - log back into Canary7. ' : '') +
        'HTTP ' + res.status + (code ? ' (code ' + code + ')' : '') +
        ((json && (json.message || json.error)) ? ' - ' + (json.message || json.error) : '')
      );
      err.kind = out.kind;
      err.status = res.status;
      err.raw = raw;
      err.url = url;
      throw err;
    }

    return out;
  }

  // Confirmed responses are bare arrays; unwrap the usual envelopes defensively.
  function asArray(json) {
    if (!json) return [];
    if (Array.isArray(json)) return json;
    for (const k of ['data', 'items', 'rows', 'result', 'results']) {
      if (Array.isArray(json[k])) return json[k];
    }
    return [];
  }

  // ---------------------------------------------------------------------------
  // 3. STATE
  // ---------------------------------------------------------------------------
  const State = {
    scraped: null,          // { location, container, shipment, errors[] }
    locationId: null,       // (a) close_to_location_id
    shipmentHeaderId: null, // (b)
    containers: [],         // (c)
    selectedId: null,
    submitting: false,
    lastSubmitted: null,
    lastVerify: null,
    lastError: null,
    warnings: [],
    reset() {
      this.scraped = null;
      this.locationId = null;
      this.shipmentHeaderId = null;
      this.containers = [];
      this.selectedId = null;
      this.submitting = false;
      this.lastSubmitted = null;
      this.lastVerify = null;
      this.lastError = null;
      this.warnings = [];
    },
  };

  // Runtime handles - never persisted, never part of State.
  const R = {
    anchor: null,
    backdrop: null,
    modal: null,
    escHandler: null,
    lastFocus: null,
    lastResponse: null,
    lastWrite: null,
    routeLogged: false,
    watchTimer: null,
    observer: null,
  };

  // ---------------------------------------------------------------------------
  // 4. HELPERS
  // ---------------------------------------------------------------------------
  function toArr(x) {
    if (!x) return [];
    if (Array.isArray(x)) return x;
    return Array.prototype.slice.call(x);
  }

  function txt(el) {
    return el && el.textContent ? String(el.textContent).trim() : '';
  }

  function normHdr(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function fmtNum(v) {
    const n = Number(v);
    if (!isFinite(n)) return String(v === null || v === undefined ? '' : v);
    return String(n);
  }

  function doc() {
    return typeof document !== 'undefined' ? document : null;
  }

  // ---------------------------------------------------------------------------
  // 5. ROUTE + ANCHOR
  // ---------------------------------------------------------------------------

  // Guard 1 of 2. The exact consigning route was not observed live, so this is
  // deliberately loose; logRouteOnce prints the real URL so it can be tightened.
  function isConsignRoute(href, hash) {
    return /consign/i.test(String(href || '') + ' ' + String(hash || ''));
  }

  function onConsignRoute() {
    try {
      return isConsignRoute(location.href, location.hash);
    } catch (_) {
      return false;
    }
  }

  // Guard 2 of 2. NEVER match on the Angular _ngcontent-ng-cNNNNNNNNN attribute
  // - that hash changes on every Canary7 build. Match the class C7 gives the
  // button plus its text.
  function findAnchor(d) {
    d = d || doc();
    if (!d || !d.querySelectorAll) return null;
    const btns = toArr(d.querySelectorAll('button.btn-apply'));
    for (const b of btns) {
      if (txt(b) === ANCHOR_TEXT) return b;
    }
    return null;
  }

  function logRouteOnce() {
    if (R.routeLogged) return;
    R.routeLogged = true;
    try {
      console.log(TAG, 'consigning screen seen at href=' + location.href + ' hash=' + location.hash +
                       ' - tighten isConsignRoute() to this path once confirmed');
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // 6. SCRAPING THE THREE VALUES
  //    Resolved by COLUMN-HEADER TEXT, never by cell index.
  // ---------------------------------------------------------------------------
  // NOTE: 'order'/'orderno'/'ordernumber' are deliberately NOT shipment aliases.
  // On a real consigning grid an "Order No" column is the customer's own
  // reference, not the C7 shipment number, and feeding it to (b) resolves the
  // wrong shipment header - or nothing at all.
  const HEADER_ALIASES = {
    location: ['location', 'locationcode', 'locationno', 'stagingdock', 'stagingdocklocation', 'dock'],
    container: ['container', 'containerno', 'containernumber', 'containercode', 'licenceplate', 'licenseplate', 'lp'],
    shipment: ['shipment', 'shipmentno', 'shipmentnumber', 'shipmentref'],
  };

  const FIELD_LABEL = {
    location: 'Location code',
    container: 'Container number',
    shipment: 'Shipment number',
  };

  const ROW_NOTE = {
    selected: 'selected row',
    only: 'the only data row',
    first: 'the FIRST of several data rows - not marked selected',
  };

  const ROW_WARNING =
    'The row read from the table was not marked selected — verify the container before saving.';

  function headerKeyFor(headerText) {
    const n = normHdr(headerText);
    if (!n) return null;
    for (const key of Object.keys(HEADER_ALIASES)) {
      if (HEADER_ALIASES[key].indexOf(n) !== -1) return key;
    }
    return null;
  }

  // Pick the row the operator is looking at: an active/selected row if the table
  // marks one, otherwise the only data row, otherwise the first data row.
  // The CONFIDENCE is returned with the row - falling back to row 0 of several
  // is a guess about which container is on screen and is never silent.
  function pickRow(table) {
    const rows = toArr(table.querySelectorAll('tr')).filter(function (r) {
      return toArr(r.querySelectorAll('td')).length > 0;
    });
    if (!rows.length) return null;
    for (const r of rows) {
      const cls = String(r.className || '');
      if (/(^|\s)(active|selected|highlight|table-active|row-selected)(\s|$)/.test(cls)) {
        return { row: r, confidence: 'selected', rowCount: rows.length };
      }
      if (r.dataset && (r.dataset.selected === 'true' || r.dataset.active === 'true')) {
        return { row: r, confidence: 'selected', rowCount: rows.length };
      }
    }
    return { row: rows[0], confidence: rows.length === 1 ? 'only' : 'first', rowCount: rows.length };
  }

  // Read ONE table's picked row. Returns null if the table has no usable header
  // row, otherwise { index, values, sources, confidence }.
  function readTable(table, index) {
    const ths = toArr(table.querySelectorAll('th'));
    if (!ths.length) return null;

    const map = {};
    ths.forEach(function (th, i) {
      const key = headerKeyFor(txt(th));
      if (key && map[key] === undefined) map[key] = i;
    });
    if (!Object.keys(map).length) return null;

    const picked = pickRow(table);
    if (!picked || !picked.row) return null;

    const tds = toArr(picked.row.querySelectorAll('td'));
    const values = {};
    const sources = {};
    for (const key of Object.keys(map)) {
      const value = txt(tds[map[key]]);
      if (!value) continue;
      values[key] = value;
      sources[key] = 'table ' + (index + 1) + ' <th>"' + txt(ths[map[key]]) + '" col ' + map[key] +
                     ' [' + ROW_NOTE[picked.confidence] + ']';
    }
    return { index: index, values: values, sources: sources, confidence: picked.confidence };
  }

  // Location + container MUST come from the SAME table and the SAME row.
  // Taking the first non-empty value for each key across every table on the
  // screen looks like a clean read (errors 0, warnings 0) while pairing table
  // 1's location with table 2's container - which then feeds the wrong
  // container id into a production write. So: one table wins, or none does.
  function scrapeFromTables(d) {
    const out = { location: '', container: '', shipment: '', source: {}, warnings: [], errors: [] };

    const reads = [];
    toArr(d.querySelectorAll('table')).forEach(function (t, i) {
      const r = readTable(t, i);
      if (r && Object.keys(r.values).length) reads.push(r);
    });
    if (!reads.length) return out;

    const complete = reads.filter(function (r) { return r.values.location && r.values.container; });
    const partial  = reads.filter(function (r) { return !(r.values.location && r.values.container) &&
                                                        (r.values.location || r.values.container); });

    let winner = complete[0];

    if (!winner) {
      if (partial.length > 1) {
        out.errors.push(
          'Location code and Container number were found in DIFFERENT tables, so they may describe ' +
          'different containers. Refusing to combine them. Found: ' +
          partial.map(function (r) {
            return ['location', 'container'].filter(function (k) { return r.values[k]; })
              .map(function (k) { return FIELD_LABEL[k] + ' "' + r.values[k] + '" in ' + r.sources[k]; })
              .join(' and ');
          }).join('; ') +
          '. Both must come from the same row of the same table.'
        );
        return out;
      }
      // One table (or none) had anything to say - no cross-table merge is possible.
      winner = partial[0] || reads[0];
    } else if (complete.length > 1) {
      out.warnings.push('More than one table on screen has both a Location and a Container column — ' +
                        'the first was used. Check the container number before saving.');
    }

    for (const key of ['location', 'container', 'shipment']) {
      if (winner.values[key]) {
        out[key] = winner.values[key];
        out.source[key] = winner.sources[key];
      }
    }
    if (winner.confidence !== 'selected') out.warnings.push(ROW_WARNING);

    return out;
  }

  // Fallback when there is no <th>: find a label whose text names the field and
  // read the value next to it.
  // A neighbouring node whose own text is itself a column header ("Shipment
  // Number" sitting next to "Container No") is another LABEL, not this label's
  // value. Reading it would hand the API a header string.
  function labelValue(node) {
    if (!node) return '';
    const v = txt(node);
    return (v && !headerKeyFor(v)) ? v : '';
  }

  function scrapeByLabel(d, key) {
    const aliases = HEADER_ALIASES[key];
    const nodes = toArr(d.querySelectorAll('td, th, label, span, div, strong, b, dt'));
    for (const n of nodes) {
      const t = txt(n);
      if (!t || t.length > 40) continue;
      if (aliases.indexOf(normHdr(t)) === -1) continue;

      // A <th> is a COLUMN header: its value lives in the <td> below it, and
      // scrapeFromTables already owns that case. The only <th> worth reading
      // here is the row-header of a vertical detail table (<th>Location</th>
      // <td>WDD-02</td>), so a <th> may only hand us an adjacent <td> - never
      // the header beside it, and never the next row wholesale.
      const isTh = String(n.tagName || '').toUpperCase() === 'TH';
      const sib = n.nextElementSibling;
      if (isTh) {
        if (sib && String(sib.tagName || '').toUpperCase() === 'TD') {
          const tv = labelValue(sib);
          if (tv) return { value: tv, source: 'row header "' + t + '" -> adjacent <td>' };
        }
        continue;
      }

      const v = labelValue(sib);
      if (v) return { value: v, source: 'label "' + t + '" -> nextElementSibling' };
      const p = n.parentElement;
      const pv = labelValue(p && p.nextElementSibling);
      if (pv) return { value: pv, source: 'label "' + t + '" -> parent nextElementSibling' };
    }
    return null;
  }

  // Last-resort, LOW CONFIDENCE and always logged: the consigning screen renders
  // the shipment number in a bare <span class="ng-star-inserted"> which on the
  // confirmed screen carries the same text as the container number.
  function scrapeShipmentSpan(d, containerNo) {
    if (!containerNo) return null;
    const spans = toArr(d.querySelectorAll('span.ng-star-inserted'));
    for (const s of spans) {
      if (txt(s) === containerNo) {
        return { value: txt(s), source: 'span.ng-star-inserted matching the container number (low confidence)' };
      }
    }
    return null;
  }

  function scrapeConsign(d) {
    d = d || doc();
    const result = { location: '', container: '', shipment: '', errors: [], sources: {}, warnings: [] };
    if (!d || !d.querySelectorAll) {
      result.errors.push('No document to scrape.');
      return result;
    }

    const fromTables = scrapeFromTables(d);
    for (const key of ['location', 'container', 'shipment']) {
      if (fromTables[key]) {
        result[key] = fromTables[key];
        result.sources[key] = fromTables.source[key];
      }
    }
    for (const w of fromTables.warnings) {
      result.warnings.push(w);
      console.warn(TAG, w);
    }
    for (const e of fromTables.errors) {
      result.errors.push(e);
      console.error(TAG, e);
    }

    for (const key of ['location', 'container', 'shipment']) {
      if (result[key]) continue;
      const hit = scrapeByLabel(d, key);
      if (hit) {
        result[key] = hit.value;
        result.sources[key] = hit.source;
      }
    }

    if (!result.shipment) {
      const hit = scrapeShipmentSpan(d, result.container);
      if (hit) {
        result.shipment = hit.value;
        result.sources.shipment = hit.source;
        result.warnings.push('Shipment number was inferred from a <span> matching the container number - check it before saving.');
        console.warn(TAG, 'shipment number inferred from span matching container number');
      }
    }

    // Trim everything: the shipment <span> has leading and trailing whitespace.
    for (const key of ['location', 'container', 'shipment']) {
      result[key] = String(result[key] || '').trim();
    }

    for (const key of ['location', 'container', 'shipment']) {
      if (!result[key]) {
        result.errors.push(
          FIELD_LABEL[key] + ' not found on screen. Tried: <th> text matching ' +
          HEADER_ALIASES[key].join('/') + ', then a labelled-row search' +
          (key === 'shipment' ? ', then span.ng-star-inserted' : '') + '.'
        );
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // 7. LOOKUPS  (a) -> (b) -> (c)
  // ---------------------------------------------------------------------------
  async function lookupLocationId(locationCode) {
    const res = await apiGet(ROUTE_LOCATION, { location_code: locationCode, warehouse_id: WAREHOUSE_ID });
    const arr = asArray(res.json);
    if (!arr.length) {
      throw new Error('Location "' + locationCode + '" is not known in warehouse ' + WAREHOUSE_ID +
                      ' (' + ROUTE_LOCATION + ' returned an empty array). Not guessing an id.');
    }
    return arr[0].id;
  }

  async function lookupShipmentHeaderId(shipmentNumber) {
    const res = await apiGet(ROUTE_SHIPMENT, { shipment_number: shipmentNumber, warehouse_id: WAREHOUSE_ID });
    const arr = asArray(res.json);
    if (!arr.length) {
      throw new Error('Shipment "' + shipmentNumber + '" not found in warehouse ' + WAREHOUSE_ID +
                      ' (' + ROUTE_SHIPMENT + ' returned an empty array).');
    }
    return arr[0].id;
  }

  // shipment_header_id is the WORKING filter - shipment_id is silently ignored.
  async function listContainers(shipmentHeaderId) {
    const res = await apiGet(ROUTE_CONTAINER, { shipment_header_id: shipmentHeaderId });
    return asArray(res.json);
  }

  // ---------------------------------------------------------------------------
  // 8. VALUE HELPERS  (pure - covered by the offline harness)
  // ---------------------------------------------------------------------------
  // NO UNIT on the weight. The API returns a bare number and nothing confirms it
  // is kilograms - see ASSUMED, NOT CONFIRMED in the header.
  function optionLabel(c) {
    return String(c.container_no || ('container ' + c.id)) +
           ' — weight ' + fmtNum(c.weight) + ', ' +
           fmtNum(c.length) + '×' + fmtNum(c.width) + '×' + fmtNum(c.height);
  }

  const DIM_FIELDS = ['weight', 'length', 'width', 'height'];

  function validateDims(dims) {
    const errs = [];
    const LABEL = { weight: 'Weight', length: 'Length', width: 'Width', height: 'Height' };
    for (const f of DIM_FIELDS) {
      const rawv = dims ? dims[f] : undefined;
      if (rawv === undefined || rawv === null || String(rawv).trim() === '') {
        errs.push(LABEL[f] + ' is required.');
        continue;
      }
      const n = Number(rawv);
      if (!isFinite(n)) { errs.push(LABEL[f] + ' must be a number.'); continue; }
      if (!(n > 0)) { errs.push(LABEL[f] + ' must be greater than 0.'); }
    }
    return errs;
  }

  function buildWriteParams(locationId, containerId, dims) {
    return {
      close_to_location_id: locationId,
      container_id: containerId,
      profile_id: PROFILE_ID,
      weight: dims.weight,
      length: dims.length,
      width: dims.width,
      height: dims.height,
    };
  }

  // Never trust the write's own response - this compares a RE-READ container
  // against what was submitted.
  function compareDims(container, submitted) {
    const mismatches = [];
    for (const f of DIM_FIELDS) {
      const want = Number(submitted[f]);
      const got = Number(container ? container[f] : NaN);
      if (!isFinite(got) || Math.abs(got - want) > 1e-6) {
        mismatches.push({ field: f, submitted: want, actual: container ? container[f] : undefined });
      }
    }
    return { ok: mismatches.length === 0, mismatches: mismatches };
  }

  // ---------------------------------------------------------------------------
  // 9. CSS  (one <style>, all selectors edim-prefixed, nothing of C7's touched)
  // ---------------------------------------------------------------------------
  function injectCSS() {
    const d = doc();
    if (!d || d.getElementById(ID.style)) return;
    const head = d.head || d.body;
    if (!head) return;
    const st = d.createElement('style');
    st.id = ID.style;
    st.textContent = [
      '#' + ID.btn + '{margin-left:8px;}',
      '#' + ID.backdrop + '{position:fixed;inset:0;top:0;left:0;right:0;bottom:0;background:rgba(17,24,39,.45);z-index:2147483000;}',
      '#' + ID.modal + '{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:min(460px,94vw);max-height:90vh;overflow:auto;',
      'background:#fff;color:#111827;border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.28);z-index:2147483001;',
      'font-family:Inter,Roboto,Helvetica,Arial,sans-serif;padding:20px;box-sizing:border-box;}',
      '#' + ID.modal + ' *{box-sizing:border-box;}',
      '.edim-title{font-size:20px;font-weight:700;margin-bottom:4px;}',
      '.edim-sub{font-size:13px;color:#6b7280;margin-bottom:14px;}',
      '#' + ID.ctx + '{font-size:13px;color:#374151;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:10px 12px;margin-bottom:14px;line-height:1.5;}',
      '.edim-lab{display:block;font-size:12px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:#6b7280;margin-bottom:6px;}',
      '#' + ID.select + '{width:100%;height:46px;border:1px solid #d1d5db;border-radius:10px;padding:0 12px;font-size:15px;background:#fff;margin-bottom:14px;}',
      '#' + ID.fields + '{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;}',
      '.edim-inp{width:100%;height:46px;border:1px solid #d1d5db;border-radius:10px;padding:0 12px;font-size:16px;}',
      '#' + ID.diff + '{font-size:13px;line-height:1.6;background:#eff6ff;border:1px solid #bfdbfe;color:#1e3a8a;border-radius:10px;padding:10px 12px;margin-bottom:14px;}',
      '#' + ID.msg + '{font-size:13px;line-height:1.5;border-radius:10px;padding:10px 12px;margin-bottom:14px;white-space:pre-wrap;word-break:break-word;}',
      '.edim-msg-err{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;}',
      '.edim-msg-warn{background:#fffbeb;border:1px solid #fde68a;color:#92400e;}',
      '.edim-msg-ok{background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46;}',
      '.edim-msg-info{background:#f3f4f6;border:1px solid #e5e7eb;color:#374151;}',
      '.edim-foot{display:flex;gap:10px;justify-content:flex-end;}',
      '.edim-act{min-width:96px;height:44px;border-radius:10px;border:1px solid #d1d5db;background:#fff;font-size:15px;font-weight:600;cursor:pointer;}',
      '#' + ID.yes + '{background:#2563eb;border-color:#2563eb;color:#fff;}',
      '.edim-act[disabled]{opacity:.55;cursor:not-allowed;}',
      '#' + ID.crash + '{position:fixed;top:8px;left:8px;right:8px;z-index:2147483600;background:#450a0a;color:#fecaca;',
      'font:12px/1.45 monospace;padding:12px;border-radius:10px;white-space:pre-wrap;max-height:60vh;overflow:auto;}',
    ].join('\n');
    head.appendChild(st);
  }

  // ---------------------------------------------------------------------------
  // 10. TINY DOM BUILDERS  (createElement only - no innerHTML, nothing of C7's
  //     is ever reparented or restyled)
  // ---------------------------------------------------------------------------
  function mk(tag, cls, text) {
    const el = doc().createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = String(text);
    return el;
  }

  function paintCrash(err) {
    try {
      const d = doc();
      if (!d) return;
      let box = d.getElementById(ID.crash);
      if (!box) {
        box = d.createElement('div');
        box.id = ID.crash;
        (d.body || d.documentElement).appendChild(box);
      }
      box.textContent = TAG + ' v' + VERSION + ' CRASHED\n' +
        (err && err.message ? err.message : String(err)) + '\n\n' +
        (err && err.stack ? err.stack : '(no stack)');
    } catch (_) {
      console.error(TAG, 'could not paint crash', err);
    }
  }

  // ---------------------------------------------------------------------------
  // 11. MODAL
  // ---------------------------------------------------------------------------
  // Called from catch and finally blocks - it must never be the thing that
  // throws, or a handled failure turns into an unhandled rejection.
  function byId(id) {
    const d = doc();
    return (d && d.getElementById) ? d.getElementById(id) : null;
  }

  function msg(text, tone) {
    const el = byId(ID.msg);
    if (!el) return;
    el.className = 'edim-msg-' + (tone || 'info');
    el.textContent = String(text || '');
  }

  function buildModal() {
    const d = doc();

    const backdrop = d.createElement('div');
    backdrop.id = ID.backdrop;
    backdrop.addEventListener('click', function () { closeUI('backdrop'); });

    const modal = d.createElement('div');
    modal.id = ID.modal;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    modal.appendChild(mk('div', 'edim-title', BTN_TEXT));
    modal.appendChild(mk('div', 'edim-sub', 'Warehouse ' + WAREHOUSE_ID + ' · v' + VERSION));

    const ctx = d.createElement('div');
    ctx.id = ID.ctx;
    ctx.textContent = 'Reading the screen…';
    modal.appendChild(ctx);

    const selLab = mk('label', 'edim-lab', 'Container');
    selLab.setAttribute('for', ID.select);
    modal.appendChild(selLab);

    const sel = d.createElement('select');
    sel.id = ID.select;                     // single-select: no `multiple`
    sel.addEventListener('change', function () { onSelectChange(); });
    modal.appendChild(sel);

    const fields = d.createElement('div');
    fields.id = ID.fields;
    fields.style.display = 'none';          // revealed once a container is chosen
    modal.appendChild(fields);

    // Labels carry NO unit - none is confirmed. See the header block.
    const SPEC = [
      { id: ID.weight, label: 'Weight', step: '0.01' },
      { id: ID.length, label: 'Length', step: '1' },
      { id: ID.width,  label: 'Width',  step: '1' },
      { id: ID.height, label: 'Height', step: '1' },
    ];
    for (const s of SPEC) {
      const wrap = mk('div', 'edim-field');
      const lab = mk('label', 'edim-lab', s.label);
      lab.setAttribute('for', s.id);
      const inp = d.createElement('input');
      inp.id = s.id;
      inp.className = 'edim-inp';
      // type=number, step/min set. NO inputmode="none" - the operator types here.
      inp.setAttribute('type', 'number');
      inp.setAttribute('step', s.step);
      inp.setAttribute('min', '0');
      inp.addEventListener('input', function () { renderDiff(); });
      wrap.appendChild(lab);
      wrap.appendChild(inp);
      fields.appendChild(wrap);
    }

    const diff = d.createElement('div');
    diff.id = ID.diff;
    diff.style.display = 'none';
    modal.appendChild(diff);

    const m = d.createElement('div');
    m.id = ID.msg;
    m.className = 'edim-msg-info';
    m.textContent = 'Loading container list…';
    modal.appendChild(m);

    const foot = mk('div', 'edim-foot');
    const no = mk('button', 'edim-act', 'No');
    no.id = ID.no;
    no.setAttribute('type', 'button');
    no.addEventListener('click', function () { closeUI('no'); });
    const yes = mk('button', 'edim-act', 'Yes');
    yes.id = ID.yes;
    yes.setAttribute('type', 'button');
    yes.addEventListener('click', function () { submit(); });
    foot.appendChild(no);
    foot.appendChild(yes);
    modal.appendChild(foot);

    (d.body || d.documentElement).appendChild(backdrop);
    (d.body || d.documentElement).appendChild(modal);

    R.backdrop = backdrop;
    R.modal = modal;

    // Focus the select on open; closeUI() hands focus back to the button.
    try { sel.focus(); } catch (_) {}

    R.escHandler = function (e) {
      if (e && (e.key === 'Escape' || e.key === 'Esc' || e.keyCode === 27)) {
        if (e.stopPropagation) e.stopPropagation();
        if (e.preventDefault) e.preventDefault();
        closeUI('esc');
      }
    };
    // Capture phase: Angular swallows plenty of key events on its own screens.
    d.addEventListener('keydown', R.escHandler, true);

    setBusy(true);
    return modal;
  }

  // setBusy governs YES only. "No" means cancel, and cancelling has to stay
  // available while the three lookups run - an operator who opened the modal by
  // mistake should not be held there by a slow location lookup. The one moment
  // No is disabled is a write actually in flight (see submit()), and closeUI()
  // refuses mid-write anyway.
  function setBusy(busy) {
    const yes = byId(ID.yes);
    if (yes) { if (busy) yes.setAttribute('disabled', 'disabled'); else yes.removeAttribute('disabled'); }
  }

  function setCancelEnabled(enabled) {
    const no = byId(ID.no);
    if (!no) return;
    if (enabled) no.removeAttribute('disabled'); else no.setAttribute('disabled', 'disabled');
  }

  function closeUI(reason) {
    // A submit in flight must not be orphaned by an accidental Esc.
    if (State.submitting) {
      msg('Submitting — wait for the result.', 'warn');
      return false;
    }
    const d = doc();
    try {
      if (R.escHandler && d) d.removeEventListener('keydown', R.escHandler, true);
    } catch (_) {}
    R.escHandler = null;
    if (R.modal && R.modal.remove) R.modal.remove();
    if (R.backdrop && R.backdrop.remove) R.backdrop.remove();
    R.modal = null;
    R.backdrop = null;
    console.log(TAG, 'closed (' + (reason || 'unknown') + ') - no request fired');
    // Focus back to the button that opened us.
    try {
      const btn = R.lastFocus || (d && d.getElementById(ID.btn));
      if (btn && btn.focus) btn.focus();
    } catch (_) {}
    R.lastFocus = null;
    return true;
  }

  function currentContainer() {
    const id = State.selectedId;
    if (id === null || id === undefined) return null;
    for (const c of State.containers) {
      if (String(c.id) === String(id)) return c;
    }
    return null;
  }

  function readInputs() {
    const d = doc();
    const out = {};
    const map = { weight: ID.weight, length: ID.length, width: ID.width, height: ID.height };
    for (const f of DIM_FIELDS) {
      const el = d.getElementById(map[f]);
      out[f] = el ? el.value : '';
    }
    return out;
  }

  function fillInputs(c) {
    const d = doc();
    const map = { weight: ID.weight, length: ID.length, width: ID.width, height: ID.height };
    for (const f of DIM_FIELDS) {
      const el = d.getElementById(map[f]);
      if (el) el.value = (c && c[f] !== undefined && c[f] !== null) ? String(c[f]) : '';
    }
  }

  function renderDiff() {
    const d = doc();
    const el = d.getElementById(ID.diff);
    const c = currentContainer();
    if (!el) return;
    if (!c) { el.style.display = 'none'; return; }
    const now = readInputs();
    const lines = ['Container ' + (c.container_no || c.id)];
    for (const f of DIM_FIELDS) {
      const before = fmtNum(c[f]);
      const after = String(now[f]);
      lines.push('  ' + f + ': ' + before + (String(before) === after ? ' (unchanged)' : ' → ' + after));
    }
    el.style.display = '';
    el.textContent = lines.join('\n');
  }

  function onSelectChange() {
    const d = doc();
    const sel = d.getElementById(ID.select);
    const fields = d.getElementById(ID.fields);
    if (!sel) return;
    State.selectedId = sel.value === '' ? null : sel.value;
    const c = currentContainer();
    if (!c) {
      if (fields) fields.style.display = 'none';
      const diff = d.getElementById(ID.diff);
      if (diff) diff.style.display = 'none';
      setBusy(true);
      msg('Pick a container.', 'info');
      return;
    }
    if (fields) fields.style.display = '';
    fillInputs(c);
    renderDiff();
    setBusy(false);

    // staging_dock_id on the container must equal the location id from (a).
    if (State.locationId !== null && c.staging_dock_id !== undefined &&
        String(c.staging_dock_id) !== String(State.locationId)) {
      msg('Warning: this container’s staging_dock_id (' + c.staging_dock_id +
          ') does not match the location on screen (' + State.locationId +
          '). Check you are on the right container before saving.', 'warn');
    } else if (State.warnings.length) {
      msg(State.warnings.join('\n'), 'warn');
    } else {
      msg('Check the values, then press Yes to write them to Canary7.', 'info');
    }
  }

  function renderContext() {
    const d = doc();
    const el = d.getElementById(ID.ctx);
    if (!el) return;
    const s = State.scraped || {};
    el.textContent = [
      'Location: ' + (s.location || '?') + (State.locationId ? ' (id ' + State.locationId + ')' : ''),
      'Shipment: ' + (s.shipment || '?') + (State.shipmentHeaderId ? ' (id ' + State.shipmentHeaderId + ')' : ''),
      'Container on screen: ' + (s.container || '?'),
    ].join('\n');
  }

  function renderContainers() {
    const d = doc();
    const sel = d.getElementById(ID.select);
    if (!sel) return;
    while (sel.firstChild) sel.removeChild(sel.firstChild);

    const ph = d.createElement('option');
    ph.value = '';
    ph.textContent = 'Select a container…';
    sel.appendChild(ph);

    for (const c of State.containers) {
      const o = d.createElement('option');
      o.value = String(c.id);
      o.textContent = optionLabel(c);
      sel.appendChild(o);
    }

    // Preselect the container whose container_no matches the screen.
    const wanted = (State.scraped && State.scraped.container) || '';
    let match = null;
    for (const c of State.containers) {
      if (String(c.container_no || '').trim() === wanted) { match = c; break; }
    }
    if (match) {
      sel.value = String(match.id);
      State.selectedId = String(match.id);
    } else if (State.containers.length === 1) {
      sel.value = String(State.containers[0].id);
      State.selectedId = String(State.containers[0].id);
      State.warnings.push('The container on screen (' + wanted + ') was not in the list for this shipment - the only container on the shipment has been preselected.');
    } else {
      sel.value = '';
      State.selectedId = null;
      if (wanted) {
        State.warnings.push('The container on screen (' + wanted + ') was not in the list for this shipment - pick one manually.');
      }
    }
    onSelectChange();
  }

  // ---------------------------------------------------------------------------
  // 12. OPEN
  // ---------------------------------------------------------------------------
  function open() {
    try {
      const d = doc();
      if (d.getElementById(ID.modal)) return;   // already open
      State.reset();
      injectCSS();
      R.lastFocus = d.getElementById(ID.btn);
      buildModal();

      const scraped = scrapeConsign(d);
      State.scraped = scraped;
      State.warnings = scraped.warnings.slice();
      renderContext();
      console.log(TAG, 'scraped', scraped);

      if (scraped.errors.length) {
        setBusy(true);                            // No stays enabled - see setBusy
        msg('Could not read the screen:\n\n' + scraped.errors.join('\n\n'), 'err');
        return;
      }

      loadContext(scraped).catch(function (e) {
        console.error(TAG, 'load failed', e);
        State.lastError = e;
        setBusy(true);
        msg(describeError(e), 'err');
      });
    } catch (err) {
      console.error(TAG, 'open() crashed', err);
      paintCrash(err);
    }
  }

  function describeError(e) {
    const bits = [];
    bits.push(e && e.message ? e.message : String(e));
    if (e && e.kind) bits.push('Failure type: ' + e.kind);
    if (e && e.url) bits.push('URL: ' + e.url);
    if (e && e.raw) bits.push('Raw response:\n' + String(e.raw).slice(0, 1200));
    if (e && e.stack) bits.push('Stack:\n' + e.stack);
    return bits.join('\n\n');
  }

  async function loadContext(scraped) {
    msg('Resolving location “' + scraped.location + '”…', 'info');
    State.locationId = await lookupLocationId(scraped.location);
    renderContext();

    msg('Resolving shipment “' + scraped.shipment + '”…', 'info');
    State.shipmentHeaderId = await lookupShipmentHeaderId(scraped.shipment);
    renderContext();

    msg('Loading containers…', 'info');
    State.containers = await listContainers(State.shipmentHeaderId);
    if (!State.containers.length) {
      throw new Error('No containers returned for shipment_header_id ' + State.shipmentHeaderId + '.');
    }
    renderContainers();
  }

  // ---------------------------------------------------------------------------
  // 13. SUBMIT  (production write - re-read and verify, never trust the echo)
  // ---------------------------------------------------------------------------
  async function submit() {
    if (State.submitting) return;               // double-submit guard

    // EVERYTHING below lives inside the try. submit() is async, so a throw out
    // here - a DOM the app tore down under us, a missing input - would be an
    // unhandled rejection: no message in the modal, no crash box, and a Yes
    // button left disabled forever.
    let started = false;                        // did we get as far as the write?
    let numeric = null;

    try {
      const c = currentContainer();
      if (!c) { msg('Pick a container first.', 'err'); return; }

      const dims = readInputs();
      const errs = validateDims(dims);
      if (errs.length) { msg(errs.join('\n'), 'err'); return; }

      numeric = {};
      for (const f of DIM_FIELDS) numeric[f] = Number(dims[f]);

      State.submitting = true;
      started = true;
      State.lastSubmitted = { containerId: c.id, containerNo: c.container_no, dims: numeric };
      setBusy(true);
      setCancelEnabled(false);                  // the one moment No is disabled
      msg('Writing to Canary7… do not close this window.', 'info');

      const params = buildWriteParams(State.locationId, c.id, numeric);
      const wrote = await apiGet(ROUTE_WRITE, params);
      R.lastWrite = wrote;

      // DO NOT TRUST THE RESPONSE - re-read and compare.
      msg('Written. Re-reading to verify…', 'info');
      const after = await listContainers(State.shipmentHeaderId);
      State.containers = after;
      let fresh = null;
      for (const x of after) { if (String(x.id) === String(c.id)) { fresh = x; break; } }

      const cmp = compareDims(fresh, numeric);
      State.lastVerify = { fresh: fresh, cmp: cmp };

      if (!fresh) {
        msg('VERIFY FAILED - container ' + c.id + ' was not in the re-read of ' + ROUTE_CONTAINER +
            '.\n\nSubmitted: ' + JSON.stringify(numeric) +
            '\n\nRaw write response:\n' + String(wrote.raw).slice(0, 1200) +
            '\n\nNot retrying. Check the container in Canary7 before doing anything else.', 'err');
      } else if (cmp.ok) {
        // Bare numbers, no unit - see ASSUMED, NOT CONFIRMED in the header.
        msg('Saved and verified.\n\n' + (fresh.container_no || fresh.id) + ' is now weight ' +
            fmtNum(fresh.weight) + ', ' + fmtNum(fresh.length) + '×' +
            fmtNum(fresh.width) + '×' + fmtNum(fresh.height) + '.', 'ok');
        fillInputs(fresh);
        renderDiff();
      } else {
        msg('VERIFY FAILED - Canary7 did not store what was submitted.\n\n' +
            cmp.mismatches.map(function (m) {
              return '  ' + m.field + ': submitted ' + m.submitted + ', re-read ' + m.actual;
            }).join('\n') +
            '\n\nRaw write response:\n' + String(wrote.raw).slice(0, 1200) +
            '\n\nNot retrying automatically.', 'err');
      }
    } catch (e) {
      console.error(TAG, started ? 'write failed' : 'submit() crashed before the write', e);
      State.lastError = e;
      if (!started) paintCrash(e);              // it never reached Canary7 - show the stack
      msg((started ? 'WRITE FAILED' : 'SUBMIT FAILED - nothing was sent to Canary7') + '\n\n' +
          describeError(e) +
          (numeric ? '\n\nSubmitted: ' + JSON.stringify(numeric) : '') +
          '\n\nNot retrying automatically - re-check the container in Canary7.', 'err');
    } finally {
      if (started) {
        State.submitting = false;
        setCancelEnabled(true);
        setBusy(false);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 14. INJECTION  (sibling of C7's own button - nothing of C7's is moved)
  // ---------------------------------------------------------------------------
  function tryInject() {
    const d = doc();
    if (!d) return false;
    if (!onConsignRoute()) return false;

    if (d.getElementById(ID.btn)) return false;             // idempotent

    const anchor = findAnchor(d);
    if (!anchor) return false;

    // Idempotency is decided by what is ACTUALLY in the DOM, never by a sticky
    // flag on C7's node. A `dataset.edimDone` marker wedges the button gone for
    // good: Angular re-renders the button row, our button goes with it, the
    // anchor node survives carrying the flag, and every later tryInject() bails
    // on a button that no longer exists.
    if (anchor.nextElementSibling && anchor.nextElementSibling.id === ID.btn) return false;

    logRouteOnce();
    injectCSS();

    const btn = d.createElement('button');
    btn.id = ID.btn;
    btn.setAttribute('type', 'button');
    // Same C7 classes so it matches the house look, plus our own for margin.
    btn.className = 'btn btn-primary btn-apply edim-btn';
    btn.textContent = BTN_TEXT;
    btn.addEventListener('click', function (e) {
      if (e && e.preventDefault) e.preventDefault();
      if (e && e.stopPropagation) e.stopPropagation();
      open();
    });

    anchor.insertAdjacentElement('afterend', btn);
    R.anchor = anchor;
    console.log(TAG, 'button injected next to "' + ANCHOR_TEXT + '"');
    return true;
  }

  // Angular routes away without unmounting our button - take it down ourselves.
  function removeButton() {
    const d = doc();
    if (!d) return false;
    const btn = d.getElementById(ID.btn);
    R.anchor = null;
    if (!btn) return false;
    btn.remove();
    console.log(TAG, 'button removed - left the consigning screen');
    return true;
  }

  function watch() {
    try {
      if (!onConsignRoute()) {
        if (doc() && doc().getElementById(ID.btn)) {
          removeButton();
          if (R.modal) closeUI('route-change');
        }
        return;
      }
      tryInject();
    } catch (err) {
      console.error(TAG, 'watch() failed', err);
    }
  }

  // ---------------------------------------------------------------------------
  // 15. DEBUG HANDLE
  // ---------------------------------------------------------------------------
  window.__editDims = {
    VERSION,
    State,
    get state() { return State; },
    get runtime() { return R; },
    get lastResponse() { return R.lastResponse; },
    get lastWrite() { return R.lastWrite; },
    open, close: closeUI, submit,
    tryInject, removeButton, watch, findAnchor, isConsignRoute,
    scrapeConsign, scrapeFromTables, scrapeByLabel, headerKeyFor, pickRow,
    apiUrl, buildQuery, apiGet, asArray, classifyStatus,
    lookupLocationId, lookupShipmentHeaderId, listContainers,
    optionLabel, validateDims, buildWriteParams, compareDims,
    readInputs, fillInputs, renderContainers, onSelectChange,
    getToken, mkHeaders,
    apiBase: () => API_BASE,
    warehouseId: () => String(WAREHOUSE_ID),
    hasToken: () => !!getToken(),
    CONFIG: {
      profileId: PROFILE_ID,
      routes: {
        location: ROUTE_LOCATION,
        shipment: ROUTE_SHIPMENT,
        container: ROUTE_CONTAINER,
        write: ROUTE_WRITE,
      },
      ids: ID,
    },
  };

  // ---------------------------------------------------------------------------
  // 16. BOOT  (tryInject retry + MutationObserver, house pattern)
  // ---------------------------------------------------------------------------
  let _attempts = 0;
  function boot() {
    watch();
    if (doc() && doc().getElementById(ID.btn)) return;
    if (++_attempts < 80) setTimeout(boot, 500);
  }

  // The observer fires on every mutation Angular makes - hundreds per render on
  // a busy consigning grid - and watch() does a full querySelectorAll. Coalesce
  // a burst of mutations into ONE watch() on the next frame.
  let _watchQueued = false;
  function queueWatch() {
    if (_watchQueued) return;
    _watchQueued = true;
    const run = function () { _watchQueued = false; watch(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else if (typeof setTimeout === 'function') setTimeout(run, 16);
    else run();
  }

  if (typeof MutationObserver === 'function' && doc() && doc().body) {
    R.observer = new MutationObserver(queueWatch);
    R.observer.observe(doc().body, { childList: true, subtree: true });
  }

  // Angular can change route without touching <body>'s subtree in a way the
  // observer sees, so a slow heartbeat also removes the button when we leave.
  if (typeof setInterval === 'function') {
    R.watchTimer = setInterval(watch, 1500);
  }

  boot();
})();

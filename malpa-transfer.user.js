// ==UserScript==
// @name         Malpa Transfer (Canary7 TC51)
// @namespace    https://malpa3pl.com.au/
// @version      1.1.0
// @description  Fast location-to-location stock transfer for Canary7 on the Zebra TC51. Scan FROM, tick the SKUs, scan TO, transfer. Replaces the native Inventory Adjustment > Transfer tab.
// @author       Malpa 3PL
// @homepageURL  https://github.com/zaynnev/malpa3pl
// @supportURL   https://github.com/zaynnev/malpa3pl/issues
// @updateURL    https://raw.githubusercontent.com/zaynnev/malpa3pl/main/malpa-transfer.user.js
// @downloadURL  https://raw.githubusercontent.com/zaynnev/malpa3pl/main/malpa-transfer.user.js
// @match        *://*.canary7.com/*
// @match        *://canary7.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      stgauth.canary7.com
// @connect      malpa.canary7.com
// @connect      *
// @run-at       document-idle
// @noframes     false
// ==/UserScript==

/* ---------------------------------------------------------------------------
 * CONFIRMED API BEHAVIOUR (probed live against company MA-TRL, 31 Jul 2026)
 * ---------------------------------------------------------------------------
 * Transfer is a single call:
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
 * Verified facts (each learned by probing, not assumed):
 *  1. QUANTITY UNITS. `on_hand_quantity` on an inventory record is in BASE units,
 *     but the `quantity` you POST is in the record's OWN UOM. Sending quantity:1
 *     against a Carton record (factor 6) moved SIX base units. So:
 *         quantity = baseQtyTheUserTyped / itemUnitOfMeasure.factor
 *     and it must divide evenly. This script enforces that.
 *  2. THE RESPONSE LIES. The 200 body echoes the source record as it was BEFORE
 *     the move (stale on_hand_quantity and updated_at). Never verify from the
 *     response - re-read the location. This script re-reads after every batch.
 *  3. BATCHES. Passing batch_no moves exactly that batch and creates/updates a
 *     record at the destination carrying the same batch_id. Other batches of the
 *     same item in the same bin are untouched. Batch is required for batch items.
 *  4. DESTINATION. If a matching record (item + location + uom + batch + status)
 *     exists at the destination it is incremented; otherwise a new record is
 *     created. Draining a source record to 0 deletes it. Both are native behaviour.
 *  5. LICENCE PLATES - IMPORTANT LIMITATION. The adjust body has no LP field.
 *     Where one bin holds the same item/uom/batch/status under several licence
 *     plates, the API takes from the OLDEST matching record and the destination
 *     record carries no LP. Those rows therefore cannot be addressed individually,
 *     so this script MERGES them into one row and warns. Confirmed: WDD-02 held
 *     WBT-001 Each under LP o7282 (older) and or7; the transfer took from o7282.
 * ------------------------------------------------------------------------- */

(function () {
    'use strict';

    /* ===================== CONFIG ===================== */
    const CONFIG = {
        // The Canary7 API host. The app UI (malpa.canary7.com) calls stgauth.canary7.com,
        // so this is normally cross-origin. The sniffer below learns the real base from
        // the app's own traffic; this is only the fallback if it hasn't seen a call yet.
        apiBaseFallback: 'https://stgauth.canary7.com',
        warehouseIdFallback: '10',        // 10 = Darra, 9 = Carole Park
        transferAdjustmentTypeId: '7',    // 7 = Transfer
        reasonCode: '',
        comment: 'Malpa Transfer (TC51)',
        maxRows: 300,                     // per-page when reading a location
        hijackNativeTransferTab: true,    // intercept the native "Transfer" tab
        soundEnabled: true,
        // Prefill the qty box with on-hand. Allocated stock is flagged but not blocked.
        warnOnAllocated: true
    };

    if (window.__malpaTransferLoaded) return;
    window.__malpaTransferLoaded = true;

    /* ===================== CREDENTIAL / BASE-URL SNIFFER =====================
     * Rather than guess where the token lives or which host to call, watch the
     * app's own requests and copy what it uses. Falls back to storage scanning.
     * ======================================================================== */
    const Sniff = { token: null, base: null, warehouseId: null };

    function tokenFromStorage() {
        const keys = ['access_token', 'token', 'id_token', 'auth_token', 'jwt'];
        for (const store of [localStorage, sessionStorage]) {
            try {
                for (const k of keys) {
                    const v = store.getItem(k);
                    if (v && v.length > 20) return v.replace(/^Bearer\s+/i, '').replace(/^"|"$/g, '');
                }
                // Nothing under the usual names - look for anything JWT-shaped.
                for (let i = 0; i < store.length; i++) {
                    const v = store.getItem(store.key(i));
                    if (v && /^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\./.test(v)) return v;
                }
            } catch (_) { /* storage can throw in odd contexts */ }
        }
        return null;
    }

    function installSniffer() {
        // XHR
        const oOpen = XMLHttpRequest.prototype.open;
        const oSet = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.open = function (m, url) {
            try {
                if (typeof url === 'string' && /canary7\.com/.test(url)) {
                    Sniff.base = new URL(url, location.href).origin;
                }
            } catch (_) {}
            return oOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
            try {
                const n = String(name).toLowerCase();
                if (n === 'authorization' && value) Sniff.token = String(value).replace(/^Bearer\s+/i, '');
                if (n === 'x-warehouse-id' && value) Sniff.warehouseId = String(value);
            } catch (_) {}
            return oSet.apply(this, arguments);
        };
        // fetch
        const oFetch = window.fetch;
        if (oFetch) {
            window.fetch = function (input, init) {
                try {
                    const url = typeof input === 'string' ? input : (input && input.url);
                    if (url && /canary7\.com/.test(url)) Sniff.base = new URL(url, location.href).origin;
                    const h = (init && init.headers) || (input && input.headers);
                    if (h) {
                        const get = (k) => (typeof h.get === 'function' ? h.get(k) : h[k] || h[k.toLowerCase()]);
                        const a = get('Authorization'); if (a) Sniff.token = String(a).replace(/^Bearer\s+/i, '');
                        const w = get('x-warehouse-id'); if (w) Sniff.warehouseId = String(w);
                    }
                } catch (_) {}
                return oFetch.apply(this, arguments);
            };
        }
    }
    installSniffer();

    const apiBase = () => Sniff.base || CONFIG.apiBaseFallback;
    const warehouseId = () => Sniff.warehouseId || CONFIG.warehouseIdFallback;
    const authToken = () => Sniff.token || tokenFromStorage();

    /* ===================== HTTP ===================== */
    function buildUrl(service, path, query) {
        const base = apiBase();
        let url;
        if (service === 'legacy') {
            url = new URL(base + '/index.php');
            url.searchParams.set('r', path);
        } else if (service === 'inbound') {
            url = new URL(base + '/inbound/api/wms/v1/' + path);
        } else {
            url = new URL(base + '/' + path.replace(/^\//, ''));
        }
        Object.entries(query || {}).forEach(([k, v]) => {
            if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
        });
        return url.toString();
    }

    function headers() {
        const t = authToken();
        if (!t) throw new Error('No Canary7 session token found - open the app, log in, then reopen Malpa Transfer.');
        return {
            'Authorization': 'Bearer ' + t,
            'x-warehouse-id': warehouseId(),
            'x-reference-id': String(Math.floor(Math.random() * 1e9)),
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };
    }

    // GM_xmlhttpRequest fallback, used if fetch is blocked by CORS.
    function gmRequest(method, url, hdrs, bodyText) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') return reject(new Error('CORS blocked and GM_xmlhttpRequest unavailable'));
            GM_xmlhttpRequest({
                method, url, headers: hdrs, data: bodyText,
                onload: (r) => resolve({ status: r.status, text: r.responseText }),
                onerror: () => reject(new Error('Network error (GM)')),
                ontimeout: () => reject(new Error('Timeout (GM)')),
                timeout: 60000
            });
        });
    }

    async function api(service, path, { method = 'GET', query, body } = {}) {
        const url = buildUrl(service, path, query);
        const h = headers();
        const bodyText = body === undefined ? undefined : JSON.stringify(body);
        let status, text;
        try {
            const res = await fetch(url, { method, headers: h, body: bodyText, credentials: 'omit', mode: 'cors' });
            status = res.status;
            text = await res.text();
        } catch (e) {
            const r = await gmRequest(method, url, h, bodyText);
            status = r.status; text = r.text;
        }
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = text; }
        if (status === 401) throw new Error('401 session expired - log back into Canary7.');
        if (status < 200 || status >= 300) {
            const msg = (parsed && (parsed.message || parsed.error ||
                (Array.isArray(parsed) && parsed[0] && parsed[0].message))) || ('HTTP ' + status);
            throw new Error(msg);
        }
        return parsed;
    }

    /* ===================== SOUND ===================== */
    const Sound = (() => {
        let ctx = null;
        const ensure = () => {
            if (!CONFIG.soundEnabled) return null;
            try {
                if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
                if (ctx.state === 'suspended') ctx.resume();
                return ctx;
            } catch (_) { return null; }
        };
        function tone(freq, startAt, dur, type, vol) {
            const c = ensure(); if (!c) return;
            const osc = c.createOscillator(), g = c.createGain();
            osc.type = type || 'square';
            osc.frequency.value = freq;
            g.gain.value = vol == null ? 0.16 : vol;
            osc.connect(g); g.connect(c.destination);
            const t0 = c.currentTime + startAt;
            osc.start(t0); osc.stop(t0 + dur);
        }
        return {
            unlock: ensure,
            // Two rising blips - clearly "done".
            success() { tone(1180, 0, 0.09, 'square'); tone(1760, 0.11, 0.13, 'square'); },
            // Low, long, unpleasant - clearly "stop".
            error() { tone(300, 0, 0.28, 'sawtooth', 0.22); tone(190, 0.3, 0.36, 'sawtooth', 0.22); },
            // Short neutral tick - "read it, nothing moved".
            warn() { tone(660, 0, 0.13, 'triangle', 0.18); },
            scan() { tone(1500, 0, 0.05, 'square', 0.1); }
        };
    })();

    /* ===================== LOGGER ===================== */
    const Log = (() => {
        let el = null;
        const setEl = (e) => { el = e; };
        function line(kind, msg) {
            const ts = new Date().toLocaleTimeString('en-AU', { hour12: false });
            const row = document.createElement('div');
            row.className = 'mt-log-row mt-' + kind;
            row.textContent = '[' + ts + '] ' + msg;
            if (el) { el.appendChild(row); el.scrollTop = el.scrollHeight; }
            const tag = '[MalpaTransfer]';
            if (kind === 'err') console.error(tag, msg);
            else if (kind === 'warn') console.warn(tag, msg);
            else console.log(tag, msg);
        }
        return {
            setEl,
            info: (m) => line('info', m),
            ok: (m) => line('ok', '✓ ' + m),
            err: (m) => line('err', '✗ ' + m),
            warn: (m) => line('warn', '! ' + m),
            step: (m) => line('step', '→ ' + m),
            rule: () => line('rule', '─'.repeat(34)),
            clear: () => { if (el) el.innerHTML = ''; },
            text: () => (el ? el.innerText : '')
        };
    })();

    /* ===================== STATE ===================== */
    const State = {
        from: null,       // { id, location_code, ... }
        to: null,
        rows: [],         // grouped, transferable rows
        busy: false
    };

    /* ===================== DATA ===================== */
    async function resolveLocation(code) {
        const clean = String(code || '').trim().toUpperCase();
        if (!clean) throw new Error('No location entered');
        const list = await api('inbound', 'location', {
            query: { location_code: clean, 'per-page': 5 }
        });
        const arr = Array.isArray(list) ? list : [];
        // The endpoint filters loosely, so insist on an exact code match.
        let hit = arr.find((l) => String(l.location_code).toUpperCase() === clean);
        if (!hit) throw new Error('Location "' + clean + '" not found');
        if (String(hit.warehouse_id) !== String(warehouseId())) {
            throw new Error('Location "' + clean + '" is in warehouse ' + hit.warehouse_id + ', not ' + warehouseId());
        }
        if (hit.status !== 1) Log.warn('Location ' + clean + ' is INACTIVE (status ' + hit.status + ')');
        return hit;
    }

    async function readLocationStock(locationCode) {
        const raw = await api('legacy', 'inventory/inventory', {
            query: {
                location_code: locationCode,
                expand: 'item,batch,itemUnitOfMeasure.unitOfMeasure',
                'per-page': CONFIG.maxRows,
                page: 1
            }
        });
        return Array.isArray(raw) ? raw : [];
    }

    /* Group records that the transfer API cannot tell apart.
     * The adjust call identifies stock by item + location + uom + batch + status,
     * so records differing only by licence plate collapse into one row. */
    function groupRows(records, fromLocationId) {
        const map = new Map();
        for (const r of records) {
            if (String(r.location_id) !== String(fromLocationId)) continue;   // guard against loose filtering
            const onHand = Number(r.on_hand_quantity) || 0;
            if (onHand <= 0) continue;
            const iuom = r.itemUnitOfMeasure || {};
            const uomName = (iuom.unitOfMeasure && iuom.unitOfMeasure.name) || 'Each';
            const factor = Number(iuom.factor) || 1;
            const batchNo = (r.batch && r.batch.batch_number) || null;
            const key = [r.item_id, r.item_unit_of_measure_id, batchNo || '-', r.inventory_status || 'available'].join('|');
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
                    status: r.inventory_status || 'available',
                    onHand: 0,
                    allocated: 0,
                    suspended: 0,
                    lps: [],
                    recordIds: [],
                    checked: false,
                    qty: 0
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
        rows.sort((a, b) => a.itemCode.localeCompare(b.itemCode) || String(a.batchNo).localeCompare(String(b.batchNo)));
        return rows;
    }

    /* Stock that is allocated (or suspended mid-transaction) cannot be transferred -
     * Canary7 rejects the move. So the cap is on-hand minus those, not on-hand. */
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

    /* The exact request body confirmed by live probing. Kept separate so it can be
     * unit-tested and inspected from the console. */
    function buildTransferBody(g, fromId, toId) {
        const body = {
            adjustment_type_id: CONFIG.transferAdjustmentTypeId,
            item_id: g.itemId,
            item_unit_of_measure_id: g.iuomId,
            item_unit_of_measure_to_id: g.iuomId,
            location_from_id: fromId,
            location_to_id: toId,
            quantity: g.qty / g.factor,          // API wants the record's own UOM
            inventory_status: g.status,
            reason_code: CONFIG.reasonCode,
            comment: CONFIG.comment
        };
        if (g.batchNo) body.batch_no = g.batchNo;
        return body;
    }

    async function doTransfer() {
        if (State.busy) return;
        if (!State.from) { Log.err('Scan a FROM location first'); Sound.error(); return; }
        if (!State.to) { Log.err('Scan a TO location first'); Sound.error(); return; }
        if (String(State.from.id) === String(State.to.id)) {
            Log.err('FROM and TO are the same location - nothing to do'); Sound.error(); return;
        }
        const picked = State.rows.filter((r) => r.checked);
        if (!picked.length) { Log.warn('NOTHING MOVED - no lines ticked'); Sound.warn(); return; }

        const bad = picked.map((r) => ({ r, err: validateRow(r) })).filter((x) => x.err);
        if (bad.length) {
            bad.forEach((x) => Log.err(x.r.itemCode + ': ' + x.err));
            Log.warn('NOTHING MOVED - fix the lines above');
            Sound.error();
            return;
        }

        State.busy = true;
        setBusy(true);
        Log.rule();
        Log.step('TRANSFER ' + State.from.location_code + ' → ' + State.to.location_code +
                 '  (' + picked.length + ' line' + (picked.length === 1 ? '' : 's') + ')');

        let okCount = 0, failCount = 0;
        for (const g of picked) {
            const sendQty = g.qty / g.factor;   // API expects the record's own UOM
            const label = g.itemCode + (g.batchNo ? ' [' + g.batchNo + ']' : '') +
                          ' ×' + g.qty + (g.factor > 1 ? ' (' + sendQty + ' ' + g.uomName + ')' : '');
            if (CONFIG.warnOnAllocated && g.allocated > 0) {
                Log.warn(g.itemCode + ' has ' + g.allocated + ' allocated - moving it may break picks');
            }
            if (g.lps.length > 1) {
                Log.warn(g.itemCode + ' spans licence plates ' + g.lps.join(', ') +
                         ' - Canary7 takes from the oldest and the destination gets no LP');
            }
            const body = buildTransferBody(g, State.from.id, State.to.id);

            try {
                await api('legacy', 'inventory/inventory/adjust', { method: 'POST', body });
                okCount++;
                Log.ok(label + ' moved');
            } catch (e) {
                failCount++;
                Log.err(label + ' FAILED - ' + (e && e.message ? e.message : e));
            }
        }

        // The adjust response echoes pre-move data, so confirm against a fresh read.
        Log.step('Verifying against a fresh read...');
        try {
            const after = await readLocationStock(State.to.location_code);
            const rows = groupRows(after, State.to.id);
            for (const g of picked) {
                const m = rows.find((x) => x.itemId === g.itemId && x.iuomId === g.iuomId &&
                                           (x.batchNo || null) === (g.batchNo || null) && x.status === g.status);
                if (m) Log.info('  ' + State.to.location_code + ' now holds ' + m.onHand + ' × ' + g.itemCode +
                                (g.batchNo ? ' [' + g.batchNo + ']' : ''));
                else Log.warn('  ' + g.itemCode + ' not visible at ' + State.to.location_code + ' yet');
            }
        } catch (e) {
            Log.warn('Could not verify destination: ' + (e && e.message ? e.message : e));
        }

        Log.rule();
        if (failCount === 0) {
            Log.ok('DONE - ' + okCount + ' line' + (okCount === 1 ? '' : 's') + ' transferred, 0 failed');
            Sound.success();
        } else if (okCount === 0) {
            Log.err('FAILED - nothing was transferred (' + failCount + ' error' + (failCount === 1 ? '' : 's') + ')');
            Sound.error();
        } else {
            Log.warn('PARTIAL - ' + okCount + ' moved, ' + failCount + ' failed. Check the lines above.');
            Sound.error();
        }

        State.busy = false;
        setBusy(false);
        await loadFrom(State.from.location_code, { quiet: true });   // refresh to reality
    }

    /* ===================== UI ===================== */
    const CSS = `
    #mt-launch{position:fixed;right:10px;bottom:10px;z-index:2147483000;background:#0b6ea8;color:#fff;
      border:none;border-radius:26px;padding:14px 18px;font:700 15px/1 system-ui,sans-serif;
      box-shadow:0 3px 10px rgba(0,0,0,.4)}
    #mt-root{position:fixed;inset:0;z-index:2147483001;background:#f4f6f8;display:none;
      flex-direction:column;font:14px/1.35 system-ui,-apple-system,sans-serif;color:#12222e;
      -webkit-text-size-adjust:100%}
    #mt-root.mt-open{display:flex}
    #mt-head{display:flex;align-items:center;gap:8px;background:#0b6ea8;color:#fff;padding:10px 12px}
    #mt-head h1{margin:0;font-size:16px;font-weight:700;flex:1}
    #mt-head .mt-sub{font-size:11px;opacity:.85;font-weight:400}
    #mt-close{background:rgba(255,255,255,.18);border:none;color:#fff;font-size:20px;line-height:1;
      width:38px;height:38px;border-radius:8px}
    #mt-body{flex:1;overflow:auto;padding:10px;padding-bottom:4px}
    .mt-card{background:#fff;border:1px solid #d6dee5;border-radius:10px;margin-bottom:10px;overflow:hidden}
    .mt-card>label{display:block;padding:8px 10px 0;font-size:11px;font-weight:700;letter-spacing:.06em;
      text-transform:uppercase;color:#5b7285}
    .mt-scanrow{display:flex;gap:8px;padding:6px 10px 10px}
    .mt-scanrow input{flex:1;min-width:0;font:700 19px/1 monospace;padding:12px 10px;border:2px solid #c3ced8;
      border-radius:8px;text-transform:uppercase;background:#fbfdff}
    .mt-scanrow input:focus{outline:none;border-color:#0b6ea8;background:#fff}
    .mt-scanrow button{flex:0 0 auto;background:#e8eef3;border:1px solid #c3ced8;border-radius:8px;
      padding:0 14px;font:700 13px system-ui,sans-serif;color:#20455c}
    .mt-loc-ok{padding:0 10px 9px;font-size:12px;color:#1a7f45;font-weight:600}
    .mt-loc-bad{padding:0 10px 9px;font-size:12px;color:#b3261e;font-weight:600}
    .mt-tablehead{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#eef3f7;
      border-top:1px solid #d6dee5;border-bottom:1px solid #d6dee5;font-size:12px;font-weight:700;color:#40607a}
    .mt-tablehead .mt-count{margin-left:auto;font-weight:600;color:#5b7285}
    .mt-row{display:flex;align-items:flex-start;gap:9px;padding:9px 10px;border-bottom:1px solid #edf1f5}
    .mt-row:last-child{border-bottom:none}
    .mt-row.mt-on{background:#f2f9ff}
    .mt-row.mt-bad{background:#fff4f3}
    /* Allocated stock cannot be fully moved - make it impossible to miss. */
    .mt-row.mt-allocrow{background:#fdecea;border-left:5px solid #c5221f}
    .mt-row.mt-allocrow .mt-sku{color:#b3261e}
    .mt-allocmsg{color:#c5221f;font:800 12px/1.25 system-ui,sans-serif;margin-top:3px;
      text-transform:uppercase;letter-spacing:.03em}
    .mt-allocmsg small{display:block;font:600 11px system-ui,sans-serif;text-transform:none;
      letter-spacing:0;margin-top:1px}
    .mt-cb{flex:0 0 auto;width:26px;height:26px;margin:2px 0 0}
    .mt-mid{flex:1;min-width:0}
    .mt-sku{font:700 15px/1.2 monospace;word-break:break-all}
    .mt-desc{font-size:12px;color:#546c7e;margin-top:2px;overflow-wrap:anywhere}
    .mt-meta{margin-top:4px;display:flex;flex-wrap:wrap;gap:4px}
    .mt-tag{font-size:10px;font-weight:700;padding:2px 5px;border-radius:4px;background:#e6ecf1;color:#44607a;
      text-transform:uppercase;letter-spacing:.03em}
    .mt-tag.mt-batch{background:#e5f0ff;color:#14549b}
    .mt-tag.mt-alloc{background:#fdecc8;color:#8a5a00}
    .mt-tag.mt-lp{background:#f0e6ff;color:#5b2ea8}
    .mt-tag.mt-stat{background:#ffe4e0;color:#a3311f}
    .mt-right{flex:0 0 auto;width:92px;text-align:right}
    .mt-right input{width:100%;font:700 18px/1 monospace;text-align:right;padding:10px 6px;
      border:2px solid #c3ced8;border-radius:8px;background:#fbfdff}
    .mt-right input:focus{outline:none;border-color:#0b6ea8;background:#fff}
    .mt-onhand{font-size:11px;color:#5b7285;margin-top:3px}
    .mt-err{font-size:11px;color:#b3261e;font-weight:700;margin-top:3px}
    .mt-empty{padding:16px 10px;text-align:center;color:#7d92a3;font-size:13px}
    #mt-go{width:100%;padding:16px;border:none;border-radius:10px;background:#12833f;color:#fff;
      font:800 18px/1 system-ui,sans-serif;letter-spacing:.02em}
    #mt-go:disabled{background:#9fb0ba}
    #mt-foot{padding:0 10px 10px}
    #mt-console{background:#0e1a22;color:#d7e3ea;font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;
      padding:8px;height:150px;overflow:auto;border-radius:8px;white-space:pre-wrap;word-break:break-word}
    #mt-conwrap{padding:0 10px 10px}
    #mt-conbar{display:flex;align-items:center;gap:8px;padding:0 0 5px;font-size:11px;color:#5b7285;font-weight:700}
    #mt-conbar button{margin-left:auto;background:#e8eef3;border:1px solid #c3ced8;border-radius:6px;
      padding:5px 9px;font:600 11px system-ui,sans-serif;color:#20455c}
    #mt-conbar button+button{margin-left:5px}
    .mt-log-row{padding:1px 0}
    .mt-ok{color:#7ee2a8}.mt-err{color:#ff9b90;font-weight:700}.mt-warn{color:#ffd479}
    .mt-step{color:#8cd2ff}.mt-info{color:#c3d3dd}.mt-rule{color:#3c5666}
    #mt-veil{position:absolute;inset:0;background:rgba(244,246,248,.65);display:none;align-items:center;
      justify-content:center;font:700 15px system-ui,sans-serif;color:#0b6ea8}
    #mt-root.mt-busy #mt-veil{display:flex}
    `;

    let els = {};

    function buildUI() {
        const style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);

        const root = document.createElement('div');
        root.id = 'mt-root';
        root.innerHTML = `
          <div id="mt-head">
            <div style="flex:1">
              <h1>Malpa Transfer</h1>
              <div class="mt-sub">Location → location stock move</div>
            </div>
            <button id="mt-close" title="Close">×</button>
          </div>
          <div id="mt-body">
            <div class="mt-card">
              <label>From location</label>
              <div class="mt-scanrow">
                <input id="mt-from" placeholder="scan or type" autocomplete="off"
                       autocapitalize="characters" spellcheck="false" enterkeyhint="search">
                <button id="mt-from-go">Load</button>
              </div>
              <div id="mt-from-msg"></div>
              <div id="mt-tablehead" class="mt-tablehead" style="display:none">
                <input type="checkbox" id="mt-all" class="mt-cb" title="Select all">
                <span>Select all</span>
                <span class="mt-count" id="mt-count"></span>
              </div>
              <div id="mt-rows"></div>
            </div>
            <div class="mt-card">
              <label>To location</label>
              <div class="mt-scanrow">
                <input id="mt-to" placeholder="scan or type" autocomplete="off"
                       autocapitalize="characters" spellcheck="false" enterkeyhint="done">
                <button id="mt-to-go">Check</button>
              </div>
              <div id="mt-to-msg"></div>
            </div>
            <div id="mt-foot"><button id="mt-go" disabled>TRANSFER</button></div>
            <div id="mt-conwrap">
              <div id="mt-conbar">
                <span>CONSOLE</span>
                <button id="mt-copy">Copy</button>
                <button id="mt-clear">Clear</button>
              </div>
              <div id="mt-console"></div>
            </div>
          </div>
          <div id="mt-veil">Working…</div>
        `;
        document.body.appendChild(root);

        // Also the "is the script even running?" indicator - if this button is not
        // visible on the device, the script did not load (check @match / the URL).
        const launch = document.createElement('button');
        launch.id = 'mt-launch';
        launch.textContent = 'Malpa Transfer v1.1';
        document.body.appendChild(launch);

        els = {
            root,
            launch,
            from: root.querySelector('#mt-from'),
            to: root.querySelector('#mt-to'),
            fromMsg: root.querySelector('#mt-from-msg'),
            toMsg: root.querySelector('#mt-to-msg'),
            rows: root.querySelector('#mt-rows'),
            tablehead: root.querySelector('#mt-tablehead'),
            all: root.querySelector('#mt-all'),
            count: root.querySelector('#mt-count'),
            go: root.querySelector('#mt-go'),
            console: root.querySelector('#mt-console')
        };
        Log.setEl(els.console);

        launch.addEventListener('click', open);
        root.querySelector('#mt-close').addEventListener('click', close);
        root.querySelector('#mt-copy').addEventListener('click', () => {
            const t = Log.text();
            if (navigator.clipboard) navigator.clipboard.writeText(t).then(
                () => Log.info('Console copied'), () => Log.warn('Copy blocked by the browser'));
            else Log.warn('Clipboard unavailable');
        });
        root.querySelector('#mt-clear').addEventListener('click', () => Log.clear());

        const commitFrom = () => loadFrom(els.from.value);
        const commitTo = () => checkTo(els.to.value);
        els.from.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitFrom(); } });
        els.to.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitTo(); } });
        root.querySelector('#mt-from-go').addEventListener('click', commitFrom);
        root.querySelector('#mt-to-go').addEventListener('click', commitTo);

        els.all.addEventListener('change', () => {
            const on = els.all.checked;
            State.rows.forEach((r) => { r.checked = on; });
            renderRows();
            Log.info(on ? 'All ' + State.rows.length + ' lines selected' : 'Selection cleared');
        });
        els.go.addEventListener('click', doTransfer);

        // Any tap unlocks audio (browsers block sound before a gesture).
        root.addEventListener('touchstart', Sound.unlock, { once: true, passive: true });
        root.addEventListener('mousedown', Sound.unlock, { once: true });
    }

    function setBusy(on) {
        els.root.classList.toggle('mt-busy', !!on);
        els.go.disabled = !!on || !canGo();
    }

    function canGo() {
        return !!(State.from && State.to && String(State.from.id) !== String(State.to.id) &&
                  State.rows.some((r) => r.checked));
    }

    function refreshGo() {
        els.go.disabled = State.busy || !canGo();
        const n = State.rows.filter((r) => r.checked).length;
        els.count.textContent = State.rows.length
            ? n + ' of ' + State.rows.length + ' selected'
            : '';
        els.all.checked = State.rows.length > 0 && n === State.rows.length;
        els.go.textContent = n ? 'TRANSFER ' + n + ' LINE' + (n === 1 ? '' : 'S') : 'TRANSFER';
    }

    function renderRows() {
        const wrap = els.rows;
        wrap.innerHTML = '';
        els.tablehead.style.display = State.rows.length ? 'flex' : 'none';
        if (!State.rows.length) {
            if (State.from) {
                const d = document.createElement('div');
                d.className = 'mt-empty';
                d.textContent = 'No stock in ' + State.from.location_code;
                wrap.appendChild(d);
            }
            refreshGo();
            return;
        }
        for (const g of State.rows) {
            const err = g.checked ? validateRow(g) : null;
            const hasAlloc = (g.allocated || 0) > 0 || (g.suspended || 0) > 0;
            const row = document.createElement('div');
            row.className = 'mt-row' + (g.checked ? ' mt-on' : '') + (err ? ' mt-bad' : '') +
                            (hasAlloc ? ' mt-allocrow' : '');

            const cb = document.createElement('input');
            cb.type = 'checkbox'; cb.className = 'mt-cb'; cb.checked = g.checked;
            cb.addEventListener('change', () => { g.checked = cb.checked; renderRows(); });

            const mid = document.createElement('div');
            mid.className = 'mt-mid';
            const sku = document.createElement('div');
            sku.className = 'mt-sku'; sku.textContent = g.itemCode;
            const desc = document.createElement('div');
            desc.className = 'mt-desc'; desc.textContent = g.description || '—';
            const meta = document.createElement('div');
            meta.className = 'mt-meta';
            const tag = (cls, txt) => {
                const s = document.createElement('span');
                s.className = 'mt-tag ' + cls; s.textContent = txt; meta.appendChild(s);
            };
            if (g.factor > 1) tag('', g.uomName + ' ×' + g.factor);
            if (g.batchNo) tag('mt-batch', 'BATCH ' + g.batchNo + (g.batchExpiry ? ' · ' + String(g.batchExpiry).slice(0, 10) : ''));
            if (g.status && g.status.toLowerCase() !== 'available') tag('mt-stat', g.status);
            if (g.lps.length === 1) tag('mt-lp', 'LP ' + g.lps[0]);
            if (g.lps.length > 1) tag('mt-lp', g.lps.length + ' LPs: ' + g.lps.join(', '));
            mid.appendChild(sku); mid.appendChild(desc);
            if (meta.children.length) mid.appendChild(meta);
            if (hasAlloc) {
                const a = document.createElement('div');
                a.className = 'mt-allocmsg';
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
                e.className = 'mt-err'; e.textContent = err; mid.appendChild(e);
            }

            const right = document.createElement('div');
            right.className = 'mt-right';
            const qty = document.createElement('input');
            qty.type = 'number'; qty.inputMode = 'numeric'; qty.min = '0';
            qty.step = String(g.factor > 1 ? g.factor : 1);
            qty.value = String(g.qty);
            qty.addEventListener('input', () => {
                g.qty = qty.value === '' ? 0 : Number(qty.value);
                if (!g.checked && g.qty > 0) g.checked = true;
                refreshGo();
            });
            qty.addEventListener('blur', renderRows);
            const oh = document.createElement('div');
            oh.className = 'mt-onhand';
            oh.textContent = hasAlloc ? 'max ' + movableQty(g) : 'of ' + g.onHand;
            if (hasAlloc) oh.style.color = '#c5221f';
            right.appendChild(qty); right.appendChild(oh);

            row.appendChild(cb); row.appendChild(mid); row.appendChild(right);
            wrap.appendChild(row);
        }
        refreshGo();
    }

    async function loadFrom(code, opts) {
        const quiet = opts && opts.quiet;
        const clean = String(code || '').trim().toUpperCase();
        els.from.value = clean;
        els.fromMsg.className = ''; els.fromMsg.textContent = '';
        State.rows = []; renderRows();
        if (!clean) { State.from = null; refreshGo(); return; }
        if (!quiet) Sound.scan();
        setBusy(true);
        try {
            const loc = await resolveLocation(clean);
            State.from = loc;
            els.fromMsg.className = 'mt-loc-ok';
            els.fromMsg.textContent = 'FROM ' + loc.location_code + ' (id ' + loc.id + ')';
            const recs = await readLocationStock(loc.location_code);
            State.rows = groupRows(recs, loc.id);
            renderRows();
            if (!State.rows.length) {
                Log.warn('FROM ' + loc.location_code + ' is empty');
                Sound.warn();
            } else {
                const total = State.rows.reduce((s, r) => s + r.onHand, 0);
                Log.ok('FROM ' + loc.location_code + ': ' + State.rows.length + ' line' +
                       (State.rows.length === 1 ? '' : 's') + ', ' + total + ' units');
                const merged = State.rows.filter((r) => r.lps.length > 1);
                merged.forEach((r) => Log.warn(r.itemCode + ': ' + r.lps.length +
                    ' licence plates merged into one line (Canary7 cannot target an LP on transfer)'));
                if (!quiet) els.to.focus();
            }
        } catch (e) {
            State.from = null;
            els.fromMsg.className = 'mt-loc-bad';
            els.fromMsg.textContent = String((e && e.message) || e);
            Log.err('FROM ' + clean + ': ' + ((e && e.message) || e));
            Sound.error();
        } finally {
            setBusy(false);
            refreshGo();
        }
    }

    async function checkTo(code) {
        const clean = String(code || '').trim().toUpperCase();
        els.to.value = clean;
        els.toMsg.className = ''; els.toMsg.textContent = '';
        if (!clean) { State.to = null; refreshGo(); return; }
        Sound.scan();
        setBusy(true);
        try {
            const loc = await resolveLocation(clean);
            if (State.from && String(loc.id) === String(State.from.id)) {
                throw new Error('TO is the same as FROM');
            }
            State.to = loc;
            els.toMsg.className = 'mt-loc-ok';
            els.toMsg.textContent = 'TO ' + loc.location_code + ' (id ' + loc.id + ')';
            Log.ok('TO ' + loc.location_code + ' ready');
            if (loc.allow_multiple_items === 0) {
                Log.warn(loc.location_code + ' does not allow multiple items - a mixed transfer may be rejected');
            }
        } catch (e) {
            State.to = null;
            els.toMsg.className = 'mt-loc-bad';
            els.toMsg.textContent = String((e && e.message) || e);
            Log.err('TO ' + clean + ': ' + ((e && e.message) || e));
            Sound.error();
        } finally {
            setBusy(false);
            refreshGo();
        }
    }

    function open() {
        els.root.classList.add('mt-open');
        Sound.unlock();
        if (!open._greeted) {
            open._greeted = true;
            Log.info('Malpa Transfer ready · API ' + apiBase() + ' · warehouse ' + warehouseId());
            if (!authToken()) Log.err('No session token found - log into Canary7 in this tab first');
            Log.info('Scan FROM, tick lines, scan TO, press TRANSFER');
        }
        setTimeout(() => els.from.focus(), 80);
    }

    function close() { els.root.classList.remove('mt-open'); }

    /* Replace the native Inventory Adjustment > Transfer tab.
     * The build's DOM isn't known ahead of time, so match on the tab's own text
     * and bail out harmlessly if it never appears - the launcher still works. */
    function hijackNativeTab() {
        if (!CONFIG.hijackNativeTransferTab) return;
        document.addEventListener('click', (e) => {
            try {
                if (els.root.contains(e.target)) return;
                const t = e.target.closest('a,button,li,div[role="tab"],span');
                if (!t) return;
                const txt = (t.textContent || '').trim();
                if (!/^transfer$/i.test(txt)) return;
                const inAdjust = /adjust/i.test(location.href + ' ' + document.body.className) ||
                                 !!document.querySelector('[class*="adjust" i],[id*="adjust" i]');
                if (!inAdjust) return;
                e.preventDefault();
                e.stopPropagation();
                Log.info('Native Transfer tab intercepted');
                open();
            } catch (_) {}
        }, true);
    }

    /* Add a real "Malpa Transfer" entry to Canary7's own menu / sidebar.
     * The build's markup is unknown, so rather than hardcode selectors this finds an
     * EXISTING menu item by its label, clones it (inheriting the app's own styling)
     * and relabels the clone. Angular renders the nav late, so it keeps watching for
     * a while. Purely additive - if no menu is found, nothing happens and the
     * floating button remains the way in. */
    const MENU_LABELS = /^(inventory|inventory adjustment|adjustment|adjustments|receiving|receipts|shipments|picking|putaway|stock|dashboard|home|reports|cycle count)$/i;

    function injectMenuEntry() {
        if (document.getElementById('mt-menu-entry')) return true;

        const candidates = [...document.querySelectorAll('a,li,button')].filter((n) => {
            if (els.root && els.root.contains(n)) return false;
            const txt = (n.textContent || '').trim();
            if (!txt || txt.length > 30) return false;
            if (!MENU_LABELS.test(txt)) return false;
            const r = n.getBoundingClientRect();
            return r.width > 0 && r.height > 0;      // must actually be visible
        });
        if (!candidates.length) return false;

        // Prefer the item with the most same-shaped siblings - that's the real nav list.
        candidates.sort((a, b) => {
            const sibs = (n) => (n.parentNode ? n.parentNode.children.length : 0);
            return sibs(b) - sibs(a);
        });
        const model = candidates[0];
        const parent = model.parentNode;
        if (!parent) return false;

        const entry = model.cloneNode(true);
        entry.id = 'mt-menu-entry';
        entry.removeAttribute('href');
        // Replace the label text wherever it lives, keeping the app's own markup.
        const relabel = (node) => {
            if (node.nodeType === 3) {
                if (node.textContent.trim()) { node.textContent = 'Malpa Transfer'; return true; }
                return false;
            }
            for (const c of node.childNodes) if (relabel(c)) return true;
            return false;
        };
        if (!relabel(entry)) entry.textContent = 'Malpa Transfer';
        entry.style.cursor = 'pointer';
        entry.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            open();
        }, true);
        parent.appendChild(entry);
        console.log('[MalpaTransfer] menu entry added next to "' + (model.textContent || '').trim() + '"');
        return true;
    }

    function watchForMenu() {
        if (injectMenuEntry()) return;
        let tries = 0;
        const obs = new MutationObserver(() => {
            if (++tries > 400 || injectMenuEntry()) obs.disconnect();
        });
        obs.observe(document.body, { childList: true, subtree: true });
        // Angular can swap the whole nav on route change - re-check periodically too.
        const iv = setInterval(() => {
            if (injectMenuEntry() && ++tries > 60) clearInterval(iv);
            if (tries++ > 60) clearInterval(iv);
        }, 1000);
        setTimeout(() => { obs.disconnect(); clearInterval(iv); }, 120000);
    }

    function init() {
        buildUI();
        hijackNativeTab();
        watchForMenu();
        // Guaranteed way in even if every UI injection fails: Tampermonkey's own menu.
        try {
            if (typeof GM_registerMenuCommand === 'function') {
                GM_registerMenuCommand('Open Malpa Transfer', open);
            }
        } catch (_) {}
        console.log('[MalpaTransfer] v1.1.0 loaded on ' + location.host + '. API base', apiBase());
    }

    // Exposed for troubleshooting on the device and for the offline test harness.
    window.__malpaTransfer = {
        CONFIG, State, Sniff, api, open, close,
        groupRows, validateRow, movableQty, buildTransferBody, resolveLocation, readLocationStock,
        apiBase, warehouseId, hasToken: () => !!authToken(),
        version: '1.1.0', injectMenuEntry, host: location.host
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();

// ==UserScript==
// @name         Malpa C7 - Replen Early Qty
// @namespace    malpa
// @version      4.8.1
// @description  Shows replen qty + To Location before scanning (matched to the on-screen job, profile-scoped); keeps Confirm Units editable; blocks over-moves against LIVE on-hand at the actual execute call, not just the Next button.
// @match        https://*.canary7.com/*
// @grant        none
// @homepageURL  https://github.com/zaynnev/malpa3pl
// @supportURL   https://github.com/zaynnev/malpa3pl/issues
// @updateURL     https://raw.githubusercontent.com/Malpa-3PL/Warehouse-Scripts/main/malpa-replen.user.js
// @downloadURL   https://raw.githubusercontent.com/Malpa-3PL/Warehouse-Scripts/main/malpa-replen.user.js
// ==/UserScript==

// -----------------------------------------------------------------------------
// CONFIRMED AGAINST LIVE CANARY7 (via malpa-canary7 MCP, 2026-08-11) — do not
// re-derive, and do not change these without re-probing:
//
//  * COMMIT CALL (the hole v4.7 missed):
//      GET index.php?r=inventory/replenishment-detail/execute-replenishment-job
//          &job_instruction_id=<id>[&4 further optional params]
//    Confirmed to exist: called with no params it returns HTTP 400
//    "Missing required parameters: job_instruction_id", whereas a bogus action
//    on the same controller returns InvalidRoute / Page not found. Called with
//    a bogus id it returns HTTP 500 code 1034 "No Job Instruction" and the
//    stack trace shows
//      ReplenishmentDetailController->actionExecuteReplenishmentJob(id,N,N,N,N)
//      ReplenishmentDetail::executeReplenishmentJob(id,N,N,N,N,N)
//    i.e. job_instruction_id + 4 optional params. It is a GET MUTATION (same
//    family as move-into-container-v2 / pack-short-v2). The 4 optional param
//    NAMES are still unknown — this script logs the full commit URL to the
//    console so they can be read off a real device and the guard tightened.
//
//  * LIVE ON-HAND (what the guard now compares against):
//      GET index.php?r=inventory/inventory&item_code=<code>&location_code=<code>
//    returns per-record { id, on_hand_quantity, allocated_quantity,
//    suspended_quantity, item_unit_of_measure_id, location_id }. Match on
//    id === replenishmentDetail[0].inventory.id. NOTE: `id=` is NOT a filter on
//    this endpoint (it is silently ignored and you get page 1 of everything),
//    and location_code is a PREFIX match — hence the id match client-side.
//    Default page size is 20, so per-page is sent explicitly.
//
//  * on_hand_quantity is in BASE units; the Confirm Units field is in the
//    FROM-UOM. So the comparison is  entered x factor  vs  on_hand_quantity,
//    where factor = replenishmentDetail[0].inventory.itemUnitOfMeasure.factor.
//    (v4.7 compared the raw entered figure against available_quantity with no
//    conversion — under-blocking on any factor > 1 UOM.)
//
//  * get-unallocated-inventory returns available = on_hand - allocated -
//    suspended (verified: inventory 10439, on_hand 1101 / alloc 0 / susp 0 ->
//    available_quantity 1101). Still fetched, for the warning line only.
// -----------------------------------------------------------------------------

(function () {
  'use strict';

  const TAG = '[Malpa Replen]';
  const VERSION = '4.8';
  const QTY_ID = 'malpa-qty-line';
  const ERR_ID = 'malpa-qty-error';
  const API = 'https://stgauth.canary7.com/index.php?r=';
  const COMMIT = 'execute-replenishment-job';
  const POLL_MS = 2500;          // how often the live on-hand figure is refreshed

  const jobsById = {};           // get-replenishment-jobs rows for the CURRENT profile
  let currentJobId = null;       // job_id from the latest assign-replenishment-job
  let lastProfileId = null;      // profile_id of the jobs currently cached
  let lastAuth = null;           // Authorization header captured from C7's own requests

  // Live stock state for the currently-matched job.
  const R = {
    invId: null,                 // inventory id the guard is tracking
    onHand: null,                // base units, live
    allocated: null,
    suspended: null,
    fetchedAt: 0,
    factor: 1,                   // base units per entered unit
    lastQty: null,               // last quantity the operator had in the field
    polling: false
  };

  console.log(TAG, 'script loaded v' + VERSION);

  // ===========================================================================
  // 1. PURE DECISION LOGIC  (kept side-effect free so the harness can test it)
  // ===========================================================================

  // Returns null to ALLOW, or a reason string to BLOCK.
  // Fails OPEN on anything unknown — a wrong-inventory block is worse than none.
  function overMoveReason(s) {
    const qty = Number(s.qty);
    const factor = Number(s.factor);
    const onHand = s.onHand;
    if (!isFinite(qty) || qty <= 0) return null;            // nothing to judge
    if (!isFinite(factor) || factor <= 0) return null;      // unknown UOM -> allow
    if (onHand == null || !isFinite(Number(onHand))) return null; // no live figure -> allow
    const wantBase = qty * factor;
    if (wantBase <= Number(onHand)) return null;
    const haveEntered = Math.floor(Number(onHand) / factor);
    return 'Only ' + haveEntered + ' on hand at ' + (s.where || 'the from-location') +
           ' — you entered ' + qty + '. Reduce the quantity.';
  }

  function isCommitUrl(u) {
    return !!u && String(u).indexOf(COMMIT) !== -1;
  }

  // ===========================================================================
  // 2. NETWORK TAPS: job cache, assigned job, auth capture, COMMIT GUARD
  // ===========================================================================

  function profileIdOf(url) {
    const m = url && url.match(/[?&]profile_id=(\d+)/);
    return m ? m[1] : null;
  }

  function cacheJobs(data, profileId) {
    if (!Array.isArray(data)) return;
    if (profileId != null && String(profileId) !== String(lastProfileId)) {
      for (const k of Object.keys(jobsById)) delete jobsById[k];
      currentJobId = null;
      lastProfileId = String(profileId);
      resetStock();
      const l = document.getElementById(QTY_ID); if (l) l.remove();
      console.log(TAG, 'profile changed to', profileId, '- cache cleared');
    }
    data.forEach(j => { if (j && j.id != null) jobsById[j.id] = j; });
    console.log(TAG, 'cached', data.length, 'jobs (profile', profileId + ', total', Object.keys(jobsById).length + ')');
  }

  function noteAssign(url) {
    const m = url && url.match(/[?&]job_id=(\d+)/);
    if (m) {
      currentJobId = parseInt(m[1], 10);
      console.log(TAG, 'assigned job_id =', currentJobId);
      resetStock();
      const l = document.getElementById(QTY_ID);
      if (l) l.remove(); // force redraw for the new job
    }
  }

  function resetStock() {
    R.invId = null; R.onHand = null; R.allocated = null; R.suspended = null;
    R.fetchedAt = 0; R.factor = 1; R.lastQty = null;
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origFetch = window.fetch;

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try { if (String(name).toLowerCase() === 'authorization' && value) lastAuth = value; } catch (e) {}
    return origSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.open = function (m, url) {
    this.__malpaUrl = url;
    if (url && url.indexOf('assign-replenishment-job') !== -1) noteAssign(url);
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    const url = this.__malpaUrl;

    // ---- THE GUARD. Runs at the real execute moment, whichever control fired it.
    if (isCommitUrl(url)) {
      console.log(TAG, 'COMMIT seen:', String(url).replace(API, ''));
      const verdict = judgeCommit();
      if (verdict) {
        showError(verdict);
        failXhr(this);
        return; // never reaches Canary7
      }
      clearError();
    }

    this.addEventListener('load', function () {
      try {
        if (this.__malpaUrl && this.__malpaUrl.indexOf('get-replenishment-jobs') !== -1) {
          cacheJobs(JSON.parse(this.responseText), profileIdOf(this.__malpaUrl));
        }
      } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };

  // Make the aborted request look like a network failure to Angular's HttpClient
  // so the screen errors out cleanly instead of hanging on a request that never
  // completes. Our red banner carries the real explanation.
  function failXhr(xhr) {
    setTimeout(() => {
      try {
        xhr.dispatchEvent(new ProgressEvent('error'));
        xhr.dispatchEvent(new ProgressEvent('loadend'));
      } catch (e) { console.warn(TAG, 'could not synthesise error event', e); }
    }, 0);
  }

  if (origFetch) {
    window.fetch = function (...args) {
      let url = null;
      try { url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url); } catch (e) {}

      if (isCommitUrl(url)) {
        console.log(TAG, 'COMMIT seen (fetch):', String(url).replace(API, ''));
        const verdict = judgeCommit();
        if (verdict) {
          showError(verdict);
          return Promise.reject(new Error('[Malpa Replen] blocked: ' + verdict));
        }
        clearError();
      }

      if (url && url.indexOf('assign-replenishment-job') !== -1) noteAssign(url);

      return origFetch.apply(this, args).then((res) => {
        try {
          if (url && url.indexOf('get-replenishment-jobs') !== -1) {
            res.clone().json().then(d => cacheJobs(d, profileIdOf(url))).catch(() => {});
          }
        } catch (e) {}
        return res;
      });
    };
  }

  // Synchronous verdict at commit time, using the polled figure. Uses the live
  // field value if the field is still on screen, else the last one we saw.
  function judgeCommit() {
    const inp = findQtyInput();
    const qty = inp && inp.value !== '' ? parseInt(inp.value, 10) : R.lastQty;
    const reason = overMoveReason({
      qty: qty,
      factor: R.factor,
      onHand: R.onHand,
      where: R.where
    });
    console.log(TAG, 'commit check: qty', qty, 'x factor', R.factor,
                '=', (qty * R.factor), 'base vs on-hand', R.onHand,
                '(age ' + (Date.now() - R.fetchedAt) + 'ms) ->', reason ? 'BLOCK' : 'allow');
    return reason;
  }

  // ===========================================================================
  // 3. LIVE ON-HAND POLLER
  // ===========================================================================

  function apiGet(route, params) {
    const qs = Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k])).join('&');
    const headers = { 'Accept': 'application/json, text/plain, */*' };
    if (lastAuth) headers['Authorization'] = lastAuth;
    return (origFetch || window.fetch)(API + route + '&' + qs, { headers, credentials: 'omit' })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  function refreshOnHand(row) {
    const invId = invIdOf(row);
    const itemCode = row.item && row.item.item_code;
    const locCode = row.fromLocation && row.fromLocation.location_code;
    if (invId == null || !itemCode || !locCode) return Promise.resolve(null);

    return apiGet('inventory/inventory', {
      item_code: itemCode,
      location_code: locCode,
      'per-page': 200,
      fields: 'id,on_hand_quantity,allocated_quantity,suspended_quantity,item_unit_of_measure_id,location_id'
    }).then(rows => {
      // location_code is a PREFIX match and one bin can hold several records
      // (uom / batch / LP), so match the exact inventory id from the job.
      const rec = Array.isArray(rows) ? rows.find(x => String(x.id) === String(invId)) : null;
      if (!rec) { console.warn(TAG, 'inventory', invId, 'not in response for', itemCode, '@', locCode); return null; }
      R.invId = invId;
      R.onHand = Number(rec.on_hand_quantity);
      R.allocated = Number(rec.allocated_quantity) || 0;
      R.suspended = Number(rec.suspended_quantity) || 0;
      R.factor = factorOf(row);
      R.where = locCode;
      R.fetchedAt = Date.now();
      return R.onHand;
    }).catch(err => {
      console.warn(TAG, 'on-hand refresh failed', err);
      return null;
    });
  }

  function startPolling() {
    if (R.polling) return;
    R.polling = true;
    setInterval(() => {
      try {
        if (!onReplenExecScreen()) return;
        const row = currentJob();
        if (!row) return;
        refreshOnHand(row);
      } catch (e) { console.warn(TAG, 'poll error', e); }
    }, POLL_MS);
    console.log(TAG, 'on-hand poller running every', POLL_MS + 'ms');
  }

  function invIdOf(row) {
    try { if (row.job.replenishmentDetail[0].inventory.id != null) return row.job.replenishmentDetail[0].inventory.id; } catch (e) {}
    try { if (row.job.replenishmentDetail[0].inventory_id != null) return row.job.replenishmentDetail[0].inventory_id; } catch (e) {}
    return null;
  }

  function factorOf(row) {
    try {
      const f = Number(row.job.replenishmentDetail[0].inventory.itemUnitOfMeasure.factor);
      if (isFinite(f) && f > 0) return f;
    } catch (e) {}
    return 1;
  }

  // ===========================================================================
  // 4. DOM HELPERS
  // ===========================================================================

  function findByLabel(prefix) {
    const p = prefix.toLowerCase().replace(/\s+/g, ' ');
    let best = null, bestLen = Infinity;
    const els = document.querySelectorAll('div, label, span, strong, p, dt, dd');
    for (const el of els) {
      const t = el.textContent.trim().replace(/\s+/g, ' ').toLowerCase();
      if (t.startsWith(p)) {
        const len = el.textContent.trim().length;
        if (len < bestLen) { best = el; bestLen = len; }
      }
    }
    return best;
  }

  function valueOf(el, prefix) {
    if (!el) return null;
    const strong = el.querySelector('strong');
    if (strong && strong.textContent.trim()) return strong.textContent.trim();
    return el.textContent.trim().slice(prefix.length).replace(/^[\s:]+/, '').trim();
  }

  function findContainer(substr) {
    const s = substr.toLowerCase().replace(/\s+/g, ' ');
    let best = null, bestLen = Infinity;
    const els = document.querySelectorAll('div, label, span, strong, p, dt, dd');
    for (const el of els) {
      const t = el.textContent.replace(/\s+/g, ' ').toLowerCase();
      if (t.includes(s)) {
        const len = el.textContent.trim().length;
        if (len < bestLen) { best = el; bestLen = len; }
      }
    }
    return best;
  }

  function findQtyInput() {
    return document.querySelector('input[formcontrolname="quantity"]') ||
           document.querySelector('input[id^="txt_qty"]');
  }

  // Keep the Confirm Units field editable, and remember what is in it — the
  // field can be off-screen by the time the commit fires.
  function keepQtyUnlocked() {
    const inp = findQtyInput();
    if (!inp) return;
    if (inp.hasAttribute('readonly') || inp.readOnly) {
      inp.removeAttribute('readonly');
      inp.readOnly = false;
      if (!inp.__malpaUnlocked) { inp.__malpaUnlocked = true; console.log(TAG, 'qty field editable'); }
    }
    if (inp.value !== '') {
      const v = parseInt(inp.value, 10);
      if (isFinite(v)) R.lastQty = v;
    }
    if (!inp.__malpaWatch) {
      inp.__malpaWatch = true;
      inp.addEventListener('input', () => {
        clearError();                       // safe: no dispatch, just clears the banner
        const v = parseInt(inp.value, 10);
        if (isFinite(v)) R.lastQty = v;
        const row = currentJob();           // re-check stock the moment they retype
        if (row) refreshOnHand(row);
      });
    }
  }

  function errorHost() {
    const chs = document.querySelectorAll('.card-header');
    for (const h of chs) if (h.textContent.trim().indexOf('Replenishment Job Execution') === 0) return h;
    return chs[0] || null;
  }

  function showError(msg) {
    let el = document.getElementById(ERR_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = ERR_ID;
      el.style.cssText = 'background:#c0392b;color:#fff;font-weight:bold;padding:8px 12px;margin:8px;border-radius:4px;font-size:1.05em;';
      const host = errorHost();
      if (host && host.parentNode) host.parentNode.insertBefore(el, host.nextSibling);
      else document.body.insertBefore(el, document.body.firstChild);
    }
    el.textContent = '⚠ ' + msg;
    console.warn(TAG, 'BLOCKED:', msg);
    const inp = findQtyInput();
    if (inp) { try { inp.focus(); if (inp.select) inp.select(); } catch (e) {} }
  }

  function clearError() {
    const el = document.getElementById(ERR_ID);
    if (el) el.remove();
  }

  // ===========================================================================
  // 5. EARLY GUARD ON NEXT  (unchanged in spirit — now on-hand based, and it is
  //    only an early warning; the commit tap above is the one that must hold.)
  // ===========================================================================

  function findNextBtn() {
    const btns = document.querySelectorAll('button');
    for (const b of btns) if (b.textContent.trim() === 'Next') return b;
    return null;
  }

  let bypassGuard = false;
  let inFlight = false;

  function onNextCapture(e) {
    if (bypassGuard) { bypassGuard = false; return; }
    if (!onReplenExecScreen()) return;

    const inp = findQtyInput();
    if (!inp || inp.value === '') return;
    const qty = parseInt(inp.value, 10);
    if (isNaN(qty)) return;
    R.lastQty = qty;

    const btn = e.currentTarget || findNextBtn();
    const row = currentJob();
    if (!row || invIdOf(row) == null) {
      console.warn(TAG, 'no confident match / inventory id — early check skipped, letting C7 proceed');
      return;
    }

    e.preventDefault();
    e.stopImmediatePropagation();
    if (inFlight) return;
    inFlight = true;

    refreshOnHand(row).then(() => {
      inFlight = false;
      const reason = overMoveReason({ qty, factor: R.factor, onHand: R.onHand, where: R.where });
      if (reason) {
        showError(reason);
      } else {
        clearError();
        if (R.allocated) {
          console.log(TAG, 'note:', R.allocated, 'base units allocated at', R.where,
                      '- allowed anyway (guard is on-hand based by design)');
        }
        proceed(btn);
      }
    }).catch(err => {
      inFlight = false;
      console.warn(TAG, 'early check failed', err, '- letting C7 proceed; commit tap still applies');
      proceed(btn);
    });
  }

  function proceed(btn) {
    bypassGuard = true;
    const b = btn || findNextBtn();
    if (b) b.click();
  }

  function attachGuard() {
    const btn = findNextBtn();
    if (!btn || btn.__malpaGuard) return;
    btn.__malpaGuard = true;
    btn.addEventListener('click', onNextCapture, true);
    console.log(TAG, 'early guard attached to Next');
  }

  // ===========================================================================
  // 6. FIND THE CURRENTLY-LOADED JOB
  // ===========================================================================

  function screenKeys() {
    return {
      item: valueOf(findByLabel('Item :'), 'Item :'),
      from: valueOf(findByLabel('From Location :'), 'From Location :'),
      to:   valueOf(findByLabel('To Location :'), 'To Location :'),
    };
  }

  function consistentWithScreen(r, k) {
    if (!k.item && !k.from && !k.to) return false;
    if (k.item && r.item && r.item.item_code !== k.item) return false;
    if (k.from && r.fromLocation && r.fromLocation.location_code !== k.from) return false;
    if (k.to && r.toLocation && r.toLocation.location_code !== k.to) return false;
    return true;
  }

  function currentJob() {
    const rows = Object.values(jobsById);
    if (!rows.length) return null;
    const k = screenKeys();

    if (currentJobId != null) {
      const r = rows.find(x => x.job_id === currentJobId || (x.job && x.job.id === currentJobId));
      if (r && consistentWithScreen(r, k)) return r;
    }
    if (k.from) {
      let cand = rows.filter(r => r.fromLocation && r.fromLocation.location_code === k.from);
      if (k.item) {
        const narrowed = cand.filter(r => r.item && r.item.item_code === k.item);
        if (narrowed.length) cand = narrowed;
      }
      if (cand.length === 1 && consistentWithScreen(cand[0], k)) return cand[0];
    }
    if (k.item && k.to) {
      const cand = rows.filter(r => r.item && r.item.item_code === k.item && r.toLocation && r.toLocation.location_code === k.to);
      if (cand.length === 1) return cand[0];
    }
    console.log(TAG, 'no confident job match for screen', k);
    return null;
  }

  function qtyOf(row) {
    try { if (row.job.replenishmentDetail[0].quantity != null) return row.job.replenishmentDetail[0].quantity; } catch (e) {}
    return row.quantity;
  }

  function uomOf(row) {
    try { return row.job.replenishmentDetail[0].inventory.itemUnitOfMeasure.unitOfMeasure.name || 'units'; } catch (e) {}
    return 'units';
  }

  // ===========================================================================
  // 7. RENDER
  // ===========================================================================

  function removeQtyLine() {
    const l = document.getElementById(QTY_ID);
    if (l) l.remove();
  }

  function onReplenExecScreen() {
    const headers = document.querySelectorAll('.card-header, .card-header strong, strong');
    for (const h of headers) {
      if (h.textContent.trim() === 'Replenishment Job Execution') return true;
    }
    return false;
  }

  function sync() {
    try {
      if (!onReplenExecScreen()) { removeQtyLine(); return; }
      keepQtyUnlocked();
      attachGuard();

      const anchor = findContainer('Description :') || findContainer('From Location :') || findContainer('Item :');
      if (!anchor) { removeQtyLine(); return; }

      const row = currentJob();
      if (!row) {
        if (Object.keys(jobsById).length) console.log(TAG, 'no matching job yet');
        removeQtyLine();
        return;
      }

      // First sight of this job: get a live figure immediately, don't wait for the poll.
      if (R.invId == null || String(R.invId) !== String(invIdOf(row))) refreshOnHand(row);

      const key = String(row.id);
      const existing = document.getElementById(QTY_ID);
      if (existing && existing.dataset.key === key && document.contains(existing)) return;
      if (existing) existing.remove();

      const qty = qtyOf(row);
      const uom = uomOf(row);
      const toLoc = (row.toLocation && row.toLocation.location_code) || '';
      const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

      const line = document.createElement('div');
      line.id = QTY_ID;
      line.dataset.key = key;
      line.style.display = 'contents';
      line.innerHTML =
        '<div class="form-group ng-star-inserted">Qty to move : <strong>' + esc(qty) + ' × ' + esc(uom) + '</strong></div>' +
        (toLoc ? '<div class="form-group ng-star-inserted">To Location : <strong>' + esc(toLoc) + '</strong></div>' : '');
      anchor.parentNode.insertBefore(line, anchor.nextSibling);

      console.log(TAG, 'Qty line added:', qty, uom, 'to', toLoc, '(job', row.job_id + ', item', (row.item && row.item.item_code) + ')');
    } catch (e) {
      console.warn(TAG, 'sync error', e);
    }
  }

  // Debug handle for the on-device console.
  window.__malpaReplen = { R, jobsById, currentJob, refreshOnHand, overMoveReason, VERSION };

  new MutationObserver(sync).observe(document.body, { childList: true, subtree: true });
  setInterval(sync, 600);
  startPolling();
  sync();
  console.log(TAG, 'observer + poll running');
})();

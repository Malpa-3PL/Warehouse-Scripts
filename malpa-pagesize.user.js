// ==UserScript==
// @name         Malpa C7 Page Size 200
// @namespace    malpa.pagesize
// @version      1.0.1
// @description  Adds 100 and 200 to every Canary7 table "Page Size" dropdown, opens tables at 200 the first time, and warns if C7 serves fewer rows than asked.
// @match        https://malpa.canary7.com/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/Malpa-3PL/Warehouse-Scripts/main/malpa-pagesize.user.js
// @downloadURL  https://raw.githubusercontent.com/Malpa-3PL/Warehouse-Scripts/main/malpa-pagesize.user.js
// ==/UserScript==

/*
 * WHAT THIS DOES
 * --------------
 * C7's tables (Angular) offer at most 50 rows a page. There are three page-size
 * dropdowns in the C7 bundle (read 26 Nov 2026):
 *
 *   1. ag-grid tables (Shipping Enquiry, Inventory, Jobs, ...): label "Page Size",
 *      options 10/20/30/40/50. On change C7 calls setPerPage(select.value), which
 *      does Number(value) and saves it to localStorage "pageSize" - ONE value shared
 *      by every ag-grid table. Each table reads it back on open.
 *   2. Older tables: a <select> in the Prev/Next/Last pager, options 10/25/50,
 *      saved to localStorage "perPage".
 *   3. Teams list: label "Page Size", client-side paging, not saved.
 *
 * C7 passes whatever number the select holds straight into `per-page=` on the
 * API call, so adding <option>100</option> and <option>200</option> is enough.
 *
 * This script:
 *   A. On first run, sets "pageSize" and "perPage" to 200 so tables open at 200.
 *      After that C7 remembers whatever you pick (pick 50 and it stays 50).
 *   B. Adds 100 and 200 to every page-size dropdown, and shows the right value
 *      when the saved size isn't one of C7's own options (otherwise it's blank).
 *   C. Watches list calls asking for 100/200 rows. Some C7 endpoints silently
 *      cap the page (inventory get-summary at 50, items ~400). On an ag-grid
 *      table that makes page 2+ skip rows, so a red banner says so.
 *
 * Writes nothing to C7. Only touches the two localStorage keys above.
 */

(function () {
  'use strict';

  // ---- Config ---------------------------------------------------------------
  var TAG = '[Malpa PageSize]';
  var EXTRA_SIZES = [100, 200];            // added to every page-size dropdown
  var DEFAULT_SIZE = 200;                  // first-run size; set null to skip seeding
  var SEED_KEY = 'malpa.pagesize.seeded.v1';
  var AG_KEY = 'pageSize';                 // C7: ag-grid tables (shared)
  var PAGER_KEY = 'perPage';               // C7: older pager tables

  console.log(TAG, 'v1.0.1 loaded on', location.href);

  // ---- A. Seed the saved size once (before Angular reads it) ---------------
  try {
    if (DEFAULT_SIZE && !localStorage.getItem(SEED_KEY)) {
      localStorage.setItem(AG_KEY, String(DEFAULT_SIZE));
      localStorage.setItem(PAGER_KEY, String(DEFAULT_SIZE));
      localStorage.setItem(SEED_KEY, '1');
      console.log(TAG, 'seeded page size', DEFAULT_SIZE);
    }
  } catch (e) { /* storage blocked: dropdowns still get the options */ }

  // ---- B. Dropdowns ---------------------------------------------------------
  function optionTexts(sel) {
    return Array.prototype.map.call(sel.options, function (o) { return o.textContent.trim(); });
  }

  // Returns 'ag' | 'pager' | 'plain' for a page-size select, or null.
  function kindOf(sel) {
    var texts = optionTexts(sel);
    if (texts.length < 2 || texts.length > 8) return null;
    if (!texts.every(function (t) { return /^\d+$/.test(t); })) return null;
    if (texts.indexOf('10') === -1) return null;

    var lbl = sel.previousElementSibling;
    if (lbl && lbl.tagName === 'LABEL' && /^page\s*size$/i.test(lbl.textContent.trim())) {
      // ag-grid's select has plain options (value = text); Teams uses ngValue ("0: 10").
      return sel.options[0].value === sel.options[0].textContent.trim() ? 'ag' : 'plain';
    }
    // Older pager: <ul> with Prev / Next / Last links (Angular strips whitespace, so match link text).
    var ul = sel.closest('ul');
    if (ul) {
      var links = Array.prototype.map.call(ul.querySelectorAll('a'), function (a) { return a.textContent.trim(); });
      if (links.indexOf('Next') !== -1 && links.indexOf('Last') !== -1) return 'pager';
    }
    return null;
  }

  function savedFor(kind) {
    try {
      if (kind === 'ag') return localStorage.getItem(AG_KEY);
      if (kind === 'pager') return localStorage.getItem(PAGER_KEY);
    } catch (e) {}
    return null;
  }

  var synced = typeof WeakSet === 'function' ? new WeakSet() : null;

  function enhance(sel) {
    var kind = kindOf(sel);
    if (!kind) return;
    var wasBlank = sel.selectedIndex === -1;

    var have = optionTexts(sel);
    EXTRA_SIZES.forEach(function (n) {
      if (have.indexOf(String(n)) !== -1) return;
      var o = document.createElement('option');
      o.value = String(n);          // Angular's select accessor passes an unknown value through as-is
      o.textContent = String(n);
      o.setAttribute('data-malpa-pagesize', '1');
      sel.appendChild(o);
    });

    // Angular wrote the saved value (e.g. "200") before our option existed, so the
    // select was blank, and appending an option makes the browser show the first
    // one ("10") instead. The table really is at the saved size (C7 read it from
    // localStorage), so show that. Once per element, so we never fight the user.
    if (synced && synced.has(sel)) return;
    if (synced) synced.add(sel);
    var want = savedFor(kind);
    if (want && (wasBlank || EXTRA_SIZES.indexOf(Number(want)) !== -1) &&
        optionTexts(sel).indexOf(want) !== -1 && sel.value !== want) {
      sel.value = want;
    }
  }

  var scanQueued = false;
  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(function () {
      scanQueued = false;
      var sels = document.querySelectorAll('select');
      for (var i = 0; i < sels.length; i++) {
        try { enhance(sels[i]); } catch (e) { console.warn(TAG, e); }
      }
    }, 150);
  }

  function startObserver() {
    new MutationObserver(queueScan).observe(document.documentElement, { childList: true, subtree: true });
    queueScan();
  }
  if (document.documentElement) startObserver();
  else document.addEventListener('readystatechange', startObserver, { once: true });

  // ---- C. Cap guard ---------------------------------------------------------
  function askedSize(url) {
    var m = /[?&](?:per-page|perpage)=(\d+)/.exec(url);
    return m ? Number(m[1]) : null;
  }
  function askedPage(url) {
    var m = /[?&]page=(\d+)/.exec(url);
    return m ? Number(m[1]) : 1;
  }
  function rowCount(body) {
    if (Array.isArray(body)) return body.length;
    if (body && typeof body === 'object') {
      var keys = ['data', 'items', 'rows', 'body'];
      for (var i = 0; i < keys.length; i++) if (Array.isArray(body[keys[i]])) return body[keys[i]].length;
    }
    return null;
  }

  // header(name) returns the value or null. Exported for testing as window.__malpaPageSizeCheck.
  function servedBelowAsked(url, status, header, body) {
    var asked = askedSize(url);
    if (EXTRA_SIZES.indexOf(asked) === -1) return null;
    if (status < 200 || status >= 300) return null;

    var perHdr = Number(header('x-pagination-per-page')) || null;
    if (perHdr && perHdr < asked) return perHdr;

    var totalHdr = header('x-pagination-total-count');
    var rows = rowCount(body);
    if (rows == null || totalHdr == null || totalHdr === '') return null;
    var total = Number(totalHdr);
    var expected = Math.min(asked, Math.max(0, total - (askedPage(url) - 1) * asked));
    return rows < expected ? rows : null;
  }

  var warned = {};
  function warn(url, asked, served) {
    var key = url.split('?')[0] + '|' + (/[?&]r=([^&]+)/.exec(url) || [])[1];
    if (warned[key]) return;
    warned[key] = true;
    console.warn(TAG, 'C7 served', served, 'rows for per-page=' + asked, url);

    function show() {
      var bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147483647;' +
        'background:#c62828;color:#fff;font:14px/1.4 sans-serif;padding:10px 40px 10px 16px;' +
        'border-radius:0 0 6px 6px;box-shadow:0 2px 8px rgba(0,0,0,.3);max-width:720px;';
      bar.textContent = 'This C7 table only returns ' + served + ' rows a page, not ' + asked +
        '. Pages 2 and on may skip rows. Set Page Size to ' + (served >= 50 ? 50 : served) +
        ' or less for this table.';
      var x = document.createElement('span');
      x.textContent = '×';
      x.title = 'Dismiss';
      x.style.cssText = 'position:absolute;right:12px;top:6px;cursor:pointer;font-size:20px;';
      x.onclick = function () { bar.remove(); };
      bar.appendChild(x);
      document.body.appendChild(bar);
    }
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show, { once: true });
  }

  function parse(x) {
    if (typeof x !== 'string') return x;
    try { return JSON.parse(x); } catch (e) { return null; }
  }

  // XHR (Angular HttpClient). getAllResponseHeaders only lists headers CORS exposes,
  // so it never logs "Refused to get unsafe header".
  var XO = XMLHttpRequest.prototype.open;
  var XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__malpaPsUrl = String(url);
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this, url = xhr.__malpaPsUrl;
    if (url && EXTRA_SIZES.indexOf(askedSize(url)) !== -1) {
      xhr.addEventListener('load', function () {
        try {
          var raw = xhr.getAllResponseHeaders() || '';
          var header = function (name) {
            var m = new RegExp('^' + name + ':\\s*(.*)$', 'im').exec(raw);
            return m ? m[1].trim() : null;
          };
          var body = (xhr.responseType === '' || xhr.responseType === 'text') ? parse(xhr.responseText) : xhr.response;
          var served = servedBelowAsked(url, xhr.status, header, body);
          if (served) warn(url, askedSize(url), served);
        } catch (e) { /* never break C7 */ }
      });
    }
    return XS.apply(this, arguments);
  };

  // fetch (in case some screens use it)
  if (window.fetch) {
    var F = window.fetch;
    window.fetch = function (input) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var p = F.apply(this, arguments);
      if (EXTRA_SIZES.indexOf(askedSize(url)) !== -1) {
        p.then(function (res) {
          res.clone().text().then(function (t) {
            var served = servedBelowAsked(url, res.status, function (n) { return res.headers.get(n); }, parse(t));
            if (served) warn(url, askedSize(url), served);
          }).catch(function () {});
        }).catch(function () {});
      }
      return p;
    };
  }

  window.__malpaPageSizeCheck = servedBelowAsked;
})();

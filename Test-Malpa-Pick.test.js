/* Test-Malpa-Pick.test.js - offline harness for Test-Malpa-Pick.user.js (4.14.0).
 *   node Test-Malpa-Pick.test.js      -> must print ALL n CHECKS PASSED
 * Built from the c7-userscript skill's template. Section 4 is the SIBP/MIBP
 * re-scan incident; keep it green before every release.
 *
 * Offline test harness for a Canary7 userscript.
 *
 * Runs the REAL script source in a stubbed DOM under node - no browser, no jsdom
 * (jsdom hangs in some sandboxes). Assert pure logic and DOM wiring against API
 * payloads captured from live probing, so a regression is caught before the
 * fleet auto-updates.
 *
 * Usage:  cp this file next to your script, set SCRIPT and GLOBAL, run `node test-<name>.js`
 *
 * The script must expose its internals for testing, e.g.:
 *     window.__malpaThing = { VERSION, State, open, close, groupRows, validateRow, ... };
 */
const fs = require('fs');
const vm = require('vm');

const SCRIPT = __dirname + '/Test-Malpa-Pick.user.js';
const GLOBAL = '__malpaPick';

const src = fs.readFileSync(SCRIPT, 'utf8');

/* ------------------------------------------------------------------ DOM stub */
function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [], style: {}, dataset: {}, _text: '', _html: '',
    id: '', checked: false, disabled: false, value: '',
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    insertBefore(c, ref) {
      const i = this.children.indexOf(ref);
      if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
      c.parentNode = this; return c;
    },
    get firstChild() { return this.children[0] || null; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    getBoundingClientRect() { return { top: 55, left: 0, width: 480, height: 700 }; },
    _listeners: null,
    addEventListener(type, fn) {
      (this._listeners || (this._listeners = {}));
      (this._listeners[type] || (this._listeners[type] = [])).push(fn);
    },
    removeEventListener(type, fn) {
      if (this._listeners && this._listeners[type]) {
        this._listeners[type] = this._listeners[type].filter((f) => f !== fn);
      }
    },
    _fire(type) {
      const ev = { type, target: this, currentTarget: this,
        preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, closest: () => null };
      ((this._listeners && this._listeners[type]) || []).slice().forEach((f) => f.call(this, ev));
    },
    _fireKey(k) {
      const ev = { type: 'keydown', key: k, keyCode: k === 'Enter' ? 13 : 0,
        target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, closest: () => null };
      ((this._listeners && this._listeners.keydown) || []).slice().forEach((f) => f.call(this, ev));
    },
    click() { this._fire('click'); },
    focus() {}, blur() {}, setAttribute() {}, getAttribute() { return null; }, closest() { return null; },
    querySelector(sel) { return findIn(this, sel); },
    querySelectorAll(sel) { return findAllIn(this, sel); },
    contains() { return false; },
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
    set textContent(v) { this._text = String(v); this.children = []; },
    get innerText() { return this.textContent; },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); this.children = parseStub(v); },
  };
  // Real elements keep className and classList in sync; the stub must too.
  Object.defineProperty(el, 'className', {
    get() { return [...el.classList._s].join(' '); },
    set(v) { el.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); },
    enumerable: true,
  });
  return el;
}

// Parses only what innerHTML needs here: tags plus id / class / data-* attributes.
function parseStub(html) {
  const out = [];
  const re = /<(\w+)([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const el = makeEl(m[1]);
    const attrs = m[2];
    const id = /id="([^"]+)"/.exec(attrs);
    const cls = /class="([^"]+)"/.exec(attrs);
    if (id) el.id = id[1];
    if (cls) el.className = cls[1];
    let d; const dataRe = /data-([\w-]+)="([^"]*)"/g;
    while ((d = dataRe.exec(attrs))) {
      el.dataset[d[1].replace(/-([a-z])/g, (_x, c) => c.toUpperCase())] = d[2];
    }
    out.push(el);
  }
  return out;
}

function walk(root, fn) { for (const c of root.children || []) { fn(c); walk(c, fn); } }
// Attribute filters are dropped; descendant selectors match on their last compound.
function matchesCompound(el, sel) {
  const m = /^([a-zA-Z]*)((?:[.#][\w-]+)*)$/.exec(String(sel).replace(/\[[^\]]*\]/g, ''));
  if (!m) return false;
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  for (const tok of m[2].match(/[.#][\w-]+/g) || []) {
    if (tok[0] === '#') { if (el.id !== tok.slice(1)) return false; }
    else if (!el.classList.contains(tok.slice(1))) return false;
  }
  return true;
}
function matches(el, sel) {
  return String(sel).split(',').some((one) => {
    const parts = one.trim().split(/\s+/).filter(Boolean);
    return parts.length ? matchesCompound(el, parts[parts.length - 1]) : false;
  });
}
function findIn(root, sel) { let hit = null; walk(root, (e) => { if (!hit && matches(e, sel)) hit = e; }); return hit; }
function findAllIn(root, sel) { const h = []; walk(root, (e) => { if (matches(e, sel)) h.push(e); }); return h; }

const documentStub = (() => {
  const doc = makeEl('document');
  doc.head = makeEl('head'); doc.body = makeEl('body');
  doc.appendChild(doc.head); doc.appendChild(doc.body);
  doc.readyState = 'complete'; doc.visibilityState = 'visible'; doc.activeElement = null;
  doc.createElement = (t) => makeEl(t);
  doc.getElementById = (id) => findIn(doc, '#' + id);
  doc.querySelector = (s) => findIn(doc, s);
  doc.querySelectorAll = (s) => findAllIn(doc, s);
  doc.addEventListener = () => {}; doc.removeEventListener = () => {};
  doc.contains = (n) => { let hit = false; walk(doc, (e) => { if (e === n) hit = true; }); return hit; };
  return doc;
})();

/** C7's Angular sidebar, so injectNav() has a real target. */
function addFakeSidebar() {
  const sidebar = makeEl('div'); sidebar.className = 'sidebar';
  const nav = makeEl('nav');
  const ul = makeEl('ul'); ul.className = 'nav';
  const li = makeEl('li'); li.className = 'nav-item'; li.textContent = 'Inventory';
  ul.appendChild(li); nav.appendChild(ul); sidebar.appendChild(nav);
  documentStub.body.appendChild(sidebar);
  return ul;
}

/** C7's tab bar + content with two tabs already open. */
function addFakeTabs() {
  const bar = makeEl('ul'); bar.className = 'nav nav-tabs';
  const panes = makeEl('div'); panes.className = 'tab-content';
  const mk = (name, active) => {
    const li = makeEl('li'); li.className = 'nav-item' + (active ? ' active' : '');
    const a = makeEl('a'); a.className = 'nav-link' + (active ? ' active' : '');
    a.textContent = name; li.appendChild(a); bar.appendChild(li);
    const pane = makeEl('div'); pane.className = 'tab-pane' + (active ? ' active' : '');
    pane.id = 'pane-' + name; panes.appendChild(pane);
    return { li, pane };
  };
  const first = mk('Shipments', false), second = mk('Enquiry', true);
  documentStub.body.appendChild(bar); documentStub.body.appendChild(panes);
  return { bar, panes, first, second };
}

/* --------------------------------------------------------------- run the script */
function MutationObserverStub() {}
MutationObserverStub.prototype.observe = function () {};
MutationObserverStub.prototype.disconnect = function () {};

const sandbox = {
  console, document: documentStub,
  localStorage: memStore(), sessionStorage: memStore(),
  location: { href: 'https://malpa.canary7.com/index.php', origin: 'https://malpa.canary7.com' },
  navigator: { clipboard: null },              // no vibrate - script must cope
  MutationObserver: MutationObserverStub,
  XMLHttpRequest: function () {},
  fetch: () => Promise.reject(new Error('no network in harness')),
  // Timers fire on the next macrotask so the script's sleeps/retries resolve
  // without real waiting; intervals (busy clock, focus poll) stay inert.
  setTimeout: (fn) => { setImmediate(() => { try { fn(); } catch (e) {} }); return 0; },
  clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  addEventListener: () => {}, removeEventListener: () => {},
  encodeURIComponent, URL, Date, Math, JSON, Number, String, Array, Object, Boolean, Error, Map, Set,
  // AudioContext deliberately absent - the script must degrade quietly.
};
function memStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
           removeItem: (k) => m.delete(k),
           key: (i) => [...m.keys()][i], get length() { return m.size; } };
}
sandbox.window = sandbox;
sandbox.XMLHttpRequest.prototype = { open() {}, setRequestHeader() {} };
sandbox.localStorage.setItem('access_token', 'ey' + 'x'.repeat(40) + '.abc.def');

const fakeNavUl = addFakeSidebar();
vm.createContext(sandbox);
try { vm.runInContext(src, sandbox, { filename: SCRIPT }); }
catch (e) { console.log('script threw while booting: ' + e.message); }

const T = sandbox.window[GLOBAL];
if (!T) { console.log('FATAL: script did not expose window.' + GLOBAL); process.exit(1); }

/* ------------------------------------------------------------------- assertions */
let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '\n        got  ' + g + '\n        want ' + w); }
};
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  (' + detail + ')' : '')); }
};
const flush = () => new Promise((r) => setImmediate(r));   // let awaits settle

/** Stub the network. Route by URL and record what was posted. */
/* ------------------------------------------------------------- network stub
 * Every route can be a value, a function(url, init) -> value, or a Response-
 * like { __status, __body, __headers } to fake an HTTP error / pagination.
 * `deferred(frag)` makes the NEXT call to that route hang until released, so a
 * test can scan while a perform is still in flight.
 */
const calls = [], posted = [];
let routes = {};
const held = {};                     // frag -> { resolve, reject } of a hung call
const holdNext = new Set();
function stubFetch(r) { routes = r; }
function deferred(frag) { holdNext.add(frag); }
function release(frag, value) { const h = held[frag]; delete held[frag]; h.resolve(value); }

function mkRes(v) {
  if (v && v.__status) {
    return { ok: v.__status < 400, status: v.__status, headers: { get: () => null },
             json: () => Promise.resolve(v.__body) };
  }
  const hdr = (v && v.__headers) || {};
  const body = v && v.__headers ? v.__body : v;
  return { ok: true, status: 200, headers: { get: (k) => hdr[k.toLowerCase()] ?? null },
           json: () => Promise.resolve(body) };
}
sandbox.fetch = (url, init) => {
  calls.push({ url, method: (init && init.method) || 'GET' });
  if (init && init.body) { try { posted.push({ url, body: JSON.parse(init.body) }); } catch {} }
  for (const [frag, value] of Object.entries(routes)) {
    if (!url.includes(frag)) continue;
    if (holdNext.has(frag)) {
      holdNext.delete(frag);
      return new Promise((resolve, reject) => { held[frag] = { resolve: (v) => resolve(mkRes(v)), reject }; });
    }
    const v = typeof value === 'function' ? value(url, init) : value;
    return Promise.resolve(mkRes(v));
  }
  return Promise.resolve(mkRes([]));
};
const n = (frag, method) => calls.filter(c => c.url.includes(frag) && (!method || c.method === method)).length;
const reset = () => { calls.length = 0; posted.length = 0; };

/* --------------------------------------------------------------- fixtures */
const tabView = makeEl('div'); tabView.id = 'mpk-tab-view';
const rootEl  = makeEl('div'); rootEl.id = 'mpk-root';
tabView.appendChild(rootEl); documentStub.body.appendChild(tabView);

const ITEM = { item_code: 'GUT-FIBRE-1', description: 'Gut fibre',
  itemUnitOfMeasures: [{ id: 7, itemUnitOfMeasureReference: [{ reference: '9300000000011' }] }] };
const groupInstr = (id, gid) => ({
  id, job_id: 2077877, job_instruction_group_id: gid, reference_number: '#134589',
  quantity: 1, item_id: 28943, from_location_id: 77705,
  fromLocation: { location_code: 'A12-B24-S12' }, item: ITEM, itemUnitOfMeasure: { id: 7, factor: 1 },
});
const I1 = groupInstr(3437000, 75831);
const I2 = groupInstr(3437100, 75832);

function setupGroupPick() {
  T.Busy.end();
  const S = T.State;
  S.reset();
  S.profile = { id: 48, name: 'MIBP' };
  S.jobId = 2077877;
  S.instruction = I1;
  S.groupRecord = { units: 100, updated_at: 1795734966 };
  S.groupRecordFailed = false;
  S.containerTypes = [{ container_number_prefix: 'B' }, { container_number_prefix: 'W' }];
  S.containerPrefixes = ['B', 'W'];
  S.allInstructions = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, job_instruction_group_id: 75831 }));
  S.pickProgress = { current: 1, total: 5 };
  S.scanCount = 0;
  T.clearInflight();
  T.renderContainerScan();
  S.scanCount = 100;
  reset();
}

const tick = async (k = 6) => { for (let i = 0; i < k; i++) await flush(); };

(async () => {
  console.log('\n1. Boot');
  ok('script exposed its internals', !!T);
  eq('@version matches the VERSION constant', (/@version\s+([\d.]+)/.exec(src) || [])[1], T.VERSION);
  ok('sidebar nav item injected', !!sandbox.document.getElementById('mpk-nav'));
  ok('source is pure ASCII (TC51 copy/paste rule)', !/[^\x00-\x7F]/.test(src));

  console.log('\n2. CSS');
  T.injectCSS();
  const css = (sandbox.document.getElementById('mpk-styles') || {}).textContent || '';
  eq('every /* has a matching */ (4.13 swallowed the flash rules)',
     (css.match(/\/\*/g) || []).length, (css.match(/\*\//g) || []).length);
  ok('.mpk-flash is a live rule, not inside a comment',
     /\*\/\s*\.mpk-flash\s*\{/.test(css.replace(/\/\*[\s\S]*?\*\//g, '*/')));
  ok('portal coral token present', css.includes('--mpk-brand: #f26247'));
  ok('text on coral is the dark on-brand token, never white',
     /\.mpk-btn-primary[^{]*\{[^}]*color:\s*var\(--mpk-on-brand\)/.test(css) && css.includes('--mpk-on-brand: #14153f'));
  ok('tokens scoped to the panel, not :root', !/:root\s*\{/.test(css));
  ok('busy overlay styled', css.includes('#mpk-busy {'));

  console.log('\n3. Summary list - slim + paged');
  stubFetch({
    'job/job-instruction&job_id=9&per-page=400': (url) => url.includes('page=1')
      ? { __headers: { 'x-pagination-page-count': '2' },
          __body: [{ id: 1, reference_number: 'A', quantity: 2, job_instruction_group_id: 5 },
                   { id: 2, reference_number: 'B', quantity: 3, job_instruction_group_id: 5 }] }
      : [{ id: 2, reference_number: 'B', quantity: 3, job_instruction_group_id: 5 },
         { id: 3, reference_number: 'C', quantity: 1, job_instruction_group_id: null }],
  });
  reset();
  const all = await T.fetchJobInstructions(9);
  ok('asks for fields=, not expand=', calls[0] && calls[0].url.includes('fields=') && !calls[0].url.includes('expand='));
  ok('asks for C7\'s 400-row page', calls[0].url.includes('per-page=400'));
  eq('reads page 2 when x-pagination-page-count says 2', n('page=2'), 1);
  eq('dedupes the re-served row', all.map(i => i.id), [1, 2, 3]);
  eq('a whole group counts as one pick', T.countPickActions(all), 2);

  console.log('\n4. THE INCIDENT - re-scanning the tote while group-perform runs');
  stubFetch({
    'group-perform': { job_instruction: { id: I2.id, job_instruction_group_id: 75832 } },
    'get-job-instructions': [I2],
    'get-job-instruction-groups': [{ units: 40, updated_at: 2 }],
    'change-sequence': {},
  });
  setupGroupPick();
  deferred('group-perform');
  const p = T.onContainerScan('B197');
  await tick(20);
  ok('busy lock is up while Canary7 works', T.Busy.isActive());
  ok('overlay painted', !!sandbox.document.getElementById('mpk-busy'));
  ok('in-flight ledger written BEFORE the answer', !!T.loadInflight() && T.loadInflight().tote === 'B197');
  for (let i = 0; i < 5; i++) T._onScan('B197');
  T._onScan('9300000000011');
  eq('six panicked scans -> still ONE group-perform', n('group-perform', 'POST'), 1);
  eq('every one of them was answered (ignored count)', T.Busy.active.ignored, 6);
  ok('Back is refused while busy', (() => {
    const before = T.Busy.active.ignored;
    const back = sandbox.document.getElementById('mpk-back-btn'); back && back.click();
    return T.Busy.active.ignored === before + 1 && T.State.screen === 'PERFORMING';
  })());
  eq('closing the tab is refused while busy', T.closeUI(), false);
  release('group-perform', { job_instruction: { id: I2.id, job_instruction_group_id: 75832 } });
  await p; await tick();
  ok('lock released after the next pick is painted', !T.Busy.isActive());
  eq('now on the next instruction', T.State.instruction && T.State.instruction.id, I2.id);
  eq('screen is the item step', T.State.screen, 'PICK_ITEM');
  ok('ledger cleared', !T.loadInflight());
  eq('still exactly one group-perform', n('group-perform', 'POST'), 1);
  eq('picking_qty is the whole group', posted.find(x => x.url.includes('group-perform')).body.picking_qty, 100);

  console.log('\n5. Gateway timeout, but Canary7 DID finish -> no retry, carry on');
  stubFetch({
    'group-perform': { __status: 504, __body: {} },
    'get-job-instructions': [I2],
    'get-job-instruction-groups': [{ units: 40, updated_at: 2 }],
    'change-sequence': {},
  });
  setupGroupPick();
  await T.onContainerScan('B197'); await tick();
  eq('no blind retry of the perform', n('group-perform', 'POST'), 1);
  ok('reconciled via a read of the current instruction', n('get-job-instructions') >= 1);
  eq('advanced to the next instruction', T.State.instruction.id, I2.id);
  ok('unlocked', !T.Busy.isActive());

  console.log('\n6. Business rejection, Canary7 still on this group -> unlock for a real re-scan');
  stubFetch({
    'group-perform': { __status: 500, __body: { code: 1022, message: 'Container belongs to another shipment' } },
    'get-job-instructions': [I1],
  });
  setupGroupPick();
  await T.onContainerScan('B197'); await tick();
  eq('one perform, one verify', [n('group-perform', 'POST'), n('get-job-instructions')], [1, 1]);
  eq('back on the tote step', T.State.screen, 'SCAN_CONTAINER');
  ok('unlocked', !T.Busy.isActive());
  ok('tells them which tote problem', /another shipment/.test(T.R.scanFb && T.R.scanFb.textContent));
  ok('ledger cleared', !T.loadInflight());

  console.log('\n7. Unknown failure that never confirms -> waits, then unlocks');
  stubFetch({ 'group-perform': { __status: 502, __body: {} }, 'get-job-instructions': [I1] });
  setupGroupPick();
  await T.onContainerScan('B197'); await tick();
  ok('checked Canary7 repeatedly before giving up', n('get-job-instructions') > 3);
  eq('still only one perform', n('group-perform', 'POST'), 1);
  eq('unlocked onto the tote step', [T.Busy.isActive(), T.State.screen], [false, 'SCAN_CONTAINER']);

  console.log('\n8. Wrong-step scans get an answer, not silence');
  stubFetch({});
  setupGroupPick();
  T.onContainerScan('9300000000011');
  ok('item scanned on the tote step -> "already scanned" nudge',
     /already scanned/i.test(T.R.scanFb.textContent) && T.R.scanFb.className.includes('warn'));
  eq('and no perform', n('perform'), 0);
  T.onContainerScan('ZZZ-not-a-tote');
  ok('junk on the tote step names the barcode', /Not a tote: ZZZ/.test(T.R.scanFb.textContent));
  T.State.lastTote = { tote: 'B197', instrId: I1.id, at: Date.now() };
  T.renderPickScreen(I2);
  T.State.groupRecord = { units: 40 };
  T.onItemScan('B197');
  ok('the just-used tote on the item step -> "already done"',
     /already done/i.test(T.R.scanFb.textContent));

  console.log('\n9. Reload mid-perform -> reconcile before any scan');
  stubFetch({ 'get-job-instructions': [I2], 'get-job-instruction-groups': [{ units: 40 }], 'change-sequence': {} });
  setupGroupPick();
  T.saveInflight({ instrId: I1.id, groupId: 75831, jobId: 2077877, tote: 'B197' });
  const took = await T.reconcileInflightOnEntry(); await tick();
  ok('took over the screen', took === true);
  eq('found the move had landed and moved on', T.State.instruction.id, I2.id);
  eq('without performing again', n('perform', 'POST'), 0);

  console.log('\n10. Double-tap Start does not assign two jobs');
  stubFetch({ 'get-job-instructions': [I1], 'job/job-instruction&job_id': [] });
  T.State.reset();
  T.State.profiles = [{ id: 48, name: 'MIBP', initiation_method: 1 }];
  const sel = makeEl('select'); sel.value = '48'; T.R.profileSel = sel; T.R.startBtn = makeEl('button');
  reset();
  deferred('get-job-instructions');
  const s1 = T.onStartPicking(); const s2 = T.onStartPicking();
  await tick(20);
  release('get-job-instructions', [I1]);
  await s1; await s2; await tick();
  eq('one get-job-instructions call', n('get-job-instructions'), 1);
  ok('group record prefetched from the summary screen', T.groupCache.has(75831));

  console.log('\n11. Short pick goes through the same lock');
  stubFetch({ 'pick-short': { job_instruction: null } });
  setupGroupPick();
  T.renderPickScreen(I1);
  deferred('pick-short');
  const sp = T.onShortPickConfirm(I1, 'Damaged');
  await tick(20);
  T._onScan('9300000000011');
  ok('scan during short pick is swallowed', T.Busy.isActive() && T.Busy.active.ignored === 1);
  release('pick-short', { job_instruction: null });
  await sp; await tick();
  eq('job complete after the last short pick', T.State.screen, 'JOB_COMPLETE');
  eq('one pick-short', n('pick-short', 'POST'), 1);

  console.log('\n' + (fail === 0 ? 'ALL ' + pass + ' CHECKS PASSED' : pass + ' passed, ' + fail + ' FAILED'));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('HARNESS CRASH: ' + (e && e.stack || e)); process.exit(1); });

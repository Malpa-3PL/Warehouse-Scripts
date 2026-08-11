// ==UserScript==
// @name         Packing Guide Sidebar
// @namespace    https://malpa.canary7.com
// @version      18.1
// @updateURL    https://raw.githubusercontent.com/Malpa-3PL/Warehouse-Scripts/main/malpa-packguide.user.js
// @downloadURL  https://raw.githubusercontent.com/Malpa-3PL/Warehouse-Scripts/main/malpa-packguide.user.js
// @description  Per-client operational packing guides for the Malpa Pack window — auto-selects the company being packed
// @author       Malpa 3PL
// @match        https://*.canary7.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.retool.com
// @run-at       document-idle
// ==/UserScript==

(function () {

    'use strict';

    console.log('[Packing Guides] Script booting... v18.0');

    /*
    ========================================================
    CONFIG
    ========================================================
    */

    const SIDEBAR_WIDTH = 420;

    const WORKFLOW_URL =
        'https://api.retool.com/v1/workflows/6b5ceb37-3b77-46b2-b547-a674bb7c993a/startTrigger';

    const API_KEY =
        'retool_wk_5690467eb2ed474b9c5b6b9666057e9c';

    /*
    --------------------------------------------------------
    MANUAL COMPANY CODE OVERRIDES

    The packing-guide table has NO company_code column, so the
    script matches the shipment's company code / name against
    client_name. That works for codes like HBC / GOAT / PESA,
    but not for e.g. "BTF" -> "Boob to Food".

    If the console logs:
        [Packing Guides] NO MATCH for company "XXX"
    add a line here:  'xxx': 'Boob to Food',

    Left side  = company code from Canary7 (lowercase).
    Right side = client_name EXACTLY as it appears in the guide.
    --------------------------------------------------------
    */

    const CODE_OVERRIDES = {
        // 'btf': 'Boob to Food',
        // 'ctm': 'Compare the Market',
        // 'tfm': 'The Flag Man',
    };

    /*
    --------------------------------------------------------
    Endpoints that carry the company of the shipment being
    packed. Add more substrings here if needed.
    --------------------------------------------------------
    */

    const TARGET_ENDPOINTS = [
        'get-pack-container',
        'shipment-container',
        'pack-container'
    ];

    /*
    ========================================================
    STATE  (module scope, survives sidebar rebuilds)
    ========================================================
    */

    let packingGuides = {};
    let guidesLoaded = false;
    let guidesLoading = false;

    // Last company detected from the shipment API, kept so it can be
    // re-applied when the guides finish loading OR the sidebar rebuilds.
    let lastDetected = null;   // { candidates: [...], matchedKey: string|null }

    const PAGE =
        (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;

    /*
    ========================================================
    HELPERS
    ========================================================
    */

    // "Boob to Food" -> "boobtofood"
    function norm(s) {
        return String(s || '')
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');
    }

    // "Boob to Food" -> "btf"   |   "Compare the Market" -> "ctm"
    function initials(s) {
        return String(s || '')
            .toLowerCase()
            .split(/[^a-z0-9]+/i)
            .filter(Boolean)
            .map(w => w[0])
            .join('');
    }

    // Recursively find the first array of guide rows anywhere in the payload.
    // Retool's startTrigger response shape varies (data.body.rows, output, etc.)
    function findGuideRows(obj, depth) {

        depth = depth || 0;

        if (!obj || typeof obj !== 'object' || depth > 8) {
            return null;
        }

        if (Array.isArray(obj)) {

            const first = obj[0];

            if (
                first &&
                typeof first === 'object' &&
                (
                    'client_name' in first ||
                    'pack_into' in first ||
                    'client' in first
                )
            ) {
                return obj;
            }

            for (const item of obj) {
                const found = findGuideRows(item, depth + 1);
                if (found) return found;
            }

            return null;
        }

        for (const k of Object.keys(obj)) {
            const found = findGuideRows(obj[k], depth + 1);
            if (found) return found;
        }

        return null;
    }

    // Recursively pull the first string value for any of the given keys.
    function deepFindValues(obj, keys, out, depth) {

        out = out || [];
        depth = depth || 0;

        if (!obj || typeof obj !== 'object' || depth > 8) {
            return out;
        }

        for (const k of Object.keys(obj)) {

            const v = obj[k];

            if (
                keys.includes(k) &&
                typeof v === 'string' &&
                v.trim()
            ) {
                if (!out.includes(v.trim())) {
                    out.push(v.trim());
                }
            } else if (v && typeof v === 'object') {
                deepFindValues(v, keys, out, depth + 1);
            }
        }

        return out;
    }

    /*
    ========================================================
    LOAD GUIDES
    ========================================================
    */

    function loadPackingGuides() {

        if (guidesLoading || guidesLoaded) {

            // Already have (or are getting) the data - just repaint.
            if (guidesLoaded) {
                populateDropdown();
                reapplyDetection();
            }

            return;
        }

        guidesLoading = true;

        console.log('[Packing Guides] Loading packing guides...');

        GM_xmlhttpRequest({

            method: 'POST',

            url: WORKFLOW_URL,

            headers: {
                'Content-Type': 'application/json',
                'X-Workflow-Api-Key': API_KEY
            },

            data: JSON.stringify({}),

            onload: function (response) {

                guidesLoading = false;

                console.log(
                    '[Packing Guides] Workflow response:',
                    response.status
                );

                if (response.status < 200 || response.status >= 300) {
                    showError('Failed to load packing guides.');
                    return;
                }

                try {

                    const result = JSON.parse(response.responseText);

                    const rows = findGuideRows(result) || [];

                    console.log('[Packing Guides] Rows found:', rows.length);

                    if (!rows.length) {
                        console.warn(
                            '[Packing Guides] Could not locate rows in payload:',
                            result
                        );
                        showError('No packing guides returned.');
                        return;
                    }

                    packingGuides = {};

                    rows.forEach(row => {

                        const clientName =
                            (row.client_name || row.client || '').trim();

                        if (!clientName) {
                            return;
                        }

                        const key = clientName.toLowerCase();

                        packingGuides[key] = {
                            client: clientName,
                            normKey: norm(clientName),
                            initialsKey: initials(clientName),
                            packInto: row.pack_into || '',
                            packingMethod: row.packing_method || '',
                            voidfill: row.voidfill || '',
                            considerations: row.considerations || '',
                            thankyou: row.thankyou_card_required === true
                        };
                    });

                    guidesLoaded = true;

                    populateDropdown();

                    // v18: do NOT auto-render the first client.
                    // Stay on the default screen until a company is detected
                    // or the packer picks one manually.
                    if (!reapplyDetection()) {
                        renderEmptyState();
                    }

                } catch (err) {

                    console.error('[Packing Guides] Parse error:', err);
                    showError('Failed to parse response.');
                }
            },

            onerror: function (err) {

                guidesLoading = false;

                console.error('[Packing Guides] Request failed:', err);

                showError('Request failed.');
            }
        });
    }

    /*
    ========================================================
    ERROR / EMPTY STATES
    ========================================================
    */

    function showError(message) {

        console.error('[Packing Guides] ERROR:', message);

        const container = document.getElementById('packing-guide-content');

        if (!container) return;

        container.innerHTML = `
            <div class="tm-error">
                ${message}
            </div>
        `;
    }

    function renderEmptyState() {

        const container = document.getElementById('packing-guide-content');

        if (!container) return;

        container.innerHTML = `
            <div class="tm-empty">
                No client selected.<br>
                Open a shipment in the pack window, or choose a client above.
            </div>
        `;

        setSubtitle('Live operational packing instructions');
    }

    function setSubtitle(text) {

        const el = document.querySelector('.tm-sidebar-subtitle');

        if (el) {
            el.textContent = text;
        }
    }

    /*
    ========================================================
    INIT
    ========================================================
    */

    function init() {

        console.log('[Packing Guides] Initialising UI...');

        if (document.getElementById('tm-sidebar')) {
            console.log('[Packing Guides] Sidebar already exists');
            return;
        }

        // Inject styles once only (v17 re-injected on every self-heal).
        if (!document.getElementById('tm-sidebar-styles')) {

            const style = document.createElement('style');

            style.id = 'tm-sidebar-styles';

            style.innerHTML = `

                #tm-sidebar {
                    font-family: Inter, Roboto, sans-serif;
                    background: #ffffff;
                    color: #111827;
                    border-left: 1px solid #e5e7eb;
                }

                #tm-sidebar * {
                    box-sizing: border-box;
                }

                .tm-sidebar-header {
                    padding-bottom: 18px;
                    margin-bottom: 18px;
                    border-bottom: 1px solid #e5e7eb;
                }

                .tm-logo {
                    width: 145px;
                    margin-left: 100px;
                    margin-bottom: 18px;
                    display: block;
                }

                .tm-sidebar-title {
                    font-size: 42px;
                    line-height: 1;
                    font-weight: 700;
                    letter-spacing: -1px;
                    color: #111827;
                    margin-left: 40px;
                    margin-bottom: 10px;
                }

                .tm-sidebar-subtitle {
                    font-size: 15px;
                    line-height: 1.45;
                    color: #6b7280;
                    margin-left: 40px;
                }

                #packing-client-select {
                    width: 100%;
                    height: 52px;
                    border: 1px solid #d1d5db;
                    border-radius: 12px;
                    background: white;
                    padding: 0 16px;
                    font-size: 15px;
                    color: #111827;
                    outline: none;
                    margin-bottom: 18px;
                }

                .tm-guide-wrapper {
                    display: flex;
                    flex-direction: column;
                    gap: 14px;
                    padding-bottom: 14px;
                }

                .tm-guide-card {
                    display: flex;
                    align-items: flex-start;
                    gap: 16px;
                    background: white;
                    border: 1px solid #e5e7eb;
                    border-left: 4px solid #2563eb;
                    border-radius: 14px;
                    padding: 18px;
                    box-shadow: 0 1px 2px rgba(0,0,0,0.04);
                }

                .tm-card-yellow { border-left-color: #f59e0b; }
                .tm-card-red    { border-left-color: #ef4444; }
                .tm-card-green  { border-left-color: #10b981; }
                .tm-card-grey   { border-left-color: #9ca3af; }

                .tm-icon-box {
                    width: 58px;
                    height: 58px;
                    border-radius: 14px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    flex-shrink: 0;
                }

                .tm-icon-blue {
                    background: rgba(37,99,235,0.08);
                    color: #2563eb;
                }

                .tm-icon-yellow {
                    background: rgba(245,158,11,0.10);
                    color: #f59e0b;
                }

                .tm-icon-red {
                    background: rgba(239,68,68,0.10);
                    color: #ef4444;
                }

                .tm-icon-green {
                    background: rgba(16,185,129,0.10);
                    color: #10b981;
                }

                .tm-icon-grey {
                    background: rgba(156,163,175,0.12);
                    color: #6b7280;
                }

                .tm-icon { font-size: 28px; }

                .tm-card-content { flex: 1; }

                .tm-card-label {
                    font-size: 11px;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    margin-bottom: 10px;
                }

                .tm-blue-text   { color: #2563eb; }
                .tm-yellow-text { color: #f59e0b; }
                .tm-red-text    { color: #ef4444; }
                .tm-green-text  { color: #10b981; }
                .tm-grey-text   { color: #6b7280; }

                .tm-bullet-list {
                    margin: 0;
                    padding-left: 18px;
                }

                .tm-bullet-list li {
                    margin-bottom: 8px;
                    line-height: 1.55;
                    font-size: 15px;
                    font-weight: 500;
                    color: #111827;
                }

                .tm-error {
                    background: #fff5f5;
                    border: 1px solid #fecaca;
                    border-radius: 14px;
                    padding: 16px;
                    color: #dc2626;
                }

                .tm-empty {
                    background: #f9fafb;
                    border: 1px dashed #d1d5db;
                    border-radius: 14px;
                    padding: 20px;
                    color: #6b7280;
                    font-size: 15px;
                    line-height: 1.5;
                }

                .tm-toggle-btn {
                    background: #2563eb;
                    color: white;
                    border: none;
                    width: 52px;
                    height: 52px;
                    border-radius: 50%;
                    font-size: 22px;
                    cursor: pointer;
                    box-shadow: 0 8px 20px rgba(37,99,235,0.25);
                }
            `;

            document.head.appendChild(style);
        }

        const app =
            document.querySelector('app-dashboard') ||
            document.querySelector('.app-body') ||
            document.body;

        app.style.transition = 'transform 0.35s ease';

        const sidebar = document.createElement('div');

        sidebar.id = 'tm-sidebar';

        Object.assign(sidebar.style, {
            position: 'fixed',
            top: '0',
            right: `-${SIDEBAR_WIDTH}px`,
            width: `${SIDEBAR_WIDTH}px`,
            height: '100vh',
            background: '#fff',
            zIndex: '999999999',
            transition: 'right 0.35s ease',
            boxShadow: '-12px 0 40px rgba(0,0,0,0.10)',
            padding: '24px',
            overflowY: 'auto'
        });

        sidebar.innerHTML = `

            <div class="tm-sidebar-header">

                <div class="tm-sidebar-title">
                    Packing Guides
                </div>

                <div class="tm-sidebar-subtitle">
                    Live operational packing instructions
                </div>

            </div>

            <select id="packing-client-select">
                <option value="">Select a client...</option>
            </select>

            <div
                id="packing-guide-content"
                class="tm-guide-wrapper"
            >
                <div class="tm-empty">Loading packing guides...</div>
            </div>
        `;

        document.body.appendChild(sidebar);

        /*
        ========================================================
        TOGGLE BUTTON
        ========================================================
        */

        const toggle = document.createElement('button');

        toggle.innerHTML = '☰';

        toggle.className = 'tm-toggle-btn';

        Object.assign(toggle.style, {
            position: 'absolute',
            width: '38px',
            height: '38px',
            borderRadius: '50%',
            top: '50%',
            left: '-38px',
            transform: 'translateY(-50%)',
            zIndex: '1000000000',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#20a8d8',
            color: 'white',
            border: 'none',
            fontSize: '17px',
            cursor: 'pointer',
            boxShadow: '0 10px 30px rgba(37,99,235,0.20)',
            transition: 'all 0.25s ease'
        });

        /*
        ========================================================
        ATTACH BUTTON
        ========================================================
        */

        const targetNav = document.querySelector('.app-header .nav-item');

        if (targetNav) {
            targetNav.style.position = 'relative';
            targetNav.appendChild(toggle);
        } else {
            document.body.appendChild(toggle);
        }

        /*
        ========================================================
        OPEN / CLOSE
        ========================================================
        */

        toggle.addEventListener('click', () => {

            // Derive state from the DOM so a rebuild can't desync it.
            const isOpen = sidebar.style.right === '0px';

            if (!isOpen) {

                sidebar.style.right = '0px';

                app.style.transform =
                    `translateX(-${SIDEBAR_WIDTH}px)`;

                toggle.innerHTML = '✕';

            } else {

                sidebar.style.right = `-${SIDEBAR_WIDTH}px`;

                app.style.transform = 'translateX(0px)';

                toggle.innerHTML = '☰';
            }
        });

        document
            .getElementById('packing-client-select')
            .addEventListener('change', (e) => {

                if (!e.target.value) {
                    renderEmptyState();
                    return;
                }

                renderGuide(e.target.value);
            });

        loadPackingGuides();
    }

    /*
    ========================================================
    POPULATE DROPDOWN  (A-Z by client name)
    ========================================================
    */

    function populateDropdown() {

        const select = document.getElementById('packing-client-select');

        if (!select) return;

        const previous = select.value;

        select.innerHTML = '';

        const placeholder = document.createElement('option');

        placeholder.value = '';
        placeholder.textContent = 'Select a client...';

        select.appendChild(placeholder);

        // v18: alphabetical sort A-Z, case/punctuation insensitive.
        const sortedKeys = Object.keys(packingGuides).sort((a, b) =>
            packingGuides[a].client.localeCompare(
                packingGuides[b].client,
                'en',
                { sensitivity: 'base', numeric: true }
            )
        );

        sortedKeys.forEach(key => {

            const option = document.createElement('option');

            option.value = key;
            option.textContent = packingGuides[key].client;

            select.appendChild(option);
        });

        // Preserve whatever was showing before a rebuild.
        if (previous && packingGuides[previous]) {
            select.value = previous;
        }
    }

    /*
    ========================================================
    BULLET FORMATTER
    ========================================================
    */

    // True only if the field has something a packer can actually read.
    // Covers null, undefined, '', whitespace, and the string "null" that
    // occasionally comes back from the workflow.
    function hasContent(text) {

        if (text === null || text === undefined) return false;

        const t = String(text).trim();

        return t !== '' && t.toLowerCase() !== 'null';
    }

    // fallback is what shows when the field is empty, for the cards that are
    // always rendered (voidfill uses "N/A"). Cards that hide when empty never
    // reach this branch.
    function formatBullets(text, fallback) {

        if (!hasContent(text)) {

            return `
                <ul class="tm-bullet-list">
                    <li>${fallback || '-'}</li>
                </ul>
            `;
        }

        const lines = String(text)
            .split(/\n|•/)
            .map(x => x.trim())
            .filter(Boolean);

        return `
            <ul class="tm-bullet-list">
                ${lines.map(line => `
                    <li>${line}</li>
                `).join('')}
            </ul>
        `;
    }

    /*
    ========================================================
    RENDER GUIDE
    ========================================================
    */

    function renderGuide(key) {

        const guide = packingGuides[key];

        if (!guide) return;

        const container = document.getElementById('packing-guide-content');

        if (!container) return;

        // Keep the dropdown in sync no matter how we got here.
        const select = document.getElementById('packing-client-select');

        if (select && select.value !== key) {
            select.value = key;
        }

        // Always render this card - a packer needs an explicit answer either
        // way, so "false" shows "Not required" rather than nothing at all.
        const thankyouTone = guide.thankyou ? 'green' : 'grey';

        const thankyouText = guide.thankyou
            ? 'Required - include a thank you card in every order'
            : 'Not required - do not include a thank you card';

        const thankyouCard = `
            <div class="tm-guide-card tm-card-${thankyouTone}">

                <div class="tm-icon-box tm-icon-${thankyouTone}">
                    <div class="tm-icon">💌</div>
                </div>

                <div class="tm-card-content">

                    <div class="tm-card-label tm-${thankyouTone}-text">
                        THANK YOU CARD
                    </div>

                    <ul class="tm-bullet-list">
                        <li>${thankyouText}</li>
                    </ul>

                </div>

            </div>
        `;

        // Considerations is null/blank for a lot of clients - drop the whole
        // card rather than showing an empty "-" warning card.
        const considerationsCard = hasContent(guide.considerations)
            ? `
            <div class="tm-guide-card tm-card-red">

                <div class="tm-icon-box tm-icon-red">
                    <div class="tm-icon">⚠</div>
                </div>

                <div class="tm-card-content">

                    <div class="tm-card-label tm-red-text">
                        CRITICAL CONSIDERATIONS
                    </div>

                    ${formatBullets(guide.considerations)}

                </div>

            </div>
            `
            : '';

        // Packing method is blank for roughly a third of clients - hide the
        // card rather than showing an empty one.
        const packingMethodCard = hasContent(guide.packingMethod)
            ? `
            <div class="tm-guide-card">

                <div class="tm-icon-box tm-icon-blue">
                    <div class="tm-icon">📋</div>
                </div>

                <div class="tm-card-content">

                    <div class="tm-card-label tm-blue-text">
                        PACKING METHOD
                    </div>

                    ${formatBullets(guide.packingMethod)}

                </div>

            </div>
            `
            : '';

        container.innerHTML = `

            ${thankyouCard}

            ${considerationsCard}

            <div class="tm-guide-card">

                <div class="tm-icon-box tm-icon-blue">
                    <div class="tm-icon">📦</div>
                </div>

                <div class="tm-card-content">

                    <div class="tm-card-label tm-blue-text">
                        PACK INTO
                    </div>

                    ${formatBullets(guide.packInto)}

                </div>

            </div>

            <div class="tm-guide-card tm-card-yellow">

                <div class="tm-icon-box tm-icon-yellow">
                    <div class="tm-icon">🫧</div>
                </div>

                <div class="tm-card-content">

                    <div class="tm-card-label tm-yellow-text">
                        VOIDFILL
                    </div>

                    ${formatBullets(guide.voidfill, 'N/A')}

                </div>

            </div>

            ${packingMethodCard}
        `;
    }

    /*
    ========================================================
    MATCH A COMPANY TO A GUIDE
    ========================================================
    */

    function findGuideKey(candidates) {

        const keys = Object.keys(packingGuides);

        for (const raw of candidates) {

            const n = norm(raw);

            if (!n) continue;

            // 0. explicit override
            const override = CODE_OVERRIDES[String(raw).toLowerCase().trim()];

            if (override) {

                const hit = keys.find(
                    k => packingGuides[k].normKey === norm(override)
                );

                if (hit) return hit;
            }

            // 1. exact (normalised) name match  e.g. "HBC" -> "HBC"
            let hit = keys.find(k => packingGuides[k].normKey === n);
            if (hit) return hit;

            // 2. initials match  e.g. "BTF" -> "Boob to Food"
            //    (2+ chars only - a single letter would match half the list)
            if (n.length >= 2) {

                const initialHits = keys.filter(
                    k => packingGuides[k].initialsKey === n
                );

                if (initialHits.length === 1) return initialHits[0];
            }

            // 3. prefix match, either direction (3+ chars, must be unambiguous)
            if (n.length >= 3) {

                const prefixHits = keys.filter(k => {
                    const g = packingGuides[k].normKey;
                    return g.startsWith(n) || n.startsWith(g);
                });

                if (prefixHits.length === 1) return prefixHits[0];
            }

            // 4. contains match (4+ chars, must be unambiguous)
            if (n.length >= 4) {

                const containsHits = keys.filter(k => {
                    const g = packingGuides[k].normKey;
                    return g.includes(n) || n.includes(g);
                });

                if (containsHits.length === 1) return containsHits[0];
            }
        }

        return null;
    }

    /*
    ========================================================
    AUTO SELECT
    ========================================================
    */

    function autoSelectClient(candidates) {

        candidates = (candidates || []).filter(Boolean);

        if (!candidates.length) return false;

        // Remember it even if guides aren't loaded yet - this was the
        // main v17 failure: detection that arrived before the data
        // was silently thrown away and never retried.
        lastDetected = { candidates: candidates, matchedKey: null };

        if (!guidesLoaded) {

            console.log(
                '[Packing Guides] Detected',
                candidates,
                '- guides not loaded yet, will apply on load'
            );

            return false;
        }

        const key = findGuideKey(candidates);

        if (!key) {

            console.warn(
                '[Packing Guides] NO MATCH for company',
                candidates,
                '- add an entry to CODE_OVERRIDES to fix this client.'
            );

            return false;
        }

        lastDetected.matchedKey = key;

        renderGuide(key);

        setSubtitle(
            `Auto-selected: ${packingGuides[key].client}`
        );

        console.log(
            '[Packing Guides] Auto-selected',
            packingGuides[key].client,
            'from',
            candidates
        );

        return true;
    }

    // Re-apply the last detected company (after load, or after a rebuild).
    function reapplyDetection() {

        if (!lastDetected || !guidesLoaded) return false;

        return autoSelectClient(lastDetected.candidates);
    }

    /*
    ========================================================
    PROCESS SHIPMENT RESPONSE
    ========================================================
    */

    function processShipmentResponse(data) {

        try {

            // Deep search - the company field sits at different depths
            // depending on the endpoint / API version.
            const candidates = deepFindValues(
                data,
                [
                    'company_code',
                    'companyCode',
                    'company_name',
                    'companyName',
                    'client_code',
                    'clientCode'
                ]
            );

            if (!candidates.length) return;

            autoSelectClient(candidates);

        } catch (err) {

            console.error(
                '[Packing Guides] Response processing error:',
                err
            );
        }
    }

    function isTargetUrl(url) {

        if (typeof url !== 'string') return false;

        return TARGET_ENDPOINTS.some(e => url.includes(e));
    }

    /*
    ========================================================
    INTERCEPT FETCH  (patched on the PAGE window)
    ========================================================
    */

    const originalFetch = PAGE.fetch;

    if (typeof originalFetch === 'function' && !PAGE.__tmPackFetchPatched) {

        PAGE.fetch = async function (...args) {

            const response = await originalFetch.apply(this, args);

            try {

                const url =
                    (args[0] && (args[0].url || args[0].toString())) || '';

                if (isTargetUrl(url)) {

                    response
                        .clone()
                        .json()
                        .then(processShipmentResponse)
                        .catch(() => {});
                }

            } catch (err) {
                console.error('[Packing Guides] Fetch intercept error:', err);
            }

            return response;
        };

        PAGE.__tmPackFetchPatched = true;
    }

    /*
    ========================================================
    INTERCEPT XHR
    ========================================================
    */

    const XHR = PAGE.XMLHttpRequest;

    if (XHR && !XHR.prototype.__tmPackPatched) {

        const originalOpen = XHR.prototype.open;

        XHR.prototype.open = function (method, url) {

            try {
                this.__tmPackUrl = url;
            } catch (e) {}

            this.addEventListener('load', function () {

                try {

                    if (!isTargetUrl(this.__tmPackUrl)) return;

                    const raw = this.responseText;

                    if (!raw) return;

                    processShipmentResponse(JSON.parse(raw));

                } catch (err) {
                    // non-JSON responses are expected, stay quiet
                }
            });

            return originalOpen.apply(this, arguments);
        };

        XHR.prototype.__tmPackPatched = true;
    }

    /*
    ========================================================
    WAIT FOR APP + SELF HEAL
    ========================================================
    */

    function ensureSidebar() {

        const appExists =
            document.querySelector('app-dashboard') ||
            document.querySelector('.app-body');

        const headerExists = document.querySelector('.app-header');

        if (!appExists || !headerExists) return;

        const sidebar = document.getElementById('tm-sidebar');

        if (!sidebar) {

            console.log('[Packing Guides] Sidebar missing - creating');

            init();

            return;
        }

        const toggle = document.querySelector('.tm-toggle-btn');

        if (!toggle) {

            console.log('[Packing Guides] Toggle missing - rebuilding');

            sidebar.remove();

            init();

            return;
        }

        // Re-home the toggle if it landed on <body> because the nav
        // wasn't rendered yet when the sidebar was first built.
        const targetNav = document.querySelector('.app-header .nav-item');

        if (targetNav && toggle.parentElement === document.body) {

            targetNav.style.position = 'relative';
            targetNav.appendChild(toggle);
        }
    }

    /*
    ========================================================
    ROUTE / DOM WATCHER
    ========================================================
    */

    function startWatcher() {

        console.log('[Packing Guides] Starting persistent watcher');

        ensureSidebar();

        setInterval(ensureSidebar, 2000);
    }

    /*
    ========================================================
    START
    ========================================================
    */

    startWatcher();

})();

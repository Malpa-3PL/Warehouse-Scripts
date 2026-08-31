// ==UserScript==
// @name         Malpa Edit Dimensions
// @namespace    https://malpa.canary7.com
// @version      2.5.0
// @description  Adds an "Edit Dimensions" button to the Canary7 consigning screen (#/workbench) so an operator can correct a container's length / width / height
// @author       Malpa 3PL
// @homepageURL  https://github.com/zaynnev/malpa3pl
// @supportURL   https://github.com/zaynnev/malpa3pl/issues
// @updateURL    https://raw.githubusercontent.com/Malpa-3PL/Warehouse-Scripts/main/malpa-editdims.user.js
// @downloadURL  https://raw.githubusercontent.com/Malpa-3PL/Warehouse-Scripts/main/malpa-editdims.user.js
// @match        https://*.canary7.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

/* =============================================================================
 * malpa-editdims.user.js  -  v2.5.0
 *
 * v2.5.0 IS ONE UX ADDITION: A SUCCESS TOAST. Nothing about the route, the
 * interception, the anchor, the write URL or the verification strategy moved,
 * and no failure path changed by a single character.
 *
 *   THE PROBLEM v2.4.0 LEFT. A verified success closes the modal, so the only
 *   thing the operator was left with was a console line they will never open.
 *   The write landed and the screen said nothing.
 *
 *   WHAT FIRES, AND ONLY THERE. showToast() is called from exactly ONE place:
 *   the last statement of the success path in submit(), AFTER close() has taken
 *   the modal down. It is reachable only when the independent verifying re-read
 *   agreed with what was submitted (cmp.ok) AND the modal that write started in
 *   was still on screen. Every failure - network, HTTP 4xx, HTTP 500-with-a-
 *   code, a re-read that does not match, or a throw - leaves the modal standing
 *   and reports itself there, exactly as in v2.4.0, and never reaches the toast.
 *
 *   WHAT IT SAYS. The house shape is malpa-transfer.user.js's Status module
 *   (v2.6.1, section "4b. STATUS BANNER") - a '✓' glyph, a headline, and N
 *   detail lines, on transfer's own ok palette (#eaf7ee on #12833f with a 5px
 *   left border). There is NO transient/auto-dismissing notification anywhere
 *   in the fleet to copy - replen's #malpa-qty-error, transfer's Status and
 *   packguide's .tm-error are all persistent-until-replaced - so the TIMER is
 *   the only genuinely new element here, and the visual language is lifted
 *   rather than invented. Content is the container number plus one line per
 *   dimension that ACTUALLY CHANGED ("Length 6 → 10"); a dimension resubmitted
 *   at its existing value is not a change and is not listed. Weight is never
 *   listed as edited - it is passed through unchanged, not edited.
 *
 *   HOW IT BEHAVES. Body-level, #edim-toast, fixed top-right, auto-dismissing
 *   after TOAST_MS and dismissible by click. It has NO backdrop, never calls
 *   focus() and never captures keys, so it cannot trap focus or block the page
 *   underneath; the only pointer events it takes are the ones inside its own
 *   small box, which is what makes click-to-dismiss work. TOP-RIGHT is chosen
 *   because the bottom of the viewport is already #edim-crash's (left/right 12,
 *   bottom 12), and the container table with its Edit Weight / Edit Dimensions
 *   buttons sits in the page's own flow below the header - so the top-right
 *   corner is the one region that is neither.
 *
 *   IDEMPOTENT. showToast() removes any toast already up and CLEARS ITS PENDING
 *   TIMER before building the new one, so a second success replaces the first
 *   rather than stacking, and the replacement gets its full duration instead of
 *   inheriting the old one's remaining time.
 *
 *   IT GOES WITH THE ROUTE. watch()'s off-route branch already tears down the
 *   button, the modal and the observer; removeToast() joins them, timer and all.
 *
 *   THE CONSOLE LINE STAYS. "[Edit Dims] Saved and verified…" is still emitted,
 *   unchanged, on every success including the orphaned one. The toast is a
 *   second, transient surface, not a replacement for the permanent record.
 *
 *   NO TOAST ON THE ORPHAN PATH, DELIBERATELY. If the modal was already gone
 *   when the result landed (route change mid-write), the outcome still goes to
 *   the body-level #edim-crash box and NOTHING is toasted: the operator is no
 *   longer on the consigning screen, the crash box is a persistent report they
 *   can read whenever they notice it, and a 6-second toast on some unrelated
 *   screen would be a weaker duplicate that can expire before it is seen.
 *
 * v2.4.0 IS THREE UX CHANGES. Nothing about the route, the interception, the
 * anchor, the write URL or the verification strategy moved.
 *
 *   1. THE WEIGHT INPUT IS GONE. The consigning screen already carries its own
 *      "Edit Weight" button - the very element this script anchors to - so
 *      weight was editable in two places at once. This modal now edits LENGTH,
 *      WIDTH and HEIGHT only: no weight input, no weight label, no weight row in
 *      the old->new diff, no weight in validateDims(), and no
 *      container_max_weight check in the over-maximum warning.
 *
 *      THE WRITE STILL SENDS weight, AND MUST. close-to-container takes
 *      weight/length/width/height together; buildQuery() drops empty params, so
 *      omitting weight would send the write without it and risk Canary7 storing
 *      0 against a container whose real weight nobody touched. What goes out is
 *      the SELECTED CONTAINER'S CURRENT weight, read straight off its container
 *      record and passed through unchanged - never a literal, never anything the
 *      operator typed. See submit(), which also refuses rather than sending a
 *      write whose weight it cannot read.
 *
 *      WEIGHT REMAINS IN THE VERIFYING RE-READ. It is not edited, so it must
 *      come back EXACTLY as it went out; a re-read whose weight has moved means
 *      the write disturbed a value it was only meant to carry, and that is a
 *      genuine verification failure. Hence two field lists: FIELDS (the three
 *      editable dimensions) and VERIFY_FIELDS (those three plus weight).
 *
 *   2. A VERIFIED SUCCESS NOW CLOSES THE MODAL. The write and the independent
 *      verifying re-read run exactly as before - the close is the LAST step of
 *      the success path, never a substitute for verifying. ANY failure (network,
 *      HTTP 4xx, HTTP 500-with-a-code, or a re-read that does not match) leaves
 *      the modal open and reports itself exactly as it did in v2.3.0.
 *      Because the modal is gone on success, the outcome is also written to the
 *      console as a "[Edit Dims] Saved and verified…" line - the operator's only
 *      remaining record. No floating toast was invented for this, and the
 *      #edim-crash box is NOT reused: it is a red crash/orphan box and a routine
 *      success has no business in it.
 *
 *      THE ORPHAN PATH IS UNCHANGED. If the modal was already torn out (route
 *      change mid-write), reportResult() still routes the outcome to the
 *      body-level #edim-crash box - and in that case there is nothing of ours
 *      left to close, so nothing is closed. A modal the operator has since
 *      re-opened is never closed by an older write's result.
 *
 *   3. CONTAINER OPTION LABELS ARE THE BARE container_no. The
 *      "— weight 0.84, 6×2×5" suffix is gone; container numbers are unique, so
 *      the suffix disambiguated nothing and the numbers read as clutter next to
 *      a container number that already ends in digits. optionLabel() is deleted
 *      rather than left dormant.
 *
 * v2.3.0 RETRACTS TWO CLAIMS v2.2.0's header stated as CONFIRMED. Both were
 * derived from a BINARY OpenReplay stream, and both were wrong. A console probe
 * run on the LIVE consigning screen on 31 Aug 2026 [PROBE] is the ground truth
 * and supersedes every inference drawn from that stream:
 *
 *   RETRACTION 1 - THE ROUTE IS #/workbench, NOT #/workbenchv.
 *   v2.2.0 shipped ROUTE_RE = /^#\/workbenchv…/ which can NEVER match, so the
 *   script was dead on the real screen. The phantom "v" was a framing error: the
 *   byte immediately before the URL in the replay stream was '%' = 0x25 = 37,
 *   which is the LENGTH of "https://malpa.canary7.com/#/workbench" (37 chars) -
 *   a length prefix, not text - and the trailing "v" was the first byte of the
 *   NEXT field. One character of mis-framing.
 *
 *   That single character also explains the second live symptom, "row captured:
 *   false". watch() clears State.row whenever the route does not match, and the
 *   route never matched, so every 1500 ms tick wiped the payload the interceptor
 *   had just captured. Fixing ROUTE_RE fixes BOTH symptoms; there was never a
 *   second bug in the interception.
 *
 *   RETRACTION 2 - THE ANCHOR DOES CARRY "btn btn-primary btn-apply".
 *   v2.2.0's "FACT 2" asserted the anchor has no btn class of any kind, on the
 *   grounds that the string "btn" appears zero times in the replay stream. That
 *   was ABSENCE OF EVIDENCE in a stream that does not serialise the attribute at
 *   all, presented as evidence of absence. The build requirement's HTML snippet
 *   was accurate the whole time. See THE ANCHOR below for the probe's verbatim
 *   outerHTML.
 *
 *   NOTHING IN THE MATCHING CODE CHANGED FOR RETRACTION 2, and nothing should.
 *   findAnchor() matches on TAG + TEXT scoped to the container table, which is
 *   strictly more robust than a class selector: it matches this button today and
 *   keeps matching it after any Canary7 restyle. tryInject() cloning the
 *   anchor's className is likewise still right - it now clones
 *   btn btn-primary btn-apply, which is exactly what we want on our button.
 *
 * v2.2.0 fixed the reason v2.1.0 never appeared: it looked for the anchor by
 * CLASS. The DIAGNOSIS was wrong (the class does exist) but the FIX was right
 * for the right underlying reason - a build-coupled selector had no business
 * being the thing the button depended on. See THE ANCHOR below.
 *
 * v2 SUPERSEDES v1. v1 never appeared on screen at all: its route guard was a
 * regex looking for the word "consign", and the consigning screen's URL contains
 * no such word. v2 also deletes v1's entire DOM-scraping layer, which merged
 * values across unrelated tables and could have fed the wrong container id into
 * a production write.
 *
 * -----------------------------------------------------------------------------
 * CONFIRMED  (source and date given for every item)
 * -----------------------------------------------------------------------------
 * [HAR]  HAR capture of the live consigning screen, malpa.canary7.com.har,
 *        31 Aug 2026, staging tenant, company 46 (MA-TRL), warehouse 10.
 * [HAR2] A SECOND HAR of the live consigning screen, 31 Aug 2026, captured with
 *        v2.1.0 installed. Its OpenReplay stream carries the page's own console
 *        output and a serialised DOM.
 * [MCP]  Read-only probe through the malpa-canary7 MCP.
 * [PROBE] A CONSOLE PROBE run on the LIVE consigning screen, 31 Aug 2026, with
 *        v2.2.0 installed. It read location.hash, the live button set and the
 *        live table headers directly out of the DOM. THIS IS GROUND TRUTH AND
 *        SUPERSEDES EVERY INFERENCE DRAWN FROM THE [HAR2] REPLAY STREAM. Where
 *        the two disagree, [HAR2] is wrong: it is a binary format that neither
 *        serialises every attribute nor frames its fields the way v2.2.0's
 *        header assumed. Verbatim output:
 *
 *          version: 2.2.0
 *          row captured: false | hash: #/workbench
 *          our button present: false
 *          Edit Weight buttons: 1
 *          0 inTD: true class: "btn btn-primary btn-apply"
 *            <button _ngcontent-ng-c233464439="" type="button"
 *                    class="btn btn-primary btn-apply">Edit Weight</button>
 *          tables: [["Item","Item Description","Total Quantity","","","",""],
 *                   [],
 *                   ["Container No","Location","Container Type","Weight"],
 *                   ["Shift User","Shift Name","Completed","Abandoned"]]
 *          after manual tryInject: false
 *
 * ROUTE                                                            [PROBE]
 *   The consigning screen is  https://malpa.canary7.com/#/workbench
 *   "consign" appears nowhere in the URL. #/workbench is a GENERIC workbench
 *   route, so it is necessary but NOT sufficient - see the three-part guard in
 *   isConsignRoute() + hasConsigningEvidence() + findAnchor().
 *
 *   CORRECTION - v2.2.0's header said #/workbenchv AND SHIPPED A REGEX THAT
 *   REQUIRED IT, so the script could never run on the real screen. There is no
 *   trailing "v". The probe read location.hash straight off the live page:
 *   "#/workbench". The "v" was the leading byte of the next field in the replay
 *   stream, sitting behind a '%' (0x25 = 37) length prefix that happens to be
 *   the exact character count of the URL. Do not re-derive the "v" from any
 *   replay capture; read location.hash.
 *
 *   The same character explains "row captured: false" in the probe. watch()
 *   clears State.row off-route, and the route never matched, so the polling tick
 *   destroyed each captured payload moments after it arrived. One fix, two
 *   symptoms - do not go looking for a separate interception bug.
 *
 * THE DATA SOURCE                                                    [HAR]
 *   The screen loads a container with, on the page's own fetch/XHR:
 *     GET https://stgauth.canary7.com/index.php
 *         ?r=shipment/shipment-container/get-consigning-container
 *         &expand=status,stagingDock,consignment,containerType
 *         &container_no=LA_TEST_SHIPMENT_20250822.1%23%237
 *         &initiation_method_id=1
 *         &item_code=null
 *   200, a single-element array. That one payload carries EVERY value this
 *   script needs, already resolved:
 *     container_id           <- [0].id                       (1449741)
 *     close_to_location_id   <- [0].staging_dock_id           (72037, WDD-02)
 *     current w / l / w / h  <- [0].weight/.length/.width/.height (0.84, 6, 2, 5)
 *     container list filter  <- [0].shipment_header_id        (737834)
 *     screen confirmation    <- [0].status.description == "Consigning Pending"
 *   So v2 intercepts that call instead of reading the screen. No scraping.
 *
 * REQUEST HEADERS                                                    [HAR]
 *   The API answers  access-control-allow-origin: *  with NO credentials, and
 *   the preflight negotiates:
 *     authorization, x-correlation-id, x-reference-id, x-session-id, x-warehouse-id
 *   Observed live: x-warehouse-id: 10, x-session-id: 26,
 *   x-correlation-id: <uuid v4>, x-reference-id: <8-char id>, plus authorization
 *   (redacted by Chrome, but negotiated in the preflight). Auth is therefore a
 *   BEARER HEADER, not a cookie - this script never sends credentials:'include'.
 *
 *   An intercepted request's header set is mined for the TWO values this script
 *   cannot derive - x-session-id and x-warehouse-id - and for nothing else. It is
 *   NOT reused wholesale: x-correlation-id identifies ONE of the app's requests,
 *   so pinning it to our list call, our write and our verifying re-read would
 *   make three separate calls masquerade as that single app request, and a
 *   captured Authorization may be stale by the time the operator submits.
 *   Authorization therefore always comes from getToken(), and a fresh
 *   x-correlation-id (uuid v4) and x-reference-id are generated PER CALL.
 *   See reqHeaders().
 *
 * THE CONTAINER LIST                                                 [MCP]
 *   GET /index.php?r=shipment/shipment-container&shipment_header_id=737834
 *   shipment_header_id is the working filter. shipment_id is SILENTLY IGNORED
 *   and returns an unfiltered page of unrelated containers - never use it.
 *   container_no also works as a direct filter and returns the same single row.
 *
 * THE ANCHOR                                              [PROBE], [HAR2]
 *
 *   FACT 1. THE SCRIPT WORKS ALL THE WAY UP TO INJECTION.            [HAR2]
 *   The replay stream carries this script's OWN console line, emitted on the
 *   live screen:
 *     [Edit Dims] captured get-consigning-container container
 *     LA_TEST_SHIPMENT_20250822.1##7 id 1449741 status Consigning Pending
 *   So @run-at document-start and the fetch/XHR interception are confirmed
 *   working on the real screen. (The ROUTE GUARD is NOT confirmed by this line:
 *   noteRow() captures regardless of route, and v2.2.0's broken ROUTE_RE then
 *   let watch() throw the capture away on the next tick. See RETRACTION 1.)
 *
 *   FACT 2. THE ANCHOR CARRIES  btn btn-primary btn-apply.          [PROBE]
 *   Read off the live DOM, verbatim:
 *
 *     class list:  btn btn-primary btn-apply
 *     outerHTML:   <button _ngcontent-ng-c233464439="" type="button"
 *                          class="btn btn-primary btn-apply">Edit Weight</button>
 *
 *   RETRACTED: v2.2.0's header stated as CONFIRMED that "THE ANCHOR CARRIES NO
 *   'btn' CLASS OF ANY KIND", reasoning that the string "btn" appears zero times
 *   in the replay stream. THAT CLAIM WAS FALSE. It was absence of evidence in a
 *   stream that never serialises this attribute, written up as evidence of
 *   absence. The build requirement's class="btn btn-primary btn-apply" snippet
 *   described this element accurately all along. Do not repeat the inference:
 *   a class missing from an OpenReplay capture says nothing about the live DOM.
 *
 *   THE MATCHING CODE IS UNCHANGED BY THAT RETRACTION, DELIBERATELY.
 *   findAnchor() still matches on TAG + TEXT scoped to the container table and
 *   still never names a class, because tag+text is STRICTLY MORE ROBUST than the
 *   class selector it replaced: it matches this button as it stands today, and a
 *   Canary7 restyle that renames btn-apply cannot break it. Reverting to
 *   'button.btn-apply' would buy nothing and re-couple the button to a build.
 *   The Angular content attribute (_ngcontent-ng-c233464439) is never matched on
 *   either - that hash changes with every Canary7 build.
 *
 *   Class cloning in tryInject() also still does exactly the right thing: it now
 *   clones btn btn-primary btn-apply onto our button, which is precisely the
 *   styling we want, obtained without naming one class of C7's in this source.
 *
 *   WHAT THE DOM ACTUALLY IS:
 *     .table-responsive > TABLE > TBODY > TR >
 *        TD container_no | TD location | TD container type | TD weight |
 *        TD > BUTTON "Edit Weight"
 *   a single-row table whose <thead> reads
 *     Container No | Location | Container Type | Weight
 *   The screen's own CSS carries, on its Angular content attribute:
 *     td … button … { margin-left: 10px }
 *     .table-responsive … { max-height: 720px; overflow-y: scroll }
 *
 *   There is ALSO an <h5>Edit Weight</h5> elsewhere in the DOM - the hidden
 *   Edit Weight modal's title. A text match not also anchored to
 *   BUTTON-inside-TD would select that instead. The probe counts exactly ONE
 *   element whose text is "Edit Weight" and which is a button in a td, so the
 *   tag+text match is unambiguous on the live screen.
 *
 * THE CONTAINER TABLE  -  and why the search is scoped              [PROBE]
 *   THERE ARE FOUR TABLES ON THE CONSIGNING SCREEN, not one. Their header rows,
 *   in document order:
 *     0  ["Item","Item Description","Total Quantity","","","",""]
 *     1  []                                    (an empty table, no <th> at all)
 *     2  ["Container No","Location","Container Type","Weight"]   <- ours
 *     3  ["Shift User","Shift Name","Completed","Abandoned"]
 *   findContainerTable() picks index 2 by requiring a <th> containing
 *   "container no" AND a <th> containing "weight", which is satisfied by that
 *   table and by none of the other three. That is what justifies scoping the
 *   anchor search at all: an unscoped document-wide "td button" sweep would be
 *   free to pick a button out of the Item or Shift table. The scope is a
 *   preference, not a requirement - findAnchor() falls back to the whole
 *   document when no table matches, so a header re-wording degrades the search
 *   instead of killing the button.
 *
 * THE WRITE                                                          [HAR]
 *   GET /index.php?r=shipment/shipment-container/close-to-container
 *       &close_to_location_id=72037&container_id=1449741&profile_id=7
 *       &weight=0.84&length=6&width=2&height=5
 *   profile_id is 7. The original requirement said 14; THERE IS NO PROFILE 14.
 *   The tenant's configuration/consigning-profile list, read from the HAR of
 *   31 Aug 2026, contains only 6 (Supervisor Fixing), 7 (Default Consigning),
 *   8 (Wholesale Consigning) and 10 (TEST). Profile 7's initiation_method_id is
 *   1, matching the initiation_method_id=1 the consigning screen itself sends.
 *   PROFILE_ID below is the single place it is defined.
 *
 * AUTH                                                        (lifted verbatim)
 *   getToken(), mkHeaders() and API_ROOT / API_BASE / WAREHOUSE_ID are copied
 *   verbatim from malpa-transfer.user.js v2.6.1. No auth scheme is invented here.
 *
 * -----------------------------------------------------------------------------
 * ASSUMED / NOT CONFIRMED  -  do not treat any of this as fact
 * -----------------------------------------------------------------------------
 *  1. UNITS. Nothing confirmed says what unit weight/length/width/height are in.
 *     They are therefore never labelled "kg" or "cm" anywhere in this UI, and the
 *     numbers are passed through exactly as typed.
 *  2. x-session-id. Observed as 26 on the live request, but its origin (where
 *     the app derives it) is unconfirmed. It is reused verbatim when captured
 *     from an intercepted request, and is NOT synthesised when falling back to
 *     mkHeaders() - a guessed session id is worse than an absent one.
 *  3. Whether #/workbench hosts screens OTHER than consigning that also render
 *     an "Edit Weight" button. This is exactly why the route alone is not the
 *     guard: a get-consigning-container response must also have been seen. The
 *     probe makes this MORE likely, not less - #/workbench renders an Item
 *     table and a Shift table alongside the container table, so it is plainly a
 *     composite workbench rather than a dedicated consigning URL.
 *  4. Whether access_token in localStorage/sessionStorage is live on this
 *     screen. hasToken() reports it; the header-capture path does not depend on it.
 *  5. readContainerNoFromPage() - the fallback used only when the script loaded
 *     AFTER the app's own call fired. The selectors it tries are NOT confirmed;
 *     if it finds nothing the modal says so and stops. It never guesses, and it
 *     is not a revival of v1's scraper: it reads ONE value and nothing else.
 *  6. profile_id 7 (see THE WRITE). The profile EXISTS and its
 *     initiation_method_id matches the screen's, but nothing confirms that
 *     close-to-container actually consumes it the way this script assumes.
 *  9. RESOLVED - NO LONGER AN ASSUMPTION. v2.2.0 listed the anchor's class list
 *     here as UNKNOWN. It is now KNOWN: the live probe reads it as exactly
 *     "btn btn-primary btn-apply" (see FACT 2, which carries the outerHTML).
 *     This entry is kept, rather than deleted, so that nobody re-opens the
 *     question. What has NOT changed is the matching strategy: findAnchor()
 *     still matches on tag + text and tryInject() still clones the className,
 *     because knowing today's class list is not a reason to hard-code it -
 *     tag + text survives a restyle and a class selector does not.
 * 10. RESOLVED FOR THE LIVE SCREEN. v2.2.0 listed as unconfirmed that the
 *     container table is the only table carrying both a "Container No" and a
 *     "Weight" <th>. The probe confirms it: FOUR tables are present (Item /
 *     an empty one / Container / Shift) and only the Container table satisfies
 *     both header tests - see THE CONTAINER TABLE above. The fallback behaviour
 *     is unchanged and still wanted: findAnchor() prefers that table but falls
 *     back to every td button in the document, so a fifth table or a re-worded
 *     header degrades into the text match rather than into no button at all.
 *  7. THE FALLBACK IS UNREACHABLE FROM THE BUTTON BY DESIGN. tryInject() refuses
 *     to inject unless State.row is set, and the fallback in loadContainers()
 *     only runs when State.row is null - so no click can ever reach it. It is
 *     kept solely as a CONSOLE ESCAPE HATCH: window.__editDims.open() in a
 *     session where the row was captured and has since been lost. The tests
 *     exercise it through that debug handle, never through a click. If the
 *     three-part guard is ever relaxed, this path becomes live again - which is
 *     why it still refuses to guess.
 *  8. The staleness threshold in STALE_ROW_MS (60s) is a judgement call, not a
 *     confirmed figure. Nothing establishes how long a captured consigning row
 *     stays accurate; the warning never blocks.
 *
 * -----------------------------------------------------------------------------
 * TEST DATA (staging, MA-TRL company 46, warehouse 10 Darra - never 9)
 *   route      https://malpa.canary7.com/#/workbench      (NOT #/workbenchv)
 *   shipment   LA_TEST_SHIPMENT_20250822.1##7  -> shipment_header_id 737834
 *   container  LA_TEST_SHIPMENT_20250822.1##7  -> id 1449741, 0.84 / 6 x 2 x 5
 *   dock       WDD-02 -> 72037
 *   type       39 "Lou Lou Carton", max 12 / 42 x 28 x 20
 * ========================================================================== */

(function () {
  'use strict';

  /* ===========================================================================
   * CONFIG
   * ======================================================================== */

  const TAG          = '[Edit Dims]';
  const VERSION      = '2.5.0';                      // keep in step with @version

  // Lifted verbatim from malpa-transfer.user.js
  const API_ROOT     = 'https://stgauth.canary7.com';
  const API_BASE     = API_ROOT + '/index.php?r=';
  const WAREHOUSE_ID = 10;

  // 7 = "Default Consigning". The build requirement said 14 - THERE IS NO
  // PROFILE 14. The tenant's configuration/consigning-profile list, read from
  // the HAR of 31 Aug 2026, holds only 6 (Supervisor Fixing), 7 (Default
  // Consigning), 8 (Wholesale Consigning) and 10 (TEST). Profile 7's
  // initiation_method_id is 1, matching the initiation_method_id=1 the
  // consigning screen itself sends.
  const PROFILE_ID   = 7;

  // The generic workbench route. Necessary, never sufficient - see the guard.
  // ';' is tolerated alongside '/', '?' and '#' because Angular writes matrix
  // params onto a route segment as #/workbench;id=1449741.
  //
  // THE SEGMENT IS "workbench". v2.2.0 required "workbenchv" and therefore never
  // matched anything, which killed the script twice over: the button could not
  // inject, and watch() wiped every captured payload on the next 1500 ms tick.
  // The phantom "v" came from mis-framing a binary OpenReplay stream - the byte
  // before the URL was a '%' (0x25 = 37) LENGTH prefix, 37 being the length of
  // "https://malpa.canary7.com/#/workbench", and the "v" was the next field's
  // first byte. The live console probe of 31 Aug 2026 read location.hash as
  // "#/workbench". Do not restore the "v".
  const ROUTE_RE     = /^#\/workbench(?:[/?#;].*)?$/i;

  // How old a captured consigning row may be before the modal warns about it.
  // A judgement call, not a confirmed figure - see the ASSUMED block. Warn only.
  const STALE_ROW_MS = 60000;

  // How long the success toast stays up before dismissing itself. A judgement
  // call - there is NO transient-notification precedent in the fleet to copy a
  // duration from (see the v2.5.0 header note). Long enough to read a container
  // number and up to three change lines on a handheld, short enough that it is
  // gone by the time the operator has consigned the next container. A click
  // dismisses it sooner; nothing ever waits on it.
  const TOAST_MS     = 6000;

  // The substring that identifies the app's own consigning load.
  const CONSIGN_MARKER = 'get-consigning-container';

  // The expand list the app itself sends. Byte-for-byte, commas unencoded.
  const CONSIGN_EXPAND = 'status,stagingDock,consignment,containerType';
  const LIST_EXPAND    = 'status,stagingDock,containerType';

  const ROUTES = {
    consigning: 'shipment/shipment-container/get-consigning-container',
    list:       'shipment/shipment-container',
    write:      'shipment/shipment-container/close-to-container',
  };

  // Every id this script owns. Unique 'edim' prefix, no exceptions.
  const IDS = {
    style:    'edim-style',
    btn:      'edim-btn',
    backdrop: 'edim-backdrop',
    modal:    'edim-modal',
    title:    'edim-title',
    select:   'edim-select',
    fields:   'edim-fields',
    // NO weight id. Weight is not editable here - the consigning screen's own
    // "Edit Weight" button owns it. See the v2.4.0 note in the header.
    length:   'edim-length',
    width:    'edim-width',
    height:   'edim-height',
    diff:     'edim-diff',
    msg:      'edim-msg',
    actions:  'edim-actions',
    yes:      'edim-yes',
    no:       'edim-no',
    spinner:  'edim-spinner',
    crash:    'edim-crash',
    // The success toast. Body-level like the crash box, and just as much ours -
    // it is never attached to, or styled onto, a node of C7's.
    toast:    'edim-toast',
  };

  const CONFIG = {
    version:     VERSION,
    apiRoot:     API_ROOT,
    apiBase:     API_BASE,
    warehouseId: WAREHOUSE_ID,
    profileId:   PROFILE_ID,
    routes:      ROUTES,
    ids:         IDS,
    routeRe:     String(ROUTE_RE),
    consignMarker: CONSIGN_MARKER,
  };

  // One stylesheet, every selector prefixed. Kept as an array of single-quoted
  // literals so an offline test can scan it for a leaked class name.
  // NOTE: no margin rule for #edim-btn. The consigning screen's own stylesheet
  // already carries  td … button … { margin-left: 10px }  [HAR2], which spaces
  // every button in that cell including ours. A competing margin here would
  // only fight it. edim-btn stays as a hook for when it genuinely needs one.
  const CSS = [
    '#edim-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147483646}',
    '#edim-modal{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);',
    'width:min(520px,94vw);max-height:90vh;overflow:auto;background:#fff;color:#111827;',
    'border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.28);padding:22px;',
    'z-index:2147483647;font-family:Inter,Roboto,Arial,sans-serif;font-size:15px}',
    '.edim-title{font-size:22px;font-weight:700;margin-bottom:14px}',
    '.edim-row{margin-bottom:12px}',
    '.edim-label{display:block;font-size:12px;font-weight:700;text-transform:uppercase;',
    'letter-spacing:.5px;color:#6b7280;margin-bottom:5px}',
    '.edim-select{width:100%;height:46px;border:1px solid #d1d5db;border-radius:10px;',
    'padding:0 12px;font-size:15px;background:#fff;color:#111827}',
    '.edim-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
    '.edim-input{width:100%;height:46px;border:1px solid #d1d5db;border-radius:10px;',
    'padding:0 12px;font-size:16px;background:#fff;color:#111827}',
    '.edim-diff{background:#f9fafb;border:1px dashed #d1d5db;border-radius:10px;',
    'padding:12px;margin:12px 0;font-size:14px;line-height:1.55;white-space:pre-wrap}',
    '.edim-diff-head{font-weight:700;margin-bottom:6px}',
    '.edim-diff-line{font-variant-numeric:tabular-nums}',
    '.edim-msg{white-space:pre-wrap;font-size:13px;line-height:1.5;margin-top:10px;',
    'max-height:220px;overflow:auto;font-family:ui-monospace,Menlo,Consolas,monospace}',
    '.edim-warn{color:#b45309}',
    '.edim-error{color:#dc2626}',
    '.edim-good{color:#047857}',
    '.edim-actions{display:flex;align-items:center;gap:10px;margin-top:16px}',
    '.edim-spacer{flex:1}',
    '.edim-action{height:44px;min-width:96px;border:none;border-radius:10px;font-size:15px;',
    'font-weight:600;cursor:pointer}',
    '.edim-no{background:#e5e7eb;color:#111827}',
    '.edim-yes{background:#2563eb;color:#fff}',
    '.edim-spinner{font-size:13px;color:#6b7280}',
    // THE SUCCESS TOAST. Palette and shape lifted from malpa-transfer's Status
    // module ('ok' state): #eaf7ee on #12833f behind a 5px left border, a bold
    // title line and a smaller detail block. TOP-RIGHT because the bottom strip
    // belongs to #edim-crash and the container table with its Edit Weight /
    // Edit Dimensions buttons sits in the page flow below the header. No
    // backdrop and no overlay: it covers only its own box, so the screen
    // underneath stays clickable.
    '#edim-toast{position:fixed;top:16px;right:16px;z-index:2147483647;',
    'width:min(420px,calc(100vw - 32px));box-sizing:border-box;cursor:pointer;',
    'background:#eaf7ee;border:1px solid #12833f;border-left:5px solid #12833f;',
    'border-radius:10px;padding:12px 14px;color:#12833f;',
    'box-shadow:0 14px 34px rgba(0,0,0,.18);',
    'font-family:Inter,Roboto,Arial,sans-serif}',
    '.edim-toast-title{font-size:15px;font-weight:600;line-height:1.3}',
    '.edim-toast-lines{margin-top:5px;font-size:12px;line-height:1.5;opacity:.9;',
    'overflow-wrap:anywhere}',
    '.edim-toast-line{font-variant-numeric:tabular-nums}',
    '#edim-crash{position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483647;',
    'background:#fff5f5;border:2px solid #fecaca;border-radius:12px;padding:14px;',
    'color:#991b1b;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;',
    'max-height:45vh;overflow:auto}',
  ].join('');

  /* ===========================================================================
   * LOGGING
   * ======================================================================== */

  function log() {
    try {
      const args = [TAG].concat([].slice.call(arguments));
      console.log.apply(console, args);
    } catch (_) {}
  }
  function warn() {
    try {
      const args = [TAG].concat([].slice.call(arguments));
      console.warn.apply(console, args);
    } catch (_) {}
  }

  /* ===========================================================================
   * AUTH  -  lifted verbatim from malpa-transfer.user.js
   * ======================================================================== */

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

  function hasToken() {
    return !!getToken();
  }

  function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : ((r & 0x3) | 0x8);
      return v.toString(16);
    });
  }

  /* Headers for our own calls.
   *
   * The captured header set is MINED, never replayed. It contributes exactly two
   * values - x-session-id and x-warehouse-id - because those are the only two
   * this script cannot derive for itself.
   *
   * Everything else is built fresh per call:
   *   Authorization    - always from getToken(). A captured bearer may already
   *                      be stale by the time the operator presses Yes.
   *   x-correlation-id - a fresh uuid v4. The app's own correlation id belongs
   *                      to ONE of the app's requests; pinning it to our list
   *                      call, our write and our verifying re-read would make
   *                      three separate calls masquerade as that single one and
   *                      would make the write untraceable in Canary7's logs.
   *   x-reference-id   - regenerated by mkHeaders() on every call.
   *
   * x-session-id is still never SYNTHESISED - when nothing was captured it is
   * simply absent, because a guessed session id is worse than no session id.
   * See the ASSUMED block. */
  function reqHeaders() {
    const h = mkHeaders();               // Content-Type, Accept, Authorization,
                                         // x-warehouse-id, x-reference-id
    h['x-correlation-id'] = uuidv4();

    const cap = H.capturedHeaders;
    if (cap) {
      Object.keys(cap).forEach(function (k) {
        const lk = String(k).toLowerCase();
        if (lk === 'x-session-id' || lk === 'x-warehouse-id') h[lk] = cap[k];
      });
    }
    return h;
  }

  /* ===========================================================================
   * URL BUILDING
   *
   * Everything goes through encodeURIComponent. The test container number
   * contains '##'; a raw '#' would truncate the URL at the fragment and the
   * request would silently address the wrong thing.
   * ======================================================================== */

  function buildQuery(params) {
    const out = [];
    Object.keys(params || {}).forEach(function (k) {
      const v = params[k];
      if (v === null || v === undefined || v === '') return;
      // Commas are left raw: the app's own expand= list sends them unencoded and
      // this is the one character we match byte-for-byte against the HAR.
      out.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)).replace(/%2C/g, ','));
    });
    return out.join('&');
  }

  function apiBase() { return API_BASE; }
  function warehouseId() { return String(WAREHOUSE_ID); }

  function apiUrl(route, params) {
    const q = buildQuery(params);
    // The route's own slashes are part of the ?r= value and stay raw.
    return API_BASE + route + (q ? '&' + q : '');
  }

  function consigningUrl(containerNo) {
    return apiUrl(ROUTES.consigning, {
      expand: CONSIGN_EXPAND,
      container_no: containerNo,
      initiation_method_id: 1,
      item_code: 'null',
    });
  }

  function listUrl(shipmentHeaderId) {
    // shipment_header_id ONLY. shipment_id is silently ignored by Canary7.
    return apiUrl(ROUTES.list, {
      shipment_header_id: shipmentHeaderId,
      expand: LIST_EXPAND,
    });
  }

  /* The SECOND way to read one container, confirmed in section 5 of the build
   * prompt: container_no is a working direct filter on shipment-container and
   * returns the same row. Used only as the verifying re-read's fallback - see
   * verifyRead(). */
  function containerByNoUrl(containerNo) {
    return apiUrl(ROUTES.list, {
      container_no: containerNo,
      expand: LIST_EXPAND,
    });
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

  /* ===========================================================================
   * SMALL PURE HELPERS
   * ======================================================================== */

  /* The CONFIRMED shape is a bare array - that is what the HAR shows on every
   * one of these endpoints, and it is the only branch that has ever fired.
   *
   * The {data:[]} and {items:[]} branches are DEFENSIVE GUESSES, not confirmed
   * envelopes: nothing observed has returned either. They are kept only so that
   * a future Canary7 build which wraps its payload degrades into "no container
   * found" instead of into a silent empty list. Nothing downstream may treat
   * their presence as evidence that Canary7 uses them. */
  function asArray(body) {
    if (Array.isArray(body)) return body;
    if (body && Array.isArray(body.data)) return body.data;      // GUESS
    if (body && Array.isArray(body.items)) return body.items;    // GUESS
    return [];
  }

  function classifyStatus(s) {
    if (s >= 200 && s < 300) return 'ok';
    if (s === 401 || s === 403) return 'auth';
    if (s >= 400 && s < 500) return 'client';
    if (s >= 500) return 'server';
    return 'network';
  }

  function num(v) { return Number(v); }
  function fmt(v) { return (v === null || v === undefined || v === '') ? '?' : String(v); }

  /* Did this value actually move? Compared NUMERICALLY where both sides resolve,
   * so the stored 6 and a typed "6" are the same value and not a change - the
   * success toast lists only what really moved. Anything Number() cannot resolve
   * falls back to a string comparison rather than collapsing into NaN !== NaN
   * and reporting a change that did not happen. */
  function changed(before, after) {
    const a = num(before);
    const b = num(after);
    if (isFinite(a) && isFinite(b)) return Math.abs(a - b) >= 1e-9;
    return String(before) !== String(after);
  }

  /* THE THREE EDITABLE DIMENSIONS. Weight is deliberately absent: the consigning
   * screen has its own "Edit Weight" button, so this modal must not offer a
   * second way to change it. Everything the operator touches - the inputs, the
   * prefill, readInputs(), validateDims(), the old->new diff - is driven from
   * this list, so weight cannot leak back into any of them. */
  const FIELDS = [
    ['length', 'Length'],
    ['width',  'Width'],
    ['height', 'Height'],
  ];

  /* WHAT THE VERIFYING RE-READ COMPARES - the three dimensions PLUS weight.
   *
   * Weight is not edited, which is exactly why it is verified: the write carries
   * the container's own current weight back to Canary7 unchanged, so the re-read
   * must return that same value. If it does not, the write disturbed a field it
   * was only meant to pass through, and that is a real failure the operator has
   * to be told about - not something to quietly exclude from the comparison. */
  const VERIFY_FIELDS = [['weight', 'Weight']].concat(FIELDS);

  function validateDims(d) {
    const out = [];
    FIELDS.forEach(function (p) {
      const key = p[0];
      const name = p[1];
      const v = d ? d[key] : undefined;
      if (v === null || v === undefined || String(v).trim() === '') {
        out.push(name + ' is required.');
        return;
      }
      const n = num(v);
      if (!isFinite(n)) { out.push(name + ' must be a number.'); return; }
      if (!(n > 0)) out.push(name + ' must be greater than 0.');
    });
    return out;
  }

  /* Canary7 writes echo PRE-write state and business rejections arrive as HTTP
   * 500 with a numeric code, so the write's own response proves nothing. This
   * compares an independent re-read against what was submitted. */
  function compareDims(actual, want) {
    const mismatches = [];
    VERIFY_FIELDS.forEach(function (p) {
      const key = p[0];
      const w = num(want[key]);
      const a = actual ? num(actual[key]) : NaN;
      if (!(isFinite(a) && Math.abs(a - w) < 1e-9)) {
        mismatches.push({
          field: key,
          submitted: w,
          actual: actual ? actual[key] : null,
        });
      }
    });
    return { ok: mismatches.length === 0, mismatches: mismatches };
  }

  /* optionLabel() IS GONE (v2.4.0). It built
   *   "<container_no> — weight 0.84, 6×2×5"
   * and the suffix has been dropped: container numbers are unique, so it
   * disambiguated nothing, and a run of unlabelled numbers hanging off a
   * container number that already ends in digits read as confusion rather than
   * as help. renderSelect() now uses String(c.container_no) directly, and the
   * helper is deleted rather than left dormant for something to pick up again. */

  function dockIdOf(c) {
    if (!c) return null;
    if (c.staging_dock_id !== null && c.staging_dock_id !== undefined) return c.staging_dock_id;
    if (c.stagingDock && c.stagingDock.id !== undefined) return c.stagingDock.id;
    return null;
  }

  /* Warn, never block.
   *
   * THREE CHECKS, NOT FOUR. container_max_weight is not tested here any more:
   * this modal cannot change the weight, so warning about a weight the operator
   * has no way to correct from this dialog would be noise attached to the one
   * value they are not editing. The three dimension maxima stay. */
  function maxWarnings(container, dims) {
    const ct = container && container.containerType;
    if (!ct) return [];
    const out = [];
    [
      ['length', 'container_max_length', 'Length'],
      ['width',  'container_max_width',  'Width'],
      ['height', 'container_max_height', 'Height'],
    ].forEach(function (p) {
      const max = num(ct[p[1]]);
      const v = num(dims[p[0]]);
      if (isFinite(max) && isFinite(v) && v > max) {
        out.push(p[2] + ' ' + fmt(dims[p[0]]) + ' exceeds the container type maximum ' +
          fmt(ct[p[1]]) + ' (' + fmt(ct.name) + '). Submitting anyway.');
      }
    });
    return out;
  }

  /* ===========================================================================
   * STATE
   * ======================================================================== */

  /* NOTE: there is deliberately NO State.locationId. It used to be stamped from
   * the intercepted row and then never read - submit() has always taken
   * dockIdOf() of the SELECTED container. A write-only field holding a
   * plausible-looking location id is exactly the thing a future edit reaches
   * for by mistake, so it is gone rather than merely unused. */
  const State = {
    row: null,               // the intercepted get-consigning-container row
    rowAt: null,             // epoch ms when that row was captured (staleness)
    containers: [],
    selectedId: null,
    shipmentHeaderId: null,
    warnings: [],
    loadingList: false,
    submitting: false,
    lastVerify: null,
    usedFallback: false,
    reset: function () {
      // row / rowAt are NOT reset here: they belong to the route session, not to
      // one modal. watch() clears them when the route is left.
      this.containers = [];
      this.selectedId = null;
      this.shipmentHeaderId = null;
      this.warnings = [];
      this.loadingList = false;
      this.submitting = false;
      this.lastVerify = null;
      this.usedFallback = false;
    },
  };

  // The debug handle. Populated at the bottom; lastPayload / lastResponse are
  // written through H so they are always visible from the console.
  const H = {
    VERSION: VERSION,
    CONFIG: CONFIG,
    state: State,
    lastPayload: null,
    lastResponse: null,
    capturedHeaders: null,
  };

  /* ===========================================================================
   * INTERCEPTION  -  the data source (replaces v1's DOM scraping entirely)
   *
   * Under @grant none we run in page context, so patching window.fetch AND
   * XMLHttpRequest.prototype both work. @run-at document-start means this is
   * installed before Angular makes its first call.
   *
   * The original response is never consumed: fetch is read through .clone().
   * ======================================================================== */

  function isConsigningUrl(u) {
    return typeof u === 'string' && u.indexOf(CONSIGN_MARKER) !== -1;
  }

  function headersFrom(init) {
    try {
      const h = init && init.headers;
      if (!h) return null;
      if (typeof h.forEach === 'function' && typeof h.get === 'function') {
        const o = {};
        h.forEach(function (v, k) { o[k] = v; });
        return o;
      }
      if (typeof h === 'object') return Object.assign({}, h);
    } catch (_) {}
    return null;
  }

  function noteRow(payload, url, headers) {
    const row = asArray(payload)[0];
    if (!row || typeof row !== 'object') return false;
    State.row = row;
    // Stamp the capture. Nothing else invalidates the row within #/workbench -
    // the operator can consign a dozen containers without a route change - so
    // the modal warns on age instead of pretending the row is always current.
    State.rowAt = Date.now();
    if (headers) H.capturedHeaders = headers;
    H.lastPayload = { url: String(url || ''), row: row, at: new Date().toISOString() };
    log('captured', CONSIGN_MARKER, 'container', row.container_no, 'id', row.id,
      'status', row.status && row.status.description);
    // A payload is the positive proof of consigning, so this is also the moment
    // the button becomes legal.
    try { tryInject(); } catch (err) { warn('inject after capture failed', err); }
    return true;
  }

  // The page's real fetch, captured BEFORE the patch so our own calls are never
  // fed back through the interceptor.
  let origFetch = null;

  function installIntercept(win) {
    win = win || window;
    if (win.__edimPatched) return false;

    const of = win.fetch;
    if (typeof of === 'function') {
      origFetch = of;
      win.fetch = function (input, init) {
        const p = of.apply(this, arguments);
        return Promise.resolve(p).then(function (res) {
          try {
            const url = (input && input.url) ? input.url : String(input);
            if (isConsigningUrl(url) && res && typeof res.clone === 'function') {
              res.clone().json().then(function (j) {
                noteRow(j, url, headersFrom(init));
              }).catch(function () {});
            }
          } catch (err) { warn('fetch intercept error', err); }
          return res;
        });
      };
    }

    const XHR = win.XMLHttpRequest;
    if (XHR && XHR.prototype && !XHR.prototype.__edimPatched) {
      const oOpen = XHR.prototype.open;
      const oSetHeader = XHR.prototype.setRequestHeader;

      if (typeof oSetHeader === 'function') {
        XHR.prototype.setRequestHeader = function (name, value) {
          try {
            // ONLY the consigning call's headers are ever mined, so only bag
            // those. Unnarrowed, this allocated a header object for every XHR on
            // every canary7 page - Angular fires a great many - to hold values
            // nothing would ever read. open() runs before setRequestHeader, so
            // __edimUrl is already set by the time we get here.
            if (isConsigningUrl(String(this.__edimUrl || ''))) {
              this.__edimHeaders = this.__edimHeaders || {};
              this.__edimHeaders[name] = value;
            }
          } catch (_) {}
          return oSetHeader.apply(this, arguments);
        };
      }

      XHR.prototype.open = function (method, url) {
        try { this.__edimUrl = url; } catch (_) {}
        const self = this;
        this.addEventListener('load', function () {
          try {
            if (!isConsigningUrl(String(self.__edimUrl || ''))) return;
            const raw = self.responseText;
            if (!raw) return;
            noteRow(JSON.parse(raw), self.__edimUrl, self.__edimHeaders || null);
          } catch (_) {
            // Non-JSON responses are expected on other endpoints; stay quiet.
          }
        });
        return oOpen.apply(this, arguments);
      };
      XHR.prototype.__edimPatched = true;
    }

    win.__edimPatched = true;
    log('interception installed, v' + VERSION);
    return true;
  }

  /* ===========================================================================
   * API  -  every request and response logged
   * ======================================================================== */

  async function apiGet(url) {
    const doFetch = origFetch || (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) {
      const out = { ok: false, kind: 'network', status: 0, raw: 'no fetch available', body: null, url: url };
      H.lastResponse = out;
      return out;
    }
    log('GET', url);
    let res;
    try {
      res = await doFetch(url, { method: 'GET', headers: reqHeaders() });
    } catch (err) {
      const out = {
        ok: false, kind: 'network', status: 0,
        raw: String((err && err.message) || err), body: null, url: url,
      };
      H.lastResponse = out;
      warn('network error', url, out.raw);
      return out;
    }
    let raw = '';
    try { raw = await res.text(); } catch (_) { raw = ''; }
    let body = null;
    try { body = JSON.parse(raw); } catch (_) {}
    const out = {
      ok: !!res.ok, status: res.status, kind: classifyStatus(res.status),
      raw: raw, body: body, url: url,
    };
    H.lastResponse = out;
    log('<-', res.status, String(raw).slice(0, 400));
    return out;
  }

  function describeFailure(r) {
    const lines = [];
    if (r.kind === 'network') {
      lines.push('Network error - the request never reached Canary7.');
      lines.push('Failure type: network');
      lines.push('Detail: ' + r.raw);
      return lines.join('\n');
    }
    lines.push('HTTP ' + r.status + ' (' + r.kind + ')');
    const b = r.body || {};
    if (b.code !== undefined && b.code !== null) lines.push('Business code ' + b.code);
    if (b.message) lines.push(b.message);
    lines.push('Failure type: ' + r.kind);
    lines.push('Raw response: ' + r.raw);
    return lines.join('\n');
  }

  /* ===========================================================================
   * ROUTE GUARD  -  three parts, all must hold
   *
   *   1. location.hash is #/workbench (tolerating a trailing sub-path)
   *   2. a get-consigning-container response has been seen this route session
   *   3. the C7 "Edit Weight" anchor is in the DOM
   *
   * v1 guarded on a regex looking for the word "consign", which the real URL can
   * never satisfy. That is a REGRESSION to guard against, not a fallback to keep.
   * ======================================================================== */

  function isConsignRoute(href, hash) {
    let h = String(hash || '').trim();
    if (!h) {
      const s = String(href || '');
      const i = s.indexOf('#');
      h = i === -1 ? '' : s.slice(i);
    }
    if (!h) return false;
    if (h.charAt(0) !== '#') h = '#' + h;
    return ROUTE_RE.test(h.trim());
  }

  function onRoute() {
    try { return isConsignRoute(location.href, location.hash); } catch (_) { return false; }
  }

  function hasConsigningEvidence() {
    return !!State.row;
  }

  /* ===========================================================================
   * THE BUTTON
   * ======================================================================== */

  const ANCHOR_TEXT = 'Edit Weight';

  /* The single-row container table: a <table> whose <th> texts include both
   * "Container No" and "Weight" [PROBE].
   *
   * THE SCREEN CARRIES FOUR TABLES, not one - Item / an empty one / Container /
   * Shift - so this is a real discriminator rather than a formality. Only the
   * container table has both a "container no" and a "weight" header; the Item
   * table ("Item","Item Description","Total Quantity",…) and the Shift table
   * ("Shift User","Shift Name","Completed","Abandoned") satisfy neither test,
   * and the empty one has no <th> at all.
   *
   * Used only to SCOPE the anchor search - findAnchor() falls back to the whole
   * document if no such table is found, so a header wording change degrades the
   * search rather than killing the button. */
  function findContainerTable(d) {
    let tables;
    try { tables = d.querySelectorAll('table'); } catch (_) { return null; }
    for (let i = 0; i < tables.length; i++) {
      let ths;
      try { ths = tables[i].querySelectorAll('th'); } catch (_) { continue; }
      let hasNo = false;
      let hasWeight = false;
      for (let j = 0; j < ths.length; j++) {
        const t = String(ths[j].textContent || '').trim().toLowerCase();
        if (t.indexOf('container no') !== -1) hasNo = true;
        else if (t.indexOf('weight') !== -1) hasWeight = true;
      }
      if (hasNo && hasWeight) return tables[i];
    }
    return null;
  }

  /* MATCH ON TAG + TEXT, NEVER ON CLASS.
   *
   * The anchor's live class list IS known - "btn btn-primary btn-apply", read
   * straight off the DOM by the console probe of 31 Aug 2026. v2.2.0's header
   * claimed the opposite ("no btn class of any kind") on the strength of the
   * string being absent from an OpenReplay stream that never serialises the
   * attribute; that claim is RETRACTED.
   *
   * Knowing the class list is NOT a reason to select on it. Tag + text is
   * strictly more robust: it matches the live button today, and it keeps
   * matching after any Canary7 restyle that renames btn-apply. So nothing here
   * selects on a class - nor on C7's build-specific Angular content attribute,
   * whose hash changes on every Canary7 build.
   *
   * The BUTTON-inside-TD requirement is not decoration: the same "Edit Weight"
   * text also sits in an <h5> elsewhere in the DOM - the hidden Edit Weight
   * modal's title - and a bare text search would find that instead. A td button
   * carrying DIFFERENT text (a "Print Label" sibling) must not be chosen
   * either, which is why the text is compared exactly. */
  function findAnchor(doc) {
    const d = doc || document;
    const scope = findContainerTable(d) || d;
    let list;
    try { list = scope.querySelectorAll('td button'); } catch (_) { return null; }
    for (let i = 0; i < list.length; i++) {
      if (String(list[i].textContent || '').trim() === ANCHOR_TEXT) return list[i];
    }
    return null;
  }

  function tryInject() {
    if (!onRoute()) return false;
    if (!hasConsigningEvidence()) return false;

    const doc = document;
    const anchor = findAnchor(doc);
    if (!anchor) return false;

    // Idempotency is read from the DOM ONLY. A dataset flag on the C7 anchor
    // would wedge the button out permanently if Angular ever dropped ours.
    if (doc.getElementById(IDS.btn)) return false;
    if (anchor.nextElementSibling && anchor.nextElementSibling.id === IDS.btn) return false;

    const btn = doc.createElement('button');
    btn.id = IDS.btn;
    btn.setAttribute('type', 'button');
    // CLONE the anchor's own classes rather than naming any of C7's. Whatever
    // the consigning screen styles its Edit Weight button with, ours matches -
    // on the live screen that resolves to "btn btn-primary btn-apply" [PROBE],
    // which is exactly the styling we want, obtained without hard-coding one
    // class of C7's here. 'edim-btn' is only our own hook; the screen's
    // own  td … button … { margin-left: 10px }  already spaces siblings, so no
    // competing margin is set for it (see the CSS block).
    btn.className = (anchor.className ? anchor.className + ' ' : '') + 'edim-btn';
    btn.textContent = 'Edit Dimensions';
    btn.addEventListener('click', function () { open(); });

    // A SIBLING. C7's node is not moved, not restyled, not reparented.
    anchor.insertAdjacentElement('afterend', btn);
    log('button injected after the Edit Weight anchor');
    return true;
  }

  function removeButton() {
    const b = document.getElementById(IDS.btn);
    if (b && b.remove) b.remove();
  }

  /* ---------------------------------------------------------------------------
   * OBSERVER LIFECYCLE
   *
   * The observer exists only to catch the consigning screen re-rendering. Off
   * route it has nothing to catch, so leaving it attached means every mutation
   * of whatever screen the operator moved to still schedules a scan for the rest
   * of the session. It is disconnected on the way out and re-attached on the way
   * back in.
   *
   * appRoot() and scheduleScan() are function declarations further down and are
   * hoisted, so calling them from here is safe.
   * ------------------------------------------------------------------------ */
  let observer = null;

  function startObserver() {
    if (observer) return false;
    if (typeof MutationObserver !== 'function') return false;
    const root = appRoot();
    if (!root) return false;
    try {
      observer = new MutationObserver(scheduleScan);
      observer.observe(root, { childList: true, subtree: true });
      return true;
    } catch (err) {
      warn('observer failed', err);
      observer = null;
      return false;
    }
  }

  function stopObserver() {
    if (!observer) return false;
    try { observer.disconnect(); } catch (_) {}
    observer = null;
    return true;
  }

  /* Called on every route poll / hashchange / debounced mutation. */
  function watch() {
    if (!onRoute()) {
      removeButton();
      close({ force: true });
      // The success toast belongs to the screen it was raised on, so it goes
      // with the route - and removeToast() takes its pending auto-dismiss with
      // it, rather than leaving a timer to fire into a document that has moved
      // on. This joins the button, modal and observer teardown already here.
      removeToast();
      // Clear the intercepted payload: it belonged to the route we just left.
      State.row = null;
      State.rowAt = null;
      H.capturedHeaders = null;
      stopObserver();
      return false;
    }
    startObserver();
    return tryInject();
  }

  /* ===========================================================================
   * UI PRIMITIVES  -  createElement + textContent only, never innerHTML
   * ======================================================================== */

  function mk(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  function injectCss() {
    if (document.getElementById(IDS.style)) return;
    const s = document.createElement('style');
    s.id = IDS.style;
    s.textContent = CSS;
    const head = document.head || document.documentElement || document.body;
    if (head) head.appendChild(s);
  }

  function paintCrash(err) {
    try {
      const box = document.getElementById(IDS.crash) || document.createElement('div');
      box.id = IDS.crash;
      box.className = 'edim-crash';
      box.textContent = TAG + ' crashed\n\n' +
        String((err && err.message) || err) + '\n\n' +
        String((err && err.stack) || '(no stack)');
      if (!box.parentElement && document.body) document.body.appendChild(box);
      warn('crash', err);
    } catch (_) {}
  }

  /* A route change force-closes the modal (see watch()), which detaches it even
   * mid-write. The write itself is NOT cancelled - it is already with Canary7 -
   * so its verify result has to land somewhere the operator can still see, or a
   * production write silently loses its outcome. That somewhere is the
   * body-level #edim-crash box, which is not part of the modal and survives. */
  function paintOrphanBox(text) {
    try {
      const box = document.getElementById(IDS.crash) || document.createElement('div');
      box.id = IDS.crash;
      box.className = 'edim-crash';
      box.textContent = TAG + ' the consigning screen was left while a write to Canary7 ' +
        'was still in flight.\nThe write finished after the dialog was gone. Its result:\n\n' +
        String(text || '');
      if (!box.parentElement && document.body) document.body.appendChild(box);
      warn('write outcome painted outside a detached modal', text);
    } catch (_) {}
  }

  /* ---------------------------------------------------------------------------
   * THE SUCCESS TOAST  (v2.5.0)
   *
   * The only thing on this screen that says a write landed. v2.4.0 closes the
   * modal on a verified success, which left the operator with nothing but a
   * console line; this is what replaced that silence.
   *
   * IT IS FIRED FROM EXACTLY ONE PLACE - the last statement of the success path
   * in submit(), after close(). Nothing else may call it. Every failure keeps
   * the modal open and reports itself in the modal, which is where an operator
   * who has to DO something about it is already looking.
   *
   * SHAPE LIFTED FROM malpa-transfer's Status module: '✓' + a headline + N
   * detail lines, on its 'ok' palette. No script in the fleet has a transient
   * notification to copy, so the timer is the new part; the look is not.
   *
   * createElement + textContent ONLY. The container number is API-supplied data
   * and there is no innerHTML anywhere in this file - see the metadata test.
   *
   * IT DOES NOT TRAP FOCUS OR BLOCK THE PAGE. No backdrop, no focus() call, no
   * key listener - only a click handler on its own box, so the screen
   * underneath stays fully usable while it is up.
   * ------------------------------------------------------------------------ */

  // The pending auto-dismiss. Held so a REPLACEMENT toast can cancel it: an
  // uncancelled timer from the previous success would fire against the new
  // toast and cut its life short.
  let toastTimer = null;

  function clearToastTimer() {
    if (toastTimer === null) return;
    try { clearTimeout(toastTimer); } catch (_) {}
    toastTimer = null;
  }

  /* Removes the toast AND its pending timer. Called by the auto-dismiss, by the
   * click handler, by a replacement toast, and by watch() on the way off-route -
   * a timer left running past a route change would fire into a document that
   * has moved on. */
  function removeToast() {
    clearToastTimer();
    const t = document.getElementById(IDS.toast);
    if (t && t.remove) t.remove();
    return !!t;
  }

  function showToast(containerNo, changes) {
    try {
      if (!document.body) return null;
      injectCss();

      // IDEMPOTENT. Any toast already up is removed and ITS TIMER CLEARED before
      // the new one is built, so two successes in a row leave exactly one node
      // and the second gets its full TOAST_MS rather than the first's remainder.
      removeToast();

      const box = mk('div', 'edim-toast');
      box.id = IDS.toast;
      // A live region, not a dialog: announced without stealing focus.
      box.setAttribute('role', 'status');

      box.appendChild(mk('div', 'edim-toast-title', '✓ Saved and verified'));

      const lines = mk('div', 'edim-toast-lines');
      // The container number is API-supplied text. textContent, never markup.
      lines.appendChild(mk('div', 'edim-toast-line', String(containerNo)));
      // Only what actually MOVED. A dimension resubmitted at its existing value
      // is not a change, and weight is never listed at all - this dialog does
      // not edit it, it only carries it through untouched.
      const list = (changes && changes.length) ? changes : ['No dimension changed.'];
      list.forEach(function (t) {
        lines.appendChild(mk('div', 'edim-toast-line', String(t)));
      });
      box.appendChild(lines);

      box.addEventListener('click', function () { removeToast(); });

      document.body.appendChild(box);
      toastTimer = setTimeout(function () {
        toastTimer = null;
        removeToast();
      }, TOAST_MS);
      return box;
    } catch (err) {
      // A toast that fails to paint must never turn a landed, verified write
      // into a crash report. The console line is still the permanent record.
      warn('success toast failed', err);
      return null;
    }
  }

  /* Report a write outcome into the modal it started in - or, if that modal has
   * since been torn out (route change, force-close), into the crash box. The
   * identity check matters as much as the null check: if the operator left the
   * route and came back, a NEW modal is on screen and a stale result must not be
   * painted into it as though it were that modal's own. */
  function reportResult(modalAtStart, text, tone) {
    const now = document.getElementById(IDS.modal);
    if (now && now === modalAtStart) { setMsg(text, tone); return false; }
    paintOrphanBox(text);
    return true;
  }

  function setMsg(text, tone) {
    const el = document.getElementById(IDS.msg);
    if (!el) return;
    el.className = 'edim-msg' + (tone ? ' edim-' + tone : '');
    el.textContent = String(text || '');
  }

  function appendMsg(text) {
    const el = document.getElementById(IDS.msg);
    if (!el) return;
    el.textContent = (el.textContent ? el.textContent + '\n' : '') + String(text);
  }

  function setDisabled(id, off) {
    const el = document.getElementById(id);
    if (!el) return;
    if (off) el.setAttribute('disabled', 'disabled');
    else el.removeAttribute('disabled');
  }

  function setBusy(on) {
    setDisabled(IDS.yes, on);
    setDisabled(IDS.no, on);
    const sp = document.getElementById(IDS.spinner);
    if (sp) {
      sp.style.display = on ? '' : 'none';
      sp.textContent = on ? 'Writing to Canary7…' : '';
    }
  }

  /* ===========================================================================
   * THE MODAL
   * ======================================================================== */

  let escHandler = null;

  function buildModal() {
    const backdrop = mk('div', 'edim-backdrop');
    backdrop.id = IDS.backdrop;
    backdrop.addEventListener('click', function () { close(); });

    const modal = mk('div', 'edim-modal');
    modal.id = IDS.modal;

    const title = mk('div', 'edim-title', 'Edit Dimensions');
    title.id = IDS.title;
    modal.appendChild(title);

    const selRow = mk('div', 'edim-row');
    selRow.appendChild(mk('label', 'edim-label', 'Container'));
    const sel = mk('select', 'edim-select');
    sel.id = IDS.select;
    sel.addEventListener('change', function () { onSelectChange(); });
    selRow.appendChild(sel);
    modal.appendChild(selRow);

    const fields = mk('div', 'edim-row edim-grid');
    fields.id = IDS.fields;
    fields.style.display = 'none';
    // THREE INPUTS. There is no Weight input and no Weight label: the consigning
    // screen's own "Edit Weight" button is the one place weight is edited.
    [
      [IDS.length, 'Length', '1'],
      [IDS.width,  'Width',  '1'],
      [IDS.height, 'Height', '1'],
    ].forEach(function (p) {
      const cell = mk('div', 'edim-cell');
      cell.appendChild(mk('label', 'edim-label', p[1]));
      const inp = mk('input', 'edim-input');
      inp.id = p[0];
      inp.setAttribute('type', 'number');
      inp.setAttribute('min', '0');
      inp.setAttribute('step', p[2]);
      // Deliberately NO inputmode="none" - the operator types in these.
      inp.addEventListener('input', function () { renderDiff(); });
      cell.appendChild(inp);
      fields.appendChild(cell);
    });
    modal.appendChild(fields);

    const diff = mk('div', 'edim-diff', 'Loading containers…');
    diff.id = IDS.diff;
    modal.appendChild(diff);

    const msg = mk('div', 'edim-msg');
    msg.id = IDS.msg;
    modal.appendChild(msg);

    const actions = mk('div', 'edim-actions');
    actions.id = IDS.actions;

    const spinner = mk('span', 'edim-spinner');
    spinner.id = IDS.spinner;
    spinner.style.display = 'none';
    actions.appendChild(spinner);
    actions.appendChild(mk('span', 'edim-spacer'));

    const no = mk('button', 'edim-action edim-no', 'No');
    no.id = IDS.no;
    no.setAttribute('type', 'button');
    // No stays ENABLED while the container list loads - an operator who
    // mis-clicked must always be able to leave.
    no.addEventListener('click', function () { close(); });
    actions.appendChild(no);

    const yes = mk('button', 'edim-action edim-yes', 'Yes');
    yes.id = IDS.yes;
    yes.setAttribute('type', 'button');
    yes.setAttribute('disabled', 'disabled');
    yes.addEventListener('click', function () { submit(); });
    actions.appendChild(yes);

    modal.appendChild(actions);

    document.body.appendChild(backdrop);
    document.body.appendChild(modal);

    escHandler = function (e) {
      if (!e || e.key !== 'Escape') return;
      // Esc must not orphan an in-flight write.
      if (State.submitting) return;
      close();
    };
    document.addEventListener('keydown', escHandler);

    if (sel.focus) sel.focus();
  }

  function open() {
    try {
      if (document.getElementById(IDS.modal)) return;
      State.reset();
      injectCss();
      buildModal();
      // Fire and forget: the modal is already usable (No works) while this runs.
      loadContainers().catch(function (err) { paintCrash(err); });
    } catch (err) {
      paintCrash(err);
    }
  }

  function close(opts) {
    // Never tear the modal down from under an in-flight write.
    if (State.submitting && !(opts && opts.force)) return;
    const m = document.getElementById(IDS.modal);
    const b = document.getElementById(IDS.backdrop);
    if (m && m.remove) m.remove();
    if (b && b.remove) b.remove();
    if (escHandler) {
      try { document.removeEventListener('keydown', escHandler); } catch (_) {}
      escHandler = null;
    }
    State.reset();
    const btn = document.getElementById(IDS.btn);
    if (btn && btn.focus) btn.focus();
  }

  /* ---------------------------------------------------------------------------
   * FALLBACK container-number reader.
   *
   * Used ONLY when the script loaded after the app's own call already fired.
   * It reads ONE value - the container number - and nothing else. These
   * selectors are NOT confirmed; if nothing matches, we say so and stop.
   * ------------------------------------------------------------------------ */
  function readContainerNoFromPage(doc) {
    const d = doc || document;
    const sels = [
      'input[name="container_no"]',
      'input#container_no',
      '[formcontrolname="container_no"]',
      '[data-container-no]',
    ];
    for (let i = 0; i < sels.length; i++) {
      let el = null;
      try { el = d.querySelector(sels[i]); } catch (_) { el = null; }
      if (!el) continue;
      const v = (el.value !== undefined && el.value !== null && String(el.value).trim())
        ? String(el.value)
        : (el.getAttribute ? el.getAttribute('data-container-no') : null);
      if (v && String(v).trim()) return String(v).trim();
    }
    return null;
  }

  async function loadContainers() {
    State.loadingList = true;
    try {
      let row = State.row;

      if (!row) {
        // Nothing intercepted - the script loaded after the app's call.
        const cno = readContainerNoFromPage(document);
        if (!cno) {
          setMsg(
            'No get-consigning-container response was intercepted, and the container ' +
            'number could not be read from the page.\n' +
            'Reload the consigning screen so the script can see the call, then try again.\n' +
            'Nothing was sent to Canary7.', 'error');
          setDiffText('Nothing loaded.');
          return;
        }
        State.usedFallback = true;
        State.warnings.push('Container number "' + cno + '" was read from the page, not intercepted - verify it before saving.');
        const r = await apiGet(consigningUrl(cno));
        if (!r.ok) {
          setMsg('Fallback lookup for container "' + cno + '" failed.\n' + describeFailure(r), 'error');
          setDiffText('Nothing loaded.');
          return;
        }
        row = asArray(r.body)[0] || null;
        if (!row) {
          setMsg('Fallback lookup for container "' + cno + '" returned no container.\n' +
            'Not guessing an id.\nRaw response: ' + r.raw, 'error');
          setDiffText('Nothing loaded.');
          return;
        }
        State.row = row;
        State.rowAt = Date.now();
      }

      // NOTE: no State.locationId. submit() takes dockIdOf() of the SELECTED
      // container, which is the only correct source once a list is on screen.
      State.shipmentHeaderId = row.shipment_header_id;

      // Nothing invalidates a captured row while the operator stays inside
      // #/workbench - they can consign container after container without a
      // single route change - so an old capture may describe a container that
      // has since moved on. Warn, never block.
      if (!State.usedFallback && State.rowAt) {
        const ageMs = Date.now() - State.rowAt;
        if (ageMs > STALE_ROW_MS) {
          State.warnings.push('The container on screen was captured ' +
            Math.round(ageMs / 1000) + 's ago and may be out of date - ' +
            'check the values against Canary7 before saving.');
        }
      }

      if (row.status && row.status.description &&
          String(row.status.description) !== 'Consigning Pending') {
        State.warnings.push('Container status is "' + row.status.description +
          '", not "Consigning Pending".');
      }

      if (!State.shipmentHeaderId) {
        setMsg('The intercepted container has no shipment_header_id, so the container ' +
          'list cannot be filtered.\nNot falling back to shipment_id - Canary7 ignores it ' +
          'and returns unrelated containers.\nNothing was sent to Canary7.', 'error');
        setDiffText('Nothing loaded.');
        return;
      }

      const lr = await apiGet(listUrl(State.shipmentHeaderId));
      if (!lr.ok) {
        setMsg('Could not load the container list.\n' + describeFailure(lr), 'error');
        setDiffText('Nothing loaded.');
        return;
      }
      State.containers = asArray(lr.body);
      if (!State.containers.length) {
        setMsg('The container list for shipment_header_id ' + State.shipmentHeaderId +
          ' came back empty.\nRaw response: ' + lr.raw, 'error');
        setDiffText('Nothing loaded.');
        return;
      }
      renderSelect();
    } finally {
      State.loadingList = false;
    }
  }

  function setDiffText(t) {
    const el = document.getElementById(IDS.diff);
    if (el) el.textContent = String(t);
  }

  function renderSelect() {
    const sel = document.getElementById(IDS.select);
    if (!sel) return;

    while (sel.firstChild) sel.removeChild(sel.firstChild);

    const ph = mk('option', 'edim-option', 'Select a container…');
    ph.value = '';
    ph.setAttribute('value', '');
    sel.appendChild(ph);

    State.containers.forEach(function (c) {
      // THE LABEL IS THE CONTAINER NUMBER, AND NOTHING ELSE (v2.4.0). Container
      // numbers are unique, so the old "— weight 0.84, 6×2×5" suffix added no
      // information and read as clutter.
      const o = mk('option', 'edim-option', String(c.container_no));
      o.value = String(c.id);
      o.setAttribute('value', String(c.id));
      sel.appendChild(o);
    });

    const wanted = State.row ? String(State.row.id) : '';
    const found = State.containers.some(function (c) { return String(c.id) === wanted; });
    if (wanted && found) {
      sel.value = wanted;
      State.selectedId = wanted;
    } else {
      sel.value = '';
      State.selectedId = null;
      State.warnings.push('The container on screen (' + (State.row ? State.row.container_no : '?') +
        ') is not in the list for this shipment - pick one manually.');
    }

    onSelectChange();
  }

  function currentContainer() {
    const sel = document.getElementById(IDS.select);
    const id = sel ? String(sel.value || '') : '';
    if (!id) return null;
    for (let i = 0; i < State.containers.length; i++) {
      if (String(State.containers[i].id) === id) return State.containers[i];
    }
    return null;
  }

  function onSelectChange() {
    const c = currentContainer();
    const fields = document.getElementById(IDS.fields);
    State.selectedId = c ? String(c.id) : null;

    if (!c) {
      if (fields) fields.style.display = 'none';
      setDisabled(IDS.yes, true);
      setDiffText('Pick a container to edit.');
      renderWarnings();
      return;
    }

    if (fields) fields.style.display = '';
    FIELDS.forEach(function (p) {
      const inp = document.getElementById(IDS['' + p[0]]);
      if (inp) inp.value = (c[p[0]] === null || c[p[0]] === undefined) ? '' : String(c[p[0]]);
    });
    setDisabled(IDS.yes, false);
    renderDiff();
    renderWarnings();
  }

  /* Normalise HERE - at the single point where operator text becomes data -
   * so validateDims() and buildWriteParams() can never disagree about a value.
   *
   * The case that forced this: '1e3'. validateDims() coerced it with Number()
   * and saw a valid 1000, but buildWriteParams() received the untouched STRING
   * and the URL went out as length=1e3. What was validated was not what was
   * sent. Anything Number() cannot resolve is passed through UNCHANGED so that
   * validateDims() can still name the offending field ('abc' -> "must be a
   * number"), and blank stays blank so it can still say "is required".
   *
   * READS THE THREE DIMENSIONS ONLY. There is no weight input to read; the
   * weight that goes out is taken from the container record in submit(). */
  function readInputs() {
    const out = {};
    FIELDS.forEach(function (p) {
      const inp = document.getElementById(IDS['' + p[0]]);
      const raw = inp ? inp.value : '';
      if (raw === null || raw === undefined || String(raw).trim() === '') {
        out[p[0]] = '';
        return;
      }
      const n = Number(raw);
      out[p[0]] = isFinite(n) ? n : raw;
    });
    return out;
  }

  function renderDiff() {
    const el = document.getElementById(IDS.diff);
    if (!el) return;
    const c = currentContainer();
    el.textContent = '';
    if (!c) { el.textContent = 'Pick a container to edit.'; return; }
    const dims = readInputs();
    el.appendChild(mk('div', 'edim-diff-head', 'Container ' + String(c.container_no)));
    FIELDS.forEach(function (p) {
      el.appendChild(mk('div', 'edim-diff-line',
        p[1] + ': ' + fmt(c[p[0]]) + ' → ' + fmt(dims[p[0]])));
    });
  }

  /* An error already on screen OUTRANKS a warning. onSelectChange() calls this
   * on every select change, so without the guard an operator who hit a
   * validation error ("Length must be greater than 0. Nothing was sent to
   * Canary7.") and then changed container would watch that error be replaced by
   * a stale warning from load time - reading as though the problem had gone
   * away. The tone class is the record of what is currently displayed. */
  function renderWarnings() {
    if (!State.warnings.length) return;
    const el = document.getElementById(IDS.msg);
    if (el && String(el.className || '').split(/\s+/).indexOf('edim-error') !== -1) return;
    setMsg(State.warnings.join('\n'), 'warn');
  }

  /* ===========================================================================
   * THE WRITE  -  production, against live stock
   * ======================================================================== */

  async function submit() {
    // Everything - guards and validation included - lives inside this try.
    // submit() is async, so a throw outside it would be an unhandled rejection
    // with no crash paint at all.
    let sent = false;
    // Only the invocation that actually CLAIMED the in-flight slot may release
    // it. Without this, a blocked double-submit would fall straight through to
    // finally{} and clear the flag out from under the live write - which is
    // exactly how the second of three rapid clicks got a write away.
    let owned = false;
    // The modal this write started in. A route change force-closes and detaches
    // it (watch() -> close({force:true})); the write is already with Canary7 and
    // is NOT cancelled, so the result is reported against THIS node or, if it is
    // gone, into the body-level crash box. See reportResult().
    let myModal = null;
    try {
      if (State.submitting) { log('double-submit ignored'); return; }

      const c = currentContainer();
      if (!c) { setMsg('Pick a container first. Nothing was sent to Canary7.', 'error'); return; }

      const dims = readInputs();
      const errs = validateDims(dims);
      if (errs.length) {
        setMsg(errs.join('\n') + '\nNothing was sent to Canary7.', 'error');
        return;
      }

      const locId = dockIdOf(c);
      if (locId === null || locId === undefined || locId === '') {
        setMsg('Container ' + c.container_no + ' has no staging_dock_id, so close_to_location_id ' +
          'cannot be built.\nNot guessing a location id.\nNothing was sent to Canary7.', 'error');
        return;
      }

      /* THE WEIGHT THAT GOES OUT IS THE SELECTED CONTAINER'S CURRENT WEIGHT,
       * UNCHANGED, STRAIGHT OFF ITS CONTAINER RECORD.
       *
       * WHY IT IS SENT AT ALL, given that this modal no longer edits it:
       * close-to-container takes weight/length/width/height as one set, and
       * buildQuery() drops params that are null/undefined/'' - so leaving weight
       * out would put a write on the wire with no weight at all and risk Canary7
       * storing 0 against a container whose weight nobody asked to change.
       * Echoing the stored value back is the only way to change the three
       * dimensions while provably leaving the fourth alone.
       *
       * c is the SELECTED container, so this is that container's weight - not
       * the intercepted row's, which is a different container the moment the
       * operator picks a sibling. It is never a literal and never typed. */
      const currentWeight = c.weight;
      if (currentWeight === null || currentWeight === undefined || currentWeight === '') {
        setMsg('Container ' + c.container_no + ' has no weight on record, and ' +
          'close-to-container must be given one.\nSending the write without it could zero ' +
          'the stored weight, and this dialog does not edit weight - use the screen\'s own ' +
          'Edit Weight button first.\nNothing was sent to Canary7.', 'error');
        return;
      }

      // What goes ON THE WIRE: the three edited dimensions plus the untouched
      // weight. This is also what the re-read is verified against, so a weight
      // that comes back changed is reported as a failure.
      const submitted = {
        weight: currentWeight,
        length: dims.length,
        width:  dims.width,
        height: dims.height,
      };

      const warns = maxWarnings(c, dims);
      const params = buildWriteParams(locId, c.id, submitted);
      const url = apiUrl(ROUTES.write, params);

      State.submitting = true;
      owned = true;
      myModal = document.getElementById(IDS.modal);
      setBusy(true);
      renderDiff();
      setMsg((warns.length ? warns.join('\n') + '\n' : '') + 'Writing…', warns.length ? 'warn' : null);

      sent = true;
      const wr = await apiGet(url);

      // DO NOT TRUST THE RESPONSE. Canary7 writes echo pre-write state and
      // business rejections arrive as HTTP 500 with a numeric code. Re-read.
      //
      // The re-read is of the SELECTED container - c.container_no - never of the
      // intercepted row. Those differ the moment the operator picks a sibling.
      const rr = await apiGet(consigningUrl(c.container_no));
      let fresh = rr.ok ? (asArray(rr.body)[0] || null) : null;

      // get-consigning-container is the consigning screen's OWN lookup: it
      // answers "which container is being consigned", not "give me container
      // X". For a SIBLING container on the same shipment - which the select
      // legitimately offers - it can come back empty even though the write
      // landed perfectly, and reporting that as VERIFY FAILED would send an
      // operator to re-check a container that is already correct.
      //
      // shipment-container&container_no=<n> is confirmed (prompt section 5) to
      // return the same row, so try it before concluding anything.
      let rr2 = null;
      if (!fresh) {
        rr2 = await apiGet(containerByNoUrl(c.container_no));
        if (rr2.ok) {
          const rows = asArray(rr2.body);
          // Filter: the list endpoint answers with an array, and only the row
          // that actually IS this container may be used to verify it.
          for (let i = 0; i < rows.length; i++) {
            if (rows[i] && String(rows[i].container_no) === String(c.container_no)) {
              fresh = rows[i];
              break;
            }
          }
        }
      }

      // VERIFY_FIELDS, so the untouched weight is compared too: it was sent back
      // exactly as Canary7 gave it to us, so it must return exactly as sent. A
      // weight that has moved means the write disturbed a field it was only
      // carrying, and that is a genuine failure - reported, never excused.
      const cmp = compareDims(fresh, submitted);
      State.lastVerify = {
        submitted: submitted, reread: fresh, cmp: cmp,
        write: wr, verify: rr, verifyFallback: rr2,
      };

      if (cmp.ok) {
        const lines = ['Saved and verified.'];
        lines.push('Container ' + c.container_no);
        FIELDS.forEach(function (p) {
          lines.push(p[1] + ': ' + fmt(c[p[0]]) + ' → ' + fmt(dims[p[0]]));
        });
        if (warns.length) lines.push('', 'Warnings:', warns.join('\n'));
        const text = lines.join('\n');

        /* THE TOAST'S CHANGE LINES, BUILT HERE AND NOT LATER.
         *
         * c[...] still holds the container's PRE-write values at this point;
         * the VERIFY_FIELDS loop a few lines below overwrites them with what
         * Canary7 now returns. Read them after that and every line would say
         * "10 → 10". Unlike the console line above, only dimensions that
         * actually MOVED are listed - resubmitting 6 as 6 is not a change - and
         * weight is never listed, because this dialog carries it through
         * unchanged rather than editing it. */
        const toastChanges = [];
        FIELDS.forEach(function (p) {
          if (changed(c[p[0]], dims[p[0]])) {
            toastChanges.push(p[1] + ' ' + fmt(c[p[0]]) + ' → ' + fmt(dims[p[0]]));
          }
        });
        const toastContainerNo = c.container_no;

        // Keep the in-memory row in step with what Canary7 now holds - but ONLY
        // when the container just written is the one on screen. Overwriting the
        // intercepted row with a sibling's would leave the screen and the state
        // describing two different containers.
        if (fresh && State.row && String(State.row.id) === String(c.id)) {
          State.row = fresh;
          State.rowAt = Date.now();
        }
        // Weight included: the record must stay in step with the value the next
        // write will echo back to Canary7.
        VERIFY_FIELDS.forEach(function (p) { c[p[0]] = fresh ? fresh[p[0]] : submitted[p[0]]; });
        renderDiff();

        /* THE MODAL CLOSES HERE - AND ONLY HERE (v2.4.0).
         *
         * This is the last statement of the success path. The write went out and
         * an INDEPENDENT re-read agreed with it; nothing about that verification
         * was weakened or skipped to get here. Every failure branch - network,
         * 4xx, 500-with-a-code, a re-read that does not match, or a throw - ends
         * up somewhere else and leaves the modal standing.
         *
         * The console line is not decoration. With the dialog gone it is the
         * operator's only record that the write landed, so it is emitted whether
         * or not there is still a modal to close. No floating toast was invented
         * for this, and #edim-crash is not reused: that box means "something went
         * wrong", and a routine success in it would train people to ignore it. */
        log(text.replace(/\n/g, ' | '));

        const orphaned = reportResult(myModal, text, 'good');
        if (!orphaned) {
          // close() refuses to tear a modal down while State.submitting is set.
          // That guard protects an IN-FLIGHT write; this one has landed and been
          // verified, so release the flag and close normally rather than forcing
          // past a guard that is still doing its job elsewhere.
          State.submitting = false;
          setBusy(false);
          owned = false;                    // finally{} must not clear it twice
          const verified = State.lastVerify; // close() -> State.reset() drops it,
          close();                           // and the debug handle still needs
          State.lastVerify = verified;       // the outcome of the write just done

          /* AND THE TOAST - THE LAST STATEMENT OF THE SUCCESS PATH (v2.5.0).
           *
           * AFTER close(), deliberately: the operator sees the dialog go and
           * the confirmation arrive, rather than a notification appearing over
           * a modal that is about to vanish. This line is unreachable unless
           * cmp.ok held AND the modal this write started in was still on
           * screen, which is exactly the definition of a verified success on
           * the screen the operator is still standing on. */
          showToast(toastContainerNo, toastChanges);
        }
        // If it WAS orphaned there is nothing of ours left to close: the result
        // has gone to the crash box, and any modal now on screen is a FRESH one
        // the operator opened after the route change. Closing that would tear
        // down a dialog this write has nothing to do with.
        //
        // AND NOTHING IS TOASTED THERE EITHER. The operator has left the
        // consigning screen; #edim-crash is a PERSISTENT report they can read
        // whenever they notice it, whereas a toast that expires in TOAST_MS on
        // whatever screen they moved to is a weaker duplicate that can be gone
        // before it is seen. One surface per outcome, and for the orphan that
        // surface is the crash box.
      } else {
        const lines = ['VERIFY FAILED - the re-read does not match what was submitted.'];
        lines.push('Container ' + c.container_no);
        cmp.mismatches.forEach(function (m) {
          lines.push(m.field + ': submitted ' + fmt(m.submitted) + ', re-read ' + fmt(m.actual));
        });
        lines.push('');
        lines.push('Write HTTP ' + wr.status + ' (' + wr.kind + ')');
        lines.push('Raw write response: ' + wr.raw);
        lines.push('Re-read HTTP ' + rr.status + ' (' + rr.kind + ')');
        lines.push('Raw re-read response: ' + rr.raw);
        if (rr2) {
          lines.push('Fallback re-read (shipment-container&container_no) HTTP ' +
            rr2.status + ' (' + rr2.kind + ')');
          lines.push('Raw fallback response: ' + rr2.raw);
        }
        lines.push('');
        lines.push('Not retrying automatically. Check the container in Canary7 before trying again.');
        reportResult(myModal, lines.join('\n'), 'error');
      }
    } catch (err) {
      if (!sent) {
        setMsg('Crashed before the request was built - NOTHING WAS SENT TO CANARY7.\n' +
          String((err && err.message) || err) + '\n' +
          String((err && err.stack) || '(no stack)'), 'error');
      } else {
        reportResult(myModal,
          'The write was SENT to Canary7 and then failed while being handled.\n' +
          'Check the container in Canary7 before retrying.\n' +
          String((err && err.message) || err) + '\n' +
          String((err && err.stack) || '(no stack)'), 'error');
      }
      paintCrash(err);
    } finally {
      if (owned) {
        State.submitting = false;
        setBusy(false);
      }
    }
  }

  /* ===========================================================================
   * BOOT
   * ======================================================================== */

  installIntercept(typeof window !== 'undefined' ? window : null);

  function appRoot() {
    try {
      return document.querySelector('app-dashboard') ||
             document.querySelector('div.app-body') ||
             document.body || null;
    } catch (_) { return null; }
  }

  // `observer` and its start/stop pair live up with watch(), which owns the
  // route-change lifecycle.
  let rafPending = false;

  // A MutationObserver on a busy Angular screen fires constantly; without this
  // debounce every mutation would run a full querySelectorAll.
  function scheduleScan() {
    if (rafPending) return;
    rafPending = true;
    const raf = (typeof requestAnimationFrame === 'function')
      ? requestAnimationFrame
      : function (f) { return setTimeout(f, 16); };
    raf(function () {
      rafPending = false;
      try { watch(); } catch (err) { warn('scan failed', err); }
    });
  }

  function boot(attempt) {
    const root = appRoot();
    if (!root) {
      if ((attempt || 0) < 200) setTimeout(function () { boot((attempt || 0) + 1); }, 300);
      return;
    }
    // watch() attaches the observer when on-route and disconnects it when off,
    // so booting off-route correctly leaves nothing observing.
    try { watch(); } catch (err) { warn('initial watch failed', err); }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('hashchange', function () {
        try { watch(); } catch (_) {}
      });
    }
    try { setInterval(function () { try { watch(); } catch (_) {} }, 1500); } catch (_) {}
  }

  try {
    if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
      document.addEventListener('DOMContentLoaded', function () { boot(0); });
    } else {
      boot(0);
    }
  } catch (err) {
    warn('boot failed', err);
  }

  /* ===========================================================================
   * DEBUG HANDLE
   * ======================================================================== */

  H.open = open;
  H.close = close;
  H.tryInject = tryInject;
  H.watch = watch;
  H.findAnchor = findAnchor;
  H.findContainerTable = findContainerTable;
  H.isConsignRoute = isConsignRoute;
  H.hasConsigningEvidence = hasConsigningEvidence;
  H.installIntercept = installIntercept;
  H.isConsigningUrl = isConsigningUrl;
  H.noteRow = noteRow;
  H.apiBase = apiBase;
  H.warehouseId = warehouseId;
  H.apiUrl = apiUrl;
  H.buildQuery = buildQuery;
  H.consigningUrl = consigningUrl;
  H.listUrl = listUrl;
  H.containerByNoUrl = containerByNoUrl;
  H.buildWriteParams = buildWriteParams;
  H.validateDims = validateDims;
  H.compareDims = compareDims;
  // H.optionLabel is gone with optionLabel() itself - see v2.4.0 change 3.
  H.maxWarnings = maxWarnings;
  H.asArray = asArray;
  H.classifyStatus = classifyStatus;
  H.dockIdOf = dockIdOf;
  H.hasToken = hasToken;
  H.reqHeaders = reqHeaders;
  H.mkHeaders = mkHeaders;
  H.readContainerNoFromPage = readContainerNoFromPage;
  H.submit = submit;
  H.changed = changed;
  H.removeToast = removeToast;
  // The pending auto-dismiss, read through a getter because it is a `let` that
  // is reassigned - a plain reference would freeze at null. The harness uses it
  // to prove a replacement toast really cancels the previous timer rather than
  // inheriting its deadline. showToast() is NOT exposed: the toast has exactly
  // one legitimate caller, the success path in submit(), and a console handle
  // for raising a "Saved and verified" notice with no write behind it is the
  // one debugging convenience this script should not offer.
  H.toastTimer = function () { return toastTimer; };

  try { window.__editDims = H; } catch (_) {}

  log('booted v' + VERSION);
})();

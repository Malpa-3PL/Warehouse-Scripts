# Malpa Edit Dimensions

`malpa-editdims.user.js` · v2.5.0 · Tampermonkey · Canary7 consigning screen

---

## TL;DR

**What it is.** A Tampermonkey userscript that adds an **Edit Dimensions** button next to the
**Edit Weight** button on Canary7's consigning screen. Click it, pick a container, correct its
length / width / height, hit Yes.

**Why it exists.** Canary7 lets a consigning operator fix a container's *weight* and nothing else.
Wrong dimensions mean wrong carrier cubing, and the only fix was a support ticket.

**What you need to know before touching it.** It writes to live stock in the real warehouse. It
reads the screen's own API traffic rather than scraping the page. And it never trusts what the
write returns — it re-reads and compares before telling anyone it worked.

---

## How it works, in five steps

This is a genuine sequence — each step gates the next, and a newcomer debugging "the button isn't
there" is really asking which of these stopped.

**1. It loads before Angular does.**
`@run-at document-start` on `https://*.canary7.com/*`, with `@grant none` so it runs in the page's
own context.

**2. It listens to the screen's own API calls.**
It patches `fetch` and `XMLHttpRequest` and watches for `get-consigning-container`. That one
response carries everything the script needs — container id, staging dock, current dimensions,
shipment id — so there is *no DOM scraping anywhere*.

**3. Three things must be true before the button appears.**
The route is `#/workbench`, a `get-consigning-container` payload has been captured, and the
**Edit Weight** button is on the page. Any one missing and nothing injects.

**4. The modal loads the shipment's containers.**
One select (single-choice), then Length / Width / Height inputs prefilled from the chosen
container. Weight is deliberately *not* editable here — that's what the Edit Weight button is for.

**5. Yes writes, then proves it.**
One GET to `close-to-container`, then an independent re-read comparing all four values. Match →
modal closes and a green toast appears. Mismatch or error → modal stays open showing exactly what
happened.

---

## The two files

**`malpa-editdims.user.js`** — the script. Everything is in it: constants, auth, interception, UI,
write path. The header comment at the top is long on purpose: it records what was confirmed against
the live system, how, and when, plus an **ASSUMED / NOT CONFIRMED** block. Read that block before
you change behaviour.

**`malpa-editdims.test.js`** — an offline harness with a hand-rolled DOM and fetch stub. No npm, no
install:

```
node malpa-editdims.test.js     # 715 assertions, must print GREEN
```

Inside the script, the sections you'll actually visit are `findAnchor()` / `findContainerTable()`
(where the button goes), `installIntercept()` (where the data comes from), `watch()` (route changes
and cleanup), and `submit()` (the write and its verification).

---

## The knobs

Near the top of the script. These are the values most likely to need changing, and each one has a
reason it is what it is.

| Constant | Value | Why |
|---|---|---|
| `ROUTE_RE` | `#/workbench` | The consigning screen's hash. Generic — the payload and anchor checks are what make it specific. |
| `PROFILE_ID` | `7` | "Default Consigning". The tenant only has profiles 6, 7, 8 and 10. |
| `API_ROOT` | `stgauth.canary7.com` | The monolith API. The UI is on *malpa*.canary7.com — two different hosts, both matched. |
| `WAREHOUSE_ID` | `10` | Darra. The only live warehouse. Never target 9. |
| `CONSIGN_MARKER` | `get-consigning-container` | The URL fragment the interception watches for. Change this and the script goes blind. |
| `TOAST_MS` | `6000` | How long the success toast stays up. |
| `STALE_ROW_MS` | `60000` | Past this, the modal warns that the captured container may be stale. Warns, never blocks. |

---

## Four things that will bite you

Every one of these cost a debugging round. They're written down so the next person doesn't pay
twice.

### 1. The hash is `#/workbench`, not `#/workbenchv`

The word "consign" appears nowhere in the URL, so an obvious guard like `/consign/i` can never
match. Worse, when the route check fails, `watch()` clears the captured payload on every tick — so
a one-character route bug looks like *two* unrelated failures at once.

> **How we learned it:** by misreading a binary OpenReplay stream, where the byte before the URL was
> a length prefix (`%` = 37 = the length of the URL) and its neighbour got read as a trailing `v`.
> Two rounds lost to inference. One line pasted from the browser console settled it.

### 2. Find the button by its text, never by its class

The anchor is a `<button>` inside a `<td>` whose text is exactly `Edit Weight`, in the table headed
*Container No / Location / Container Type / Weight* — the third of four tables on that page. It does
carry `btn btn-primary btn-apply` today, but the matcher ignores that on purpose, and our button
clones whatever classes the anchor has so it always looks native.

Two traps in the DOM: the `_ngcontent-ng-c…` attribute hash **changes on every Canary7 build**, and
there's a hidden `<h5>Edit Weight</h5>` — the Edit Weight modal's title — that a naive text search
will happily grab.

### 3. Two Canary7 quirks that fail silently

Filtering containers by `shipment_id` is **silently ignored** — you get a page of unrelated
containers with a 200. Use `shipment_header_id`.

Container numbers contain `#` (e.g. `LA_TEST_SHIPMENT_20250822.1##7`). An unencoded `#` truncates
the URL at the fragment. Every URL is built with `URLSearchParams` — keep it that way.

### 4. Never trust what a write returns

Canary7 writes can echo *pre-write* state, and business rejections arrive as HTTP 500 with a numeric
code rather than a 4xx. So the script re-reads the container after every write and compares all four
values before reporting success.

Weight is in that comparison even though it isn't editable: it's passed through unchanged, so if it
comes back different, the write disturbed something it was only meant to carry. That's a failure,
and it's reported as one.

---

## Making a change

1. **Read the header comment first.** Especially the ASSUMED / NOT CONFIRMED block — it tells you
   what's actually verified against the live system versus what's a reasonable guess.
2. **Edit the script.** Keep the `edim` prefix on every id and class, and keep using `createElement`
   + `textContent` — never `innerHTML`, because container numbers are API-supplied data.
3. **Bump the version in two places:** the `@version` metadata line and the internal `VERSION`
   constant. If they drift, the handhelds won't auto-update — and the tests fail on purpose if they
   do.
4. **Run `node malpa-editdims.test.js`.** It must be green before anything else.
5. **Prove your new test actually bites.** Copy the script to a scratch file, break the exact thing
   your test is meant to catch, and confirm the suite goes red. A test that passes against broken
   code is worse than no test — this suite has caught two tautological assertions already.
6. **Ship it** with the `release-userscript` skill, which bumps, tests, pushes and verifies the raw
   URL serves the new version.

### When something's wrong on the live screen

Open the consigning screen, F12, and paste this. It answers "is it installed", "did it capture",
"can it find the button" in one go:

```js
(()=>{const D=window.__editDims;
const hits=[...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='Edit Weight');
console.log('version:', D ? D.VERSION : 'SCRIPT NOT LOADED');
console.log('row captured:', !!(D&&D.state&&D.state.row), '| hash:', location.hash);
console.log('our button present:', !!document.getElementById('edim-btn'));
console.log('Edit Weight buttons:', hits.length);
hits.forEach((b,i)=>console.log(i,'inTD:',!!b.closest('td'),'class:',JSON.stringify(b.className)));
if(D&&D.tryInject){D.tryInject();console.log('after tryInject:', !!document.getElementById('edim-btn'));}
})()
```

`window.__editDims` also exposes `state`, `lastPayload`, `lastResponse`, `capturedHeaders`,
`open()`, `close()`, `tryInject()` and `watch()`. Everything the script does logs under
`[Edit Dims]`.

---

## Before you touch the write path

> **Production.** There is no Canary7 sandbox. Every write hits real stock in warehouse 10. The only
> safe place to test is **MA-TRL (company 46)**, the designated trial account — test shipment
> `LA_TEST_SHIPMENT_20250822.1##7` was used throughout.
>
> Pacing matters too: the proxy revokes the token on bulk mutation, so never loop writes.

---

# malpa-openreplay

**Steals Canary7's session recorder and points it at our own server.**

---

## TL;DR

Canary7 already runs an OpenReplay tracker on every page. It's aimed at a dead host
(`openreplay.canary7.com`) with a key our server rejects, so the recordings go nowhere.

OpenReplay only allows **one tracker per page**, so we can't just add our own alongside it.
Instead this script sits in front of every network call the page makes and rewrites two things:

| What | From | To |
|---|---|---|
| **Host** | `openreplay.canary7.com` | `replay.malpasoft.com` |
| **Project key** (in the `/ingest/v1/web/start` body only) | `iAlX3UIW9hXkdmw9uho1` (C7's) | `XM93gZiNw5XkowtXrvvO` (ours) |

Everything else C7 sends — user IDs, tracker version, tokens, event batches — passes through
untouched. C7's tracker thinks nothing changed; our box receives the sessions.

**There is no UI.** Nothing appears on screen. The only sign it's working is the console.

---

## The one thing you need to understand

A page makes network calls from **two separate JavaScript worlds**, and OpenReplay uses both:

- **Main thread** — sends `/start` (session handshake, contains the project key) and feature flags.
- **A Web Worker** — sends `/ingest/v1/web/i`, which is the actual session data. This is the payload
  that matters.

A Web Worker has its own `fetch`, its own `XMLHttpRequest`, its own everything. Patching
`window.fetch` does **nothing** to it. This is the trap that makes the script look longer than it
should be.

So we cover the worker sideways, by rewriting the URL *before* the worker ever sees it:

1. **`Worker.prototype.postMessage`** — the main thread hands the ingest URL to the worker through
   here. We deep-scan the message (strings, arrays, objects, recursively) and swap the host.
2. **`Blob`** — OpenReplay builds its worker from a Blob of source code, and the host can be baked
   into that source. We swap it in the Blob contents before the worker is constructed.

Miss either one and you'll see the session *start* on our server but never receive any events —
which looks like "it's working" until you try to play a recording back and it's empty.

---

## Map of the file

| Lines | What | Touch it? |
|---|---|---|
| 1–12 | Tampermonkey metadata | Only to bump `@version` |
| 14–38 | Explanatory comment | Keep it honest if you change behaviour |
| 43–47 | **Config constants** | **Yes — 95% of edits are here** |
| 49–84 | Helpers: `swapHost`, `rewriteUrl`, `rewriteBody`, `deepSwap` | Rarely |
| 86–120 | Main thread patches: XHR, fetch, sendBeacon | Rarely |
| 122–152 | Worker patches: postMessage, Blob | Rarely, and carefully |
| 154 | Startup log line | Update if you change what it claims |

---

## Making common changes

### Move to a different replay server
Change `NEW_HOST` (line 44) **and** `OUR_KEY` (line 46). The key is per-project on the OpenReplay
box — a new server means a new project key, and a mismatched key means the session is silently
rejected at `/start`. Bump `@version`.

### Canary7 changes its own key or host
Change `C7_KEY` (line 45) or `OLD_HOST` (line 43). You'll notice this when the console goes quiet
and no sessions arrive. Find the new values in DevTools → Network → the `/ingest/v1/web/start`
request.

### Add another host to rewrite
Don't add a second constant — generalise `swapHost` into a loop over a list of pairs, and make sure
`deepSwap` and `PatchedBlob` still call it. Both of those already route through `swapHost`, so
changing it in one place is enough.

### Turn the logging down
Delete or comment the `console.log(TAG, ...)` calls. Leave the one on line 154 — it's how you
confirm the script loaded at all.

---

## Two rules you must not break

**1. `@run-at document-start`.**
We have to replace `fetch`, `XMLHttpRequest`, `Blob` and `Worker.postMessage` *before* C7's tracker
script runs. At `document-idle` the tracker has already grabbed the originals and our patches do
nothing. If you change this line, the script stops working and gives you no error.

**2. `@grant none`.**
With any `@grant`, Tampermonkey runs the script in a sandboxed `window` proxy, and **assigning
`window.fetch` stops affecting the page**. (Prototype patches like `XMLHttpRequest.prototype.open`
survive the sandbox; direct assignment doesn't.) So half the script would silently go dead. This is
a house rule across all the Malpa scripts — a grant is only for reaching a non-Canary7 host, and we
don't need one here.

---

## How to test

1. Open `https://malpa.canary7.com/` with the script enabled.
2. Open DevTools console. You should see:
   ```
   [Malpa OR Redirect] v0.3.0 active — host openreplay.canary7.com => replay.malpasoft.com | ...
   [Malpa OR Redirect] url https://openreplay.canary7.com/... -> https://replay.malpasoft.com/...
   [Malpa OR Redirect] swapped projectKey in start body
   ```
   No `swapped projectKey` line = the key swap didn't fire and the session will be rejected.
3. DevTools → Network, filter `replay.malpasoft.com`. You want **both**:
   - `POST /ingest/v1/web/start` → 200
   - repeated `POST /ingest/v1/web/i` → 200 ← *this is the one people forget to check*

   If you see `start` but no `i`, a worker patch is broken.
4. Confirm a playable session actually appears in the OpenReplay dashboard. A 200 on `/i` is not
   proof the recording is usable.

---

## Gotchas already found

- **`deepSwap` mutates in place.** It rewrites the caller's object rather than cloning it. Fine
  today, but if OpenReplay ever reuses a message object you'll have changed their copy too.
- **`PatchedBlob` also mutates in place** — it edits the `parts` array it was handed.
- **`window.Blob` is no longer the native constructor** after this script runs. `instanceof Blob`
  still works (the prototype is shared), but `Blob(...)` called *without* `new` would throw where
  before it also threw — behaviour is preserved, just be aware the global is ours now. Any other
  script on the page that does something exotic with `Blob` is interacting with our wrapper.
- **`@match` is listed twice** (lines 6–7). `https://*.canary7.com/*` already covers
  `malpa.canary7.com`. Harmless, just redundant.
- **Version skew.** C7 ships tracker v11.0.6; our backend is newer. Sessions start fine, but replay
  fidelity is not guaranteed — always verify against a real recorded session rather than assuming.
- **This script is deliberately unlike the others in this repo.** No sidebar, no shell, no Canary7
  API calls, no scanner handling. Don't copy the house UI pattern into it; there's nothing to
  render.

---

## Shipping a change

1. Bump `@version` (line 4). **Tampermonkey will not update the fleet without this.**
2. Update the version string in the line 154 log so the console doesn't lie.
3. Commit and push to `main`.
4. `@updateURL` points at the raw GitHub URL, so every TC51 and packing station picks it up on its
   next update check. Verify the raw URL serves the new version before you walk away.

If you break this script, nothing on the floor stops working — you just quietly stop getting
session recordings. That makes it easy to break without noticing, so do step 3 of **How to test**
every time.

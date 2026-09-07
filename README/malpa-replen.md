# malpa-replen.user.js

A Tampermonkey userscript that patches Canary7's **Replenishment Job Execution** screen on the
Zebra TC51 handhelds. Version 4.8.1.

If you are about to edit this file and have never seen it before, read this page first. It is
shorter than the script.

---

## TL;DR

Canary7's replen screen has three problems. This script fixes all three:

| Problem | What the script does |
|---|---|
| The operator can't see how much to move until after they scan the item | Shows `Qty to move` and `To Location` up front |
| The Confirm Units field is locked, so a wrong quantity can't be corrected | Strips `readonly` so it's editable |
| Nothing stops the operator moving more stock than exists → negative inventory | Blocks the move if `entered × factor > on-hand` |

That third one is the important one. It is why this script is safety-critical and why most of
the rules below exist.

---

## The 30-second mental model

The script is a **passive observer that occasionally interrupts**. It never drives Canary7's UI
and it never reaches into Angular. It does four things:

1. **Listens** to Canary7's own network traffic to learn what job is on screen.
2. **Draws** two extra lines onto the screen using Canary7's own markup.
3. **Polls** Canary7 for a live on-hand figure for the stock being moved.
4. **Intercepts** the request that actually commits the move, and cancels it if the quantity is
   too high.

That's it. There is no framework, no build step, no dependencies. One file, one IIFE.

---

## Why it exists — the three incidents

You need this history, because most of the odd-looking code is scar tissue.

**Incident 1 — negative inventory.** Making the quantity field editable removed Canary7's own
cap. Canary7 does **not** validate this server-side, so an operator moved more than existed and
created a negative inventory record that had to be fixed by hand. Lesson: *if you unlock the
field, you own the validation.*

**Incident 2 — fractional UOM.** An operator moved 950 "inners" where an inner is 28 to a box.
950 isn't divisible by 28, so Canary7 created fractional inventory that couldn't be booked out
through the GUI at all. A divisibility check was added and later **removed at the user's
request** — it is deliberately not in the current script. Don't re-add it without asking.

**Incident 3 — false blocks.** The job cache mixed rows from different profiles, so the script
matched the wrong job, showed the wrong quantity, and blocked legitimate moves. Operators
couldn't do their work. Lesson, and now the governing principle: **a wrong block is worse than
no block.** The script fails *open* everywhere.

---

## How it works, part by part

### 1. Learning which job is on screen

Canary7 fetches a pool of replen jobs (`get-replenishment-jobs`) and assigns one
(`assign-replenishment-job`). The script taps both by monkey-patching `XMLHttpRequest` and
`fetch`, and caches the job rows.

Matching the cached row to what's actually rendered is done by `currentJob()`, in three passes,
each stricter than it looks:

1. The assigned `job_id` — **but only if it agrees with the Item / From / To shown on screen**.
2. A unique From-Location match (From Location is unique per replen job).
3. A unique Item + To-Location match.

If none of these produces exactly one confident row, `currentJob()` returns `null` and the
script does nothing at all. That is Incident 3's fix and it must stay that way.

The cache is **scoped to `profile_id`**. When the profile changes, the whole cache is dropped.
Stale cross-profile rows are what caused the false blocks.

### 2. Drawing the extra lines

`sync()` inserts a wrapper `div` with `display: contents` holding two `.form-group` blocks that
reuse Canary7's own classes and `<strong>` markup. That's why the lines inherit the site's
colour, weight and spacing with no custom CSS.

It anchors under `Description :` using `findContainer()` — the *smallest element containing* the
label — because Item and Description sometimes share one block, so a "starts-with" match misses.

`sync()` runs on a `MutationObserver` **and** a 600 ms `setInterval`. Both. The observer alone
was unreliable; the interval is the safety net. Don't remove either.

### 3. The live on-hand figure

`refreshOnHand()` calls Canary7's inventory endpoint every 2.5 s while the screen is open, plus
immediately whenever the operator types in the quantity field.

Three confirmed traps are baked into that call, all of them load-bearing:

- `id=` is **not** a filter on this endpoint. Passing it is silently ignored and you get page 1
  of everything. The script filters on `id` client-side instead.
- `location_code` is a **prefix** match, so `A14-B15` also returns `A14-B15-S201` etc.
- Default page size is 20, so `per-page` is sent explicitly.

The authorization token is **captured from Canary7's own requests** by patching
`setRequestHeader`. The script never logs in and never stores credentials.

### 4. The guard

There are two checks. They are not equally important.

**The early check** (`onNextCapture`) fires on the Next button. It's a courtesy — it gives the
operator feedback at the confirm-units step. It is allowed to fail.

**The real guard** lives in the `XMLHttpRequest.send` / `fetch` wrappers and fires on the commit
call, `execute-replenishment-job`. This one must hold. It exists because the Next-button check
alone missed a real hole: enter a valid quantity, scan the location, click back into the field,
raise it — Canary7 commits through a *different control*, and the button handler never sees it.
Tapping the request itself catches every path.

Because `send()` is synchronous, the guard can't fetch anything at that moment. It compares
against the **polled** figure — hence the 2.5 s poller. Staleness is bounded and the case that
matters (a mistyped quantity) is caught regardless of how fresh the number is.

When it blocks, the request is simply never sent, and `failXhr()` dispatches a synthetic `error`
event so Angular's HttpClient fails cleanly instead of hanging forever on a request that never
completes. The operator sees the script's red banner explaining the real reason, and probably a
generic Canary7 error alongside it.

---

## Units — read this before touching any arithmetic

This is the single easiest way to break the script badly and silently.

- `on_hand_quantity` from the API is in **base units** (Each).
- The Confirm Units field is in the **from-UOM** (whatever the operator is moving — cartons,
  inners, outers).

So the comparison is:

```
entered × factor   vs   on_hand_quantity
```

where `factor` comes from `replenishmentDetail[0].inventory.itemUnitOfMeasure.factor`.

Version 4.7 compared the raw entered figure against the API figure with no conversion, which
meant it **under-blocked on every UOM with a factor above 1** — 7 cartons of 6 against 36 on
hand sailed straight through. If you change `overMoveReason()`, keep the conversion and keep the
error message converting back the other way, so the operator is told a cap in the units they're
actually typing.

---

## Map of the file

The script is numbered in sections. Jump to the number:

| Section | Contains | Touch it when |
|---|---|---|
| Header comment | Endpoints confirmed against live Canary7, with the evidence | Never, without re-probing |
| 1. Pure decision logic | `overMoveReason()`, `isCommitUrl()` | Changing what counts as an over-move |
| 2. Network taps | XHR/fetch patches, job cache, auth capture, **the guard** | Changing what's intercepted |
| 3. On-hand poller | `refreshOnHand()`, `apiGet()`, `startPolling()` | Changing the stock lookup |
| 4. DOM helpers | Label finders, the qty field, the error banner | The Canary7 DOM changed |
| 5. Early guard | `onNextCapture()` on the Next button | Changing the pre-commit warning |
| 6. Job matching | `currentJob()` and friends | **Be very careful — this is Incident 3** |
| 7. Render | `sync()`, the two extra lines | Changing what's displayed |

`overMoveReason()` is deliberately **pure** — no DOM, no network, no globals. That's what makes
it testable offline. Keep it that way.

---

## Rules you must not break

1. **Fail open.** Unknown job, unknown factor, no live figure, failed fetch → *allow the move*.
   Every `return null` in `overMoveReason()` is intentional. Blocking on uncertainty stops the
   warehouse working, which is worse than the risk it prevents.
2. **Never re-dispatch input events.** An early version added a `change` listener that
   re-dispatched `change`, causing infinite recursion that froze the handheld so hard the
   operator couldn't even exit the screen. Native events already reach Angular's reactive form.
   Listen, don't emit.
3. **Never invent an endpoint or a selector.** Everything in the header comment was confirmed by
   probing live Canary7 and the evidence is recorded there. Add to it the same way.
4. **Don't reparent or restyle Canary7's own DOM.** Add to it. Inline styles beat Angular's
   classes and leave panes permanently dead until reload — that bug has shipped twice in this
   repo.
5. **Bump `@version` on every change.** Tampermonkey will not pull an update otherwise, and the
   handhelds will sit silently on an old version. Keep the internal `VERSION` constant in step.
6. **Angular is a production build.** `window.ng` is gone and all `__ngContext__` values are
   numeric, so the component instance is unreachable. Don't plan anything that needs it — this
   is why the "Back button" idea was abandoned.

---

## Editing, testing, shipping

**Test offline before it goes near the floor.** There's a harness (`malpa-replen.test.js`) that
stubs the DOM, loads the real script, and exercises the decision logic through the
`window.__malpaReplen` debug handle:

```bash
node malpa-replen.test.js
```

Every bug that reached the warehouse floor was one an assertion would have caught. If you change
`overMoveReason()`, add a case.

**Debugging on a handheld.** There is no devtools on a TC51 in practice, so the script is
deliberately loud. Every log line is prefixed `[Malpa Replen]`. `window.__malpaReplen` exposes
live state (`R`), the job cache, and the matching functions.

The commit URL is logged in full on every execute. That's intentional: it's how the four
still-unknown optional parameters on `execute-replenishment-job` will eventually be identified.

**Shipping.** Bump the version, run the harness, push to `main`. The handhelds auto-update from
the raw GitHub URL, which means the repo must stay **public** and the filename must match
`@updateURL` exactly. A mismatch there once broke auto-update silently for weeks.

---

## Known gaps

- **Both guards live in the browser.** They only protect while the script is running. The
  durable fix is server-side enforcement in Canary7 — it accepted both an over-available
  quantity and a fractional conversion, which are arguably vendor bugs. Worth raising.
- **The four optional commit parameters are unknown.** The guard reads the quantity from the
  field rather than the request. Reading it from the request would be more truthful.
- **The guard is on-hand based, not availability based.** It permits moving stock that's already
  allocated to a pick. That was a deliberate choice; Canary7 may reject such a move itself.
- **The blocked-request path is unverified on a real device.** The synthetic error event should
  make Angular fail cleanly, but that hasn't been confirmed on a live handheld.
- **Metadata is inconsistent in 4.8.1**: `@version` says `4.8.1` but the internal `VERSION`
  constant says `4.8`, and `@homepageURL` / `@supportURL` still point at the old
  `zaynnev/malpa3pl` repo while the update URLs point at `Malpa-3PL/Warehouse-Scripts`. Worth
  fixing on the next bump.

---

## Glossary

- **Replen** — moving stock from bulk/backstock into a pick face so orders can be picked.
- **UOM / factor** — unit of measure and how many base units it holds. Carton with factor 6 = 6
  Each. Canary7 treats each UOM as effectively a different product.
- **On-hand vs available** — on-hand is the raw physical count; available is on-hand minus
  allocated minus suspended.
- **From / To Location** — where the stock is moving from and to. From Location is unique per
  replen job, which is why job matching leans on it.
- **The commit call** — `execute-replenishment-job`. A **GET** that mutates, which is unusual but
  normal for this Canary7 build.

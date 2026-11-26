# malpa-pagesize

**Adds 100 and 200 to every Canary7 table's Page Size dropdown.**

---

## TL;DR

C7 tables top out at 50 rows a page. This script adds **100** and **200** to every page-size
dropdown and opens tables at **200** the first time it runs. After that, C7 remembers whatever
you pick. It writes nothing to C7.

| Device | Desktop C7 (`malpa.canary7.com`), any browser with Tampermonkey |
|---|---|
| Writes to C7 | None |
| Stores | localStorage `pageSize`, `perPage` (C7's own keys), `malpa.pagesize.seeded.v1` |

---

## How C7 does page size (from the C7 bundle, 26 Nov 2026)

| Table type | Dropdown | Saved in | What C7 does on change |
|---|---|---|---|
| ag-grid (Shipping Enquiry, Inventory, Jobs, …) | label "Page Size", 10–50 | `pageSize`, **one value shared by every ag-grid table** | `setPerPage(select.value)`: `Number()`, then reload with `per-page=<n>` |
| Older tables | select in the Prev/Next/Last pager, 10/25/50 | `perPage` | `setPerPageValue()`: reload with `per-page=<n>` |
| Teams list | label "Page Size", 10–50 | not saved | client-side paging |

C7 passes the selected number straight into `per-page=`, so extra `<option>`s are all that is needed.
The shipment list returns a full 200 rows a page (checked 26 Nov 2026: 16,928 open shipments, 85 pages).

## The cap guard

Some C7 endpoints silently serve fewer rows than asked (inventory `get-summary` 50, items ~400;
see the canary7-config skill, `measured-api-facts.md`). On an ag-grid table that breaks paging:
the grid asks for page 2 at 200 a page, C7 sends page 2 at 50 a page, and rows go missing.

The script watches list calls with `per-page=100` or `200`. If C7 sends fewer rows than the total
count says it should, a red banner tells you to drop that table's Page Size to 50.

## Map of the file

| Section | What | Touch it? |
|---|---|---|
| Config | `EXTRA_SIZES`, `DEFAULT_SIZE` (set `null` to skip the first-run 200) | Yes |
| A | First-run seed of `pageSize` / `perPage` | Rarely |
| B | Finds page-size selects, adds options, shows the saved value | If C7 changes its markup |
| C | XHR / fetch watcher and the banner | Rarely |

## Known limits

- Because ag-grid's `pageSize` is shared, 200 applies to every ag-grid table at once.
- 200-row pages are 4× heavier calls; big expand lists (Shipping Enquiry) load slower.
- Replaces the old `addPageSizeOption()` in `tampermonkey-scripts/QOL/main_enhancements.js`, which
  only touched the first "Page Size" on the page and never fixed the display. Safe to run both; no duplicate options.

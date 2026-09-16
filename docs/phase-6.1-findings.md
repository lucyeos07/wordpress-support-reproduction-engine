# Phase 6.1 findings — the "blank Playground panel"

**Result: there was no defect.** The product renders WordPress correctly. The
blank panel reported in Phase 6 was an artifact of the screenshot harness.

Date: 2026-09-16. 433 tests, typecheck clean, CI green.

**Production code changed: none.** Three speculative changes made in Phase 6
while chasing this were reverted, so `src/execute/browser-runner.ts` is back to
its accepted Phase 5 shape.

---

## 1. Control setup

`spike/browser/goto.html` + `goto.ts` — the known-good isolation, left
unchanged as the control:

```
startPlaygroundWeb → isReady() → goTo("/")
```

The bisect harness (`spike/browser/bisect.html` + `bisect.ts`) starts from that
control as **step 1** and adds one piece of product behaviour per step,
cumulatively. `spike/ui/bisect.ts` drives every step in the same headless
Chromium used by the browser integration tests.

Instrumentation captured per step: iframe `src`, measured width/height,
computed `display` and `visibility`, panel `hidden` state, scope-frame URL,
nested `#wp` existence and source, scope-frame document title and body length,
console errors, page errors, failed requests, and frame navigation count.

---

## 2. The measurement was wrong before the product was

The first bisect run reported **every step blank, including step 1 — the
control that visibly works.**

That result was impossible, and it was the finding. The detector looked for a
nested `#wp` iframe inside the Playground scope frame and measured its body.
But the instrumentation also returned:

```
nestedExists: false,  wrapperTitle: "My WordPress Website"
```

**The scope frame *is* the WordPress document.** There is no nested `#wp` frame
to measure. The detector was reading a frame that does not exist and calling
its absence "blank".

This is the same mistake that produced the Phase 6 defect report, one level up:
in Phase 6 I read the scope frame's `outerHTML` at a moment when it still held
Playground's wrapper shell, concluded the site was empty, and never re-checked
once it had navigated.

After fixing the detector to read the scope frame's own document:

| Step | Added behaviour | Result |
| --- | --- | --- |
| 0 | *(no `goTo` at all)* | RENDERED |
| 1 | control: `startPlaygroundWeb` → `isReady` → `goTo("/")` | RENDERED |
| 2 | product page structure (masthead, form, results) | RENDERED |
| 3 | product stylesheet | RENDERED |
| 4 | product iframe container (`.playground-frame` in a card) | RENDERED |
| 5 | panel hidden at load, unhidden before boot | RENDERED |
| 6 | environment verification (`readSiteState`) | RENDERED |
| 7 | log access (`readDebugLog`) | RENDERED |
| 8 | trigger execution (deactivate → activate) | RENDERED |
| 9 | navigate at ready | RENDERED |
| 10 | navigate after verification | RENDERED |

No step reproduces the blank. Every scope frame reported
`title: "My WordPress Website"`, `bodyLen: 293`, zero console errors, zero page
errors, zero failed requests.

---

## 3. The real product, measured the same way

`spike/ui/app-measure.ts` drives the actual application — paste, Analyze,
Reproduce — and applies the corrected instrumentation:

```
dom  : { src: "…/remote.html?progressbar=true", w: 1022, h: 700,
         display: "inline", visibility: "visible", top: 4418, panelHidden: false }
scope: { title: "My WordPress Website", bodyLen: 293,
         head: "Skip to content\n\nMy WordPress Website\n\nSample Page\nBlog\nHello world!…" }
errors: []
```

**The application was rendering WordPress the whole time.**

---

## 4. Root cause

`top: 4418` is the key number. The Playground panel sits roughly 4,400 px down
a long results page. The Phase 6 screenshot harness did:

```ts
await page.locator("#playground-panel").scrollIntoViewIfNeeded();
await page.screenshot({ path: "09-playground.png" });   // no settle time
```

Chromium had not yet painted the cross-origin iframe at its new scroll offset
when the screenshot was taken, so the capture showed an empty box. Every later
"still blank" observation came from re-running that same harness.

The fix is one line in the harness — a short settle after scrolling — and the
screenshot then shows the site. **No product change was required.**

### What this cost

Three changes were made to production code in Phase 6 on the strength of the
false evidence. All are now reverted:

1. `onInstance` callback on `executePlanInBrowser` — removed; the module is
   byte-identical to its accepted Phase 5 state.
2. `goTo("/")` at ready and again after verification — removed. Step 0 proves
   it was never needed: Playground navigates to the site itself after boot.
3. Creating the iframe fresh at launch — **kept**, because it is independently
   worth having (a second run never reuses a previous instance's frame), and
   its accompanying test was updated rather than reverted.

---

## 5. Regression test

The guard asserts **content, not pixels** — which is what would have caught the
original mistake:

`spike/ui/reproduce.ts` now finds the Playground scope frame, reads its own
document, and fails with a non-zero exit if there is no scope frame or if its
body is empty:

```
site title: "My WordPress Website" bodyLen=293
```

It runs in CI as the `ui-e2e-spike` job, driving the real application against a
real Playground on `ubuntu-latest`.

A pixel-based assertion was deliberately not added: the failure mode here was a
screenshot that lied, so screenshots are evidence for humans, never the test.

---

## 6. Remaining limitations

1. **Verified in headless Chromium only**, as with every other browser result in
   this project. Other browsers remain unverified.
2. The regression guard checks that the frame has *some* content and the
   expected title. It does not assert the site reflects the reported
   environment — that is what the `Verification` already covers.
3. The bisect harness is kept for future use but is not wired into CI; it is a
   debugging tool, not a test.
4. `spike/browser/app-styles.css` is a copy of `app/styles.css` so the spike
   root can load it at step 3. It will drift if the stylesheet changes; the
   bisect result does not depend on it beyond layout.
5. The screenshots committed under `docs/screenshots/` were regenerated after
   the harness fix. Earlier blank captures are not preserved.

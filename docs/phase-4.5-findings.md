# Phase 4.5 findings — version-pinned plugin installation

A narrow spike answering one question: does the `slug@version` reference the
planner emits actually install that exact version?

Date: 2026-09-15. Playground 3.1.53. Result: **verified on both surfaces.**

The planner was not modified. The only change outside this document is the
`versionPinnedVerified` flag in `src/repro/capabilities.json`, flipped from
`false` to `true` with the evidence recorded — a factual record of what was
verified, read by no logic.

---

## 1. What was tested

**Plugin: `classic-editor`.** Chosen deliberately:

- it is **not bundled with WordPress core**, unlike `akismet` and
  `hello-dolly`, so a pre-existing copy cannot confound the result;
- it is small (19 KB), so each boot is fast;
- the version pinned (**1.6.3**) is clearly not the latest (**1.7.0** per the
  plugin's own trunk `readme.txt` at spike time), so "latest was installed
  instead" is unambiguously detectable.

Three Blueprints, all schema-valid against the published schema, and all in the
exact shape the planner emits:

**Pinned** (`spike/blueprints/pinned.v2.json`):

```json
{
  "$schema": "https://playground.wordpress.net/blueprint-schema.json",
  "version": 2,
  "wordpressVersion": "6.8.2",
  "phpVersion": "8.2",
  "plugins": [{ "source": "classic-editor@1.6.3", "active": true }],
  "constants": { "WP_DEBUG": true, "WP_DEBUG_LOG": true }
}
```

**Control** (`unpinned.v2.json`) — identical but `"source": "classic-editor"`.
Without this, an "exact match" result could just mean the pinned version
happened to be latest.

**Nonexistent** (`missing-version.v2.json`) — `"source": "classic-editor@99.9.9"`,
to establish the failure mode.

### Method

The installed version was read **from WordPress itself**, not from the
Blueprint and not from the exit status — Phase 0 established that
`run-blueprint` exits 0 silently and proves nothing:

```php
$all = get_plugins();
$all['classic-editor/classic-editor.php']['Version'];
```

`get_plugins()` reads each plugin's own file header, so this is what is on
disk.

---

## 2. Results

| Blueprint | Surface | Requested | **Installed** | Active | Boot |
| --- | --- | --- | --- | --- | --- |
| pinned | CLI | 1.6.3 | **1.6.3** | yes | 10.2 s |
| pinned | browser | 1.6.3 | **1.6.3** | yes | 19.1 s |
| control | CLI | (latest) | **1.7.0** | yes | 8.8 s |
| control | browser | (latest) | **1.7.0** | yes | 14.2 s |
| nonexistent | CLI | 99.9.9 | — boot failed | — | — |
| nonexistent | browser | 99.9.9 | — boot failed | — | — |

Answering the five questions directly:

1. **Was the requested version actually installed?** Yes — 1.6.3, on both
   surfaces.
2. **Was a different/latest version installed?** No. The control installed
   1.7.0 from the same environment, which proves the pin is what produced
   1.6.3.
3. **Did installation fail?** Not for a real version. A nonexistent version
   fails the boot loudly.
4. **Is behaviour identical between CLI and browser?** Yes for installation.
   The failure is also equivalent, but the error surfaces differ — see §4.
5. **Does `slug@version` mean exact pinning in the current implementation?**
   **Yes**, and the mechanism is now known — see §3.

---

## 3. The mechanism, confirmed

The failure message named the URL Playground resolves the reference to:

```
Could not download "https://downloads.wordpress.org/plugin/classic-editor.99.9.9.zip"
```

So `slug@version` → `https://downloads.wordpress.org/plugin/<slug>.<version>.zip`.
Confirmed independently:

| URL | Status |
| --- | --- |
| `classic-editor.1.6.3.zip` | 200, 19,228 B |
| `classic-editor.zip` (no version = latest) | 200, 38,882 B |
| `woocommerce.8.5.2.zip` | 200, 20,405,031 B |
| `classic-editor.99.9.9.zip` | **404** |

This matters beyond this spike: pinning works exactly as long as
WordPress.org still serves a zip for that version. It is not a resolver with
fallback logic — it is a direct URL fetch.

---

## 4. Differences between the surfaces

Installation behaviour is identical. The **failure reporting** differs:

| | CLI | Browser |
| --- | --- | --- |
| Error class | `ResourceDownloadError` | `BlueprintStepExecutionError`, underlying `TypeError: Failed to fetch` |
| Exit / surface | exit code **1**, message on stderr | thrown from `startPlaygroundWeb()` |
| Names the failing URL | yes | yes |
| Names the failing step | `blueprint step #2` | `blueprint step #2` |

One thing worth noting against Phase 0: `run-blueprint` **does** report this
failure with a non-zero exit and a clear stderr message. Phase 0 found success
is silent; failure of this kind is not. Exit status still cannot confirm a
*successful* install, which is why this spike asked WordPress directly.

---

## 5. Is exact pinning verified?

**Yes, on both surfaces**, by reading the installed plugin header rather than
by trusting the Blueprint, the exit status, or the documentation. The unpinned
control rules out coincidence.

`capabilities.json` now records `versionPinnedVerified: true` with this
evidence.

---

## 6. Recommendation for Phase 5

**Keep `slug@version`.** It does what the planner assumed, so no redesign of the
generator is needed and none was made.

But the spike surfaced a consequence that Phase 5 must handle, and it is not
small:

### A single unavailable version aborts the entire reconstruction

The nonexistent-version Blueprint did not install the other components and
carry on — **the whole boot failed**. Installation is all-or-nothing.

That matters because reported versions frequently will not be on
WordPress.org:

- a plugin later **removed from the repository** serves no zips at all;
- some authors **purge old tags**, so an older reported version 404s even
  though the plugin is still listed;
- a site running a **patched or locally modified** copy reports a version that
  never existed publicly.

So a plan the planner rates *tier B, reproducible* can fail completely at
execution because of one unrelated plugin — including a plugin whose relevance
to the failure is `unknown`. The tier would be honest about reproduction and
still wrong about whether the environment boots at all.

Three options for Phase 5, in preference order. **None is implemented; this is
a recommendation for review, not a decision taken.**

1. **Pre-flight the download URLs at execution time.** A `HEAD` per pinned
   reference before booting turns an opaque boot failure into a precise
   "version X of plugin Y is no longer served" and lets execution proceed with
   that component demoted to a recorded failure. Network at *execution* time is
   already unavoidable — Playground downloads core and plugins — so this does
   not weaken the §3 privacy model, which constrains *planning*. It must not
   move into the planner.
2. **Catch the boot failure and attribute it.** Parse the failing URL out of
   the error, map it back to the component, and record it in
   `Verification.environment.failedComponents`. Cheaper, but only tells you
   after a wasted boot, and only about the first failure.
3. **Retry unpinned as an explicit, recorded substitution.** Falls back to
   latest when a pinned version is gone. This is a real substitution of the
   reported environment and would have to appear in `substitutions` — never
   silently. Weakest option: it changes the thing being reproduced, and the
   reported version is often exactly what matters.

Whichever is chosen, the honest reporting requirement is the same: a component
that could not be installed must reach `failedComponents` with its reason, and
must never be reported as installed.

### Smaller notes

- The spike used a 19 KB plugin. A real plan pins WooCommerce, whose zip is
  **20 MB** (verified). Phase 5 boot times and any CI budget should assume the
  large download, not this spike's timings.
- `classic-editor@1.6.3` and the two variants are now schema-validated by the
  existing blueprint test, which picked them up automatically (6 → 9 tests).

---

## 7. Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run` — **375 passed** (up from 372; the three new spike
  Blueprints are now schema-validated).
- Reproduce: `npx tsx spike/version-pinning/cli.ts`, and for the browser
  `npx vite --config vite.config.ts` then
  `npx tsx spike/version-pinning/drive.ts`.

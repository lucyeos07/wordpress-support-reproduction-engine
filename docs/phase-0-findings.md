# Phase 0 findings

Date of experiments: 2026-09-12. All statements below were produced by running
code, not by reading documentation. Where something was not tested, this
document says so rather than inferring it.

Host used for every measurement: macOS (darwin 25.6.0), Node 26.8.2, npm 11.19.1.

## Versions under test

| Package | Version |
| --- | --- |
| `@wp-playground/cli` | 3.1.53 |
| `@wp-playground/client` | 3.1.53 |
| `@wp-playground/blueprints` | 3.1.53 |
| `@php-wasm/node` | 3.1.53 |

Blueprint schema fetched 2026-09-12 from
`https://playground.wordpress.net/blueprint-schema.json` (171,880 bytes),
vendored at `spike/blueprints/blueprint-schema.json`.

---

## 1. Blueprint schema

### What is current

The published schema is a `oneOf` over **two** declarations:

- `BlueprintV1Declaration` — `preferredVersions`, `steps`, `plugins`,
  `constants`, `siteOptions`, `login`, `landingPage`, `features`,
  `extraLibraries`, `phpExtensionBundles`, `meta`, `description`.
- `BlueprintV2Declaration` → `V2Schema.BlueprintV2` — requires `version: 2`,
  `additionalProperties: false`. Top-level keys include `wordpressVersion`,
  `phpVersion`, `plugins`, `themes`, `activeTheme`, `muPlugins`, `siteOptions`,
  `constants`, `content`, `users`, `roles`, `media`, `fonts`, `postTypes`,
  `siteLanguage`, `contentBaseline`, `usersBaseline`, `applicationOptions`,
  `blueprintMeta`, `additionalStepsAfterExecution`.

Relevant value types, quoted from the schema:

- `DataSources.PHPVersion` — `^(?:latest|next|\d+\.\d+(?:\.\d+)?)$`
- `DataSources.WordPressVersion` — `^(?:latest|beta|trunk|nightly|none|\d+\.\d+(?:\.\d+)?(?:-(?:beta\d+|[Rr][Cc]\d+))?)$`
- `DataSources.PluginDirectoryReference` — a WordPress.org slug, optionally
  version-pinned: `"jetpack"`, `"jetpack@6.4"`, `"akismet@6.4.3"`. Meaningful
  only in the top-level `plugins` array and the `installPlugin` step.

The version-pinned slug form (`slug@version`) is an officially supported
versioned package mechanism and resolves the open `[UNVERIFIED]` question in
SPEC §11.

### What did not work: the published schema is not valid JSON Schema

Validating any Blueprint with Ajv 8 fails at schema-compile time:

```
Error: schema is invalid: data/definitions/BlueprintV1Declaration/properties/description/deprecated
must be boolean, data/definitions/BlueprintV1Declaration/properties/phpExtensionBundles/deprecated
must be boolean, data/definitions/StepDefinition/oneOf/3/properties/virtualize/deprecated must be
boolean, data/definitions/StepDefinition/oneOf/9/properties/pluginZipFile/deprecated must be
boolean, data/definitions/StepDefinition/oneOf/10/properties/themeZipFile/deprecated must be
boolean, data/definitions/StepDefinition/oneOf/11/properties/password/deprecated must be boolean,
data/definitions/StepDefinition/oneOf/23/properties/zipPath/deprecated must be boolean
```

Cause, confirmed by reading the schema: `deprecated` carries explanatory
**strings** where JSON Schema requires a boolean — for example
`"Use meta.description instead."`, `"No longer used. Feel free to remove it from
your Blueprint."`, `". Use 'pluginData' instead."`.

This is a defect in the published schema, not in our usage.

Workaround applied and documented in code
(`spike/cli/validate-blueprint.ts`): Ajv is constructed with
`validateSchema: false`, which disables **meta**-validation only. Instance
validation is unaffected and still rejects bad Blueprints — verified by negative
controls (`{version:2, phpVersion:"8.2", nonsense:true}` and
`{version:2, phpVersion:"not-a-version"}` both fail).

A secondary annoyance: because the top level is a `oneOf` of V1 and V2, a single
bad V2 property produces repeated `must NOT have additional properties` errors
from the V1 branch. Error output needs post-processing before it is shown to a
user.

---

## 2. CLI surface

### Exact calls used

```
npx wp-playground-cli run-blueprint --blueprint=<file> [--verbosity=debug] [--mode=...]
```

```ts
import { runCLI } from "@wp-playground/cli";
const server = await runCLI({ command: "server", blueprint, port, verbosity: "quiet", skipBrowser: true });
const php = server.playground;
await php.run({ code });          // PHPResponse | throws
await php.mkdir(path);
await php.writeFile(path, contents);
await server[Symbol.asyncDispose]();
```

Available commands: `start`, `server`, `run-blueprint`, `build-snapshot`, `php`.

### What worked

- Booting a pinned environment. `preferredVersions: { php: "8.2", wp: "6.8.2" }`
  produced a live site reporting `wp_version 6.8.2`, `php_version 8.2.33`.
- Installing and activating a WordPress.org plugin through the **v1**
  `installPlugin` step.
- Confirming what actually installed and activated — but only by executing PHP
  inside the booted site:

  ```php
  get_plugins();                    // ["akismet/akismet.php","hello-dolly/hello.php","hello.php"]
  get_option('active_plugins');     // ["hello-dolly/hello.php"]
  ```

- Writing a plugin into the VFS and activating it, producing a real fatal.
- `constants: { WP_DEBUG: true, WP_DEBUG_DISPLAY: true, WP_DEBUG_LOG: true }`
  causing `/wordpress/wp-content/debug.log` to be written.

### What did not work

**1. Blueprint v2 with a `plugins` array fails in the CLI.**

```
$ npx wp-playground-cli run-blueprint --blueprint=spike/blueprints/minimal.v2.json
exit=1
stdout: 0 bytes
stderr: Error: Error connecting to the SQLite database.
```

The Blueprint is schema-valid. `--verbosity=debug` adds nothing diagnostic; the
last line before failure is `Resolved WordPress release URL:
https://wordpress.org/wordpress-6.8.2.zip`, then `Error: caused by: Error
connecting to the SQLite database.`

Narrowed experimentally:

| Blueprint | Result |
| --- | --- |
| v2, `wordpressVersion` + `phpVersion` + `plugins` | **exit 1**, SQLite error |
| v2, `wordpressVersion` + `phpVersion`, no `plugins` | exit 0 |
| v2, `phpVersion` only | exit 0 |
| v2 + `--mode=create-new-site`, with `plugins` | **exit 1**, SQLite error |
| v2, `wordpressVersion: "latest"`, with `plugins` | **exit 1**, SQLite error |
| v1 with `installPlugin` step | exit 0 |

So the failure is specific to the v2 top-level `plugins` array, is independent
of WordPress version, and is not fixed by `--mode`. The same v2 Blueprint
**succeeds in the browser** (§3). No workaround was applied; the CLI spike uses
the v1 Blueprint and this limitation is reported as-is.

**2. `run-blueprint` reports nothing at all.**

On success it exits 0 with **zero bytes on stdout and zero on stderr**, at the
default `--verbosity=normal`. Its programmatic signature is
`runCLI(args & {command:'run-blueprint'}): Promise<void>` — it returns no value.
There is no machine-readable report of what installed or activated.

Consequence: `run-blueprint` is unusable for automated verification. Everything
in SPEC §9.1 that must be distinguished has to come from
`runCLI({command:'server'})`, which returns `RunCLIServer { playground, server,
serverUrl }`, followed by executing PHP against `playground`.

---

## 3. Browser surface

### Exact calls used

```ts
import { startPlaygroundWeb } from "@wp-playground/client";

const client = await startPlaygroundWeb({
  iframe,
  remoteUrl: "https://playground.wordpress.net/remote.html",
  blueprint,
  onBlueprintValidated: (bp) => {...},
  onBlueprintStepCompleted: (output, step) => {...},
});

await client.isReady();
await client.run({ code });
await client.request({ url });
await client.writeFile(path, contents);
await client.mkdir(path);
```

### What worked

- **Readiness is detectable.** `startPlaygroundWeb()` resolves, and
  `client.isReady()` resolves. Boot took 18.0–27.5 s.
- **`onBlueprintValidated`** fires with the validated Blueprint object.
- **`onBlueprintStepCompleted`** fires once per v1 step. Observed
  `step.step === "installPlugin"` and `"defineWpConfigConsts"`.
- **Runtime state is inspectable.** `client.run()` executing
  `get_plugins()` / `get_option('active_plugins')` confirmed
  `hello-dolly/hello.php` installed and active, `wp 6.8.2`, `php 8.2.33`.
- **Blueprint v2 works here.** `{version:2, wordpressVersion:"6.8.2",
  phpVersion:"8.2", plugins:["hello-dolly"]}` booted in 22 s and produced
  `active_plugins: ["hello-dolly/hello.php"]` — the exact Blueprint the CLI
  rejects.
- **`debug.log` is readable** from the host page via `client.run()`.

### What did not work

**1. `onBlueprintStepCompleted` reports which step ran, never its outcome.**

The `output` argument was `undefined` for every step observed, in every run. Its
type is `OnStepCompleted = (output: any, step: StepDefinition) => any`. The
callback can tell you a step executed; it cannot tell you whether the step
succeeded, and it cannot populate `failedComponents`.

With a v2 Blueprint **no step events fire at all** (`[]`), because v2 has no
`steps`. Any design that depends on step events is v1-only.

**2. The client cannot be introspected.** `Object.keys(client)` returns `[]` —
it is a Comlink proxy. The API surface must be taken from the type
declarations, not discovered at runtime.

**3. `ini_set('error_log', ...)` had no effect.** Setting `log_errors` and
`error_log` to `/tmp/phase0-php-errors.log` then triggering a fatal produced
`((no error log file))`. PHP error routing must be configured through Blueprint
`constants`, not at runtime.

**4. A failure caused by the test environment, not by Playground.** The first
browser attempt hung: `startPlaygroundWeb()` never resolved and
`onBlueprintValidated` never fired, still stuck at 138 s with no console error.

Cause: the page was **cross-origin isolated**, and
`https://playground.wordpress.net/remote.html` sends no
`Cross-Origin-Resource-Policy` or `Cross-Origin-Embedder-Policy` header
(verified with `curl -I`), so a COEP-isolated embedder blocks that iframe.

Two contributing factors, in order:

- My own `vite.config.ts` initially set `Cross-Origin-Opener-Policy:
  same-origin` and `Cross-Origin-Embedder-Policy: credentialless`. That was
  wrong and has been removed; Playground's wasm runs inside the remote origin,
  which sets its own headers.
- After removing them, `curl -I http://localhost:9500/` confirmed Vite sends no
  COOP/COEP — yet the page still reported `crossOriginIsolated === true`. The
  embedded Claude Browser pane forces cross-origin isolation, so the official
  Playground embedding cannot be exercised there.

Resolved by driving the same page with Playwright Chromium, where
`crossOriginIsolated === false` and everything above worked. The Claude in Chrome
extension was tried first and was not connected.

**Implication for the product:** the page embedding Playground must not be
cross-origin isolated. This is a real deployment constraint, not a test artifact.

---

## 4. Divergences between the two surfaces

These were measured, not assumed. SPEC §12's rule that neither surface implies
the other is empirically justified.

| Behaviour | CLI 3.1.53 | Browser 3.1.53 |
| --- | --- | --- |
| Blueprint v2 with `plugins` | **fails** (SQLite error) | **works** |
| Blueprint v1 `installPlugin` | works | works |
| Step-completion events | not exposed by `run-blueprint` | `onBlueprintStepCompleted`, v1 only, outcome `undefined` |
| HTTP status on a PHP fatal | `200` | `500` without `WP_DEBUG`; `200` with `WP_DEBUG_DISPLAY` |
| `originalErrorClassName` on thrown error | `"PHPExecutionFailureError"` | `"Error"` |
| Own keys on thrown error | `response, source, originalErrorClassName, cause` | `response, source, originalErrorClassName` |
| `debug.log` without `WP_DEBUG_LOG` | absent | **present** (remote enables it) |

The last row matters: the browser remote appears to enable debug logging by
default while the CLI does not. Do not rely on either default — set `constants`
explicitly.

---

## 5. Log surface

This is the section that determines the `Verification` model, so it is stated
precisely.

### Is there structured error data? No.

There is no object anywhere exposing a PHP error class, message, file, or line
as fields.

The most misleading near-miss: a thrown error carries an own property
`originalErrorClassName`. It is **not** the PHP error class. On the CLI it is
always the literal string `"PHPExecutionFailureError"` and in the browser always
`"Error"` — identical for an undefined function, a typed uncaught exception, a
memory exhaustion, and a parse error. Its sibling `source` is always
`"request"`, and `cause` is `{}`. Treating any of these as structured error data
would be fabrication.

### How a PHP fatal surfaces

`php.run()` / `client.run()` **throws** a plain JS `Error` rather than returning
a response. The throw carries:

- `message` — a formatted blob:
  `"PHP.run() failed with exit code 255. \n\n=== Stdout ===\n ...\n\n=== Stderr ===\n ..."`.
  The `Stdout` section contains PHP's HTML-escaped fatal output (`<b>`, `&gt;`,
  `&quot;`).
- `response.httpStatusCode` — see the divergence table; **never a reliable
  failure signal**. The CLI returns `200` on a fatal.
- `response.errors` — PHP's stderr. Populated for memory-limit and parse errors,
  **empty** for an uncaught exception or undefined function.
- `response.text` — empty in every fatal case observed.

### The three places error text can be read, ranked

1. **`/wordpress/wp-content/debug.log`** — best. Requires
   `constants: { WP_DEBUG: true, WP_DEBUG_LOG: true }`. Plain text, **not**
   HTML-escaped, with a timestamp and the full stack trace. Readable from both
   surfaces via `run()`. Actual content:

   ```
   [12-Sep-2026 10:08:45 UTC] PHP Fatal error:  Uncaught Error: Call to undefined function phase0_missing_function() in /wordpress/wp-content/plugins/phase0-fatal/phase0-fatal.php:6
   Stack trace:
   #0 /wordpress/wp-includes/class-wp-hook.php(324): {closure}(false)
   #1 /wordpress/wp-includes/class-wp-hook.php(348): WP_Hook->apply_filters('', Array)
   #2 /wordpress/wp-includes/plugin.php(517): WP_Hook->do_action(Array)
   #3 /wordpress/wp-admin/includes/plugin.php(703): do_action('activate_phase0...', false)
   #4 /internal/eval.php(4): activate_plugin('phase0-fatal/ph...')
   #5 {main}
     thrown in /wordpress/wp-content/plugins/phase0-fatal/phase0-fatal.php on line 6
   ```

2. **The thrown error's `message`** — same information, HTML-escaped, needs
   entity decoding and `<br />`/`<b>` stripping first.

3. **`response.errors`** — only for some error classes. Not dependable.

### What can be extracted, and how reliably

Applying one fixed pattern to the decoded text:

```
/Uncaught\s+([A-Za-z_\\][A-Za-z0-9_\\]*)\s*:\s*([\s\S]*?)\s+in\s+(\/[^\s:]+):(\d+)/
```

yielded exactly:

```json
{
  "errorClass": "Error",
  "message": "Call to undefined function phase0_missing_function()",
  "file": "/wordpress/wp-content/plugins/phase0-fatal/phase0-fatal.php",
  "line": 6
}
```

| Question | Answer |
| --- | --- |
| Error class extractable? | Yes, by regex on raw text — for `Uncaught <Class>:` fatals. **Not** for memory-exhaustion or parse errors, which have no class. |
| Message extractable? | Yes, same match. |
| Stack frames extractable? | Yes. `debug.log` emits the standard `#N file(line): function()` format, one frame per line. Note WordPress truncates long arguments to `'activate_phase0...'`, so frame arguments are lossy. |
| Activation failure distinguishable from ordinary logs? | **Only indirectly.** Nothing labels a log line as an activation failure. It must be inferred from correlation: run the activation, then diff `debug.log`, and read the trace for `activate_plugin` / `do_action('activate_…')`. |
| What is unavailable? | Any structured error object; a reliable HTTP status signal; per-step success/failure from Blueprint events; a PHP error class for classless fatals; untruncated stack frame arguments. |

### One further observation on activation semantics

`activate_plugin()` never returned a `WP_Error` for a fatal — the process died
first and the call threw. A plugin that fatals on activation therefore cannot be
detected by inspecting `activate_plugin()`'s return value. It must be detected
by the throw plus a `debug.log` diff.

---

## 6. CI feasibility

### Not verified on GitHub Actions

No workflow run was executed — this repository has no remote and no Actions run
was triggered. Claiming CI works would be unfounded. What was verified is the
local equivalent, on macOS with Node 26.

`.github/workflows/ci.yml` was written with two jobs (`check`, `cli-spike`) on
`ubuntu-latest` with Node 22, but it is **unproven** until it runs.

### What was verified

A clean tree (source copied without `node_modules`/`.git`) ran end to end:

| Step | Result | Time |
| --- | --- | --- |
| `npm ci` | ok | 6.2 s (warm npm cache) |
| `npx tsc --noEmit` | ok | — |
| `npx vitest run` | 6 tests passed | 0.49 s |
| `npx tsx spike/cli/run.ts` | booted, introspected plugins | 12.8 s |

### Requirements and risks for `ubuntu-latest`

- **Network is required.** WordPress core is downloaded at boot
  (`https://wordpress.org/wordpress-6.8.2.zip`). PHP is not downloaded — the PHP
  wasm binaries ship inside `node_modules`.
- **`node_modules` is 685 MB**, of which `@php-wasm` is 475 MB. First install on
  a cold npm cache will be substantially slower than the 6.2 s measured here.
  Caching `~/.npm` is worthwhile; caching `node_modules` may be faster still.
- **npm install scripts must run.** esbuild's postinstall (Vite/Vitest) and
  `fs-ext-extra-prebuilt` are required. npm 11 blocks these by default; the
  needed approvals are committed in `package.json` under `allowScripts`, so
  `npm ci` does not prompt. Older npm runs them unconditionally.
- **Node version is untested above 22.** All local runs used Node 26.8.2. The
  workflow pins 22 and that combination has not been executed.
- **Not tested on Linux at all.** Every measurement is macOS/arm64.

### Is it stable enough to become a real CI test later?

The CLI spike is deterministic in what it asserts (a specific plugin installed
and active) and ran identically across repeated invocations. The stability risk
is not the assertion but the `wordpress.org` download on every boot, which makes
the job network-dependent and therefore occasionally flaky. Before promoting it
to a required check, pin the WordPress version (already done) and consider
caching the downloaded core.

Approximate cost per boot: **~10 s warm, ~87 s on the first run that downloads
WordPress core.**

---

## 7. Specification discrepancies

`docs/SPEC.md` was not modified. These are reported for the owner to decide.

1. **§11, Blueprint generation.** The spec assumes one Blueprint format. Phase 0
   shows the two surfaces disagree: v2 `plugins` works in the browser and fails
   in the CLI 3.1.53. Either the MVP emits v1 for both surfaces, or it emits a
   different format per surface — which would weaken "the same Blueprint" as a
   guarantee.

2. **§11 `[UNVERIFIED]` on versioned packages.** Resolved: `slug@version`
   (`"akismet@6.4.3"`) is officially supported in the top-level `plugins` array
   and in `installPlugin`.

3. **§9, `Verification.environment.failedComponents`.** Nothing in either
   runtime produces this list. Step events carry `undefined` output, and
   `run-blueprint` returns nothing. `installedComponents` and `failedComponents`
   can only be produced by executing PHP after boot and diffing against what the
   Blueprint requested. The spec should say that this list is *derived by the
   application*, not *reported by Playground*.

4. **§9, `errorClass` / `message`.** Confirmed: no structured error data exists.
   These fields are always regex extraction results. See §8 below.

5. **§3, Privacy.** The browser path loads
   `https://playground.wordpress.net/remote.html` into an iframe — a third-party
   origin that hosts the runtime and fetches WordPress core and plugins. The
   user's artifact is never uploaded, so "local-first" holds, but the privacy
   documentation should name this origin explicitly. Additionally: the host page
   **must not be cross-origin isolated** or the embed silently hangs. That
   belongs in §12.1 as a hard constraint.

6. **§6, Tier C.** Worth noting concretely: Playground runs SQLite via a MySQL
   translation layer, not MySQL. Any reported failure that depends on real MySQL
   behaviour is environment-bound by construction.

7. **§8.1, `admin_page_load` trigger.** Not exercised in Phase 0. Only boot and
   plugin activation were tested. `client.request({url})` returned a WordPress
   error page with HTTP 500, so the mechanism plausibly works, but the admin
   trigger remains unproven.

---

## 8. Recommended change to the `Verification` model

The spec anticipated this: *"If only raw logs are available, do not pretend the
runtime provides structured error classes."* That is now the confirmed case.

The existing shape is kept. One field is added, and it is the one §9 already
requires in prose — *"the extraction method — along with whether it was
deterministic — must be representable in the model"*:

```ts
export interface LogExtraction {
  source: "debug.log" | "thrown-error-message" | "response-stderr";
  deterministic: boolean;
  pattern?: string;
}
```

added as `failureReproduction.extraction?: LogExtraction`.

Rationale, and what it buys:

- `errorClass` and `message` stop implying runtime structure. Their provenance
  travels with them.
- A result can be re-derived and audited, because the pattern is recorded.
- `deterministic: false` becomes expressible for fatals with no class (memory
  exhaustion, parse errors), instead of silently omitting the class.
- `logs` remains the raw record, and stays the primary evidence.

Also recommended, not yet implemented because it affects Phase 7 rather than
Phase 0: `observed` should be set only from a `debug.log` diff taken across
trigger execution, never from the presence of any error text — the log may
already contain unrelated entries from boot.

---

## 9. Reproducing these results

```bash
npm ci
npx tsx spike/cli/validate-blueprint.ts spike/blueprints/minimal.v2.json
npx wp-playground-cli run-blueprint --blueprint=spike/blueprints/minimal.v2.json   # fails
npx wp-playground-cli run-blueprint --blueprint=spike/blueprints/minimal.v1.json   # succeeds, silently
npx tsx spike/cli/run.ts --fatal
npx tsx spike/cli/probe-error-shape.ts
npx tsx spike/cli/probe-wp-debug.ts

# browser: needs a browser that is NOT cross-origin isolated
npx vite --config vite.config.ts
npx tsx spike/browser/drive.ts "http://localhost:9500/"
npx tsx spike/browser/drive.ts "http://localhost:9500/?debug=1"
npx tsx spike/browser/drive.ts "http://localhost:9500/?v2=1"
```

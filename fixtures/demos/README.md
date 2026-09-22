# Demo corpus

Four end-to-end demonstrations, each exercising a different part of the
architecture. `spike/demos/run.ts` runs them and asserts the expected result;
CI runs it as the `demo-e2e` job.

> **All artifacts here are SYNTHETIC.** They follow the real structure of a
> WooCommerce "Copy for support" System Status Report and of PHP fatals written
> to `wp-content/debug.log` — both formats were verified against WooCommerce's
> own report generator and against real fatals captured from Playground in
> Phase 0 — but the sites, plugins and failures they describe are invented for
> demonstration. No real customer data appears anywhere in this repository, and
> no production history is implied.

| Demo | Artifact | Demonstrates |
| --- | --- | --- |
| A | `demo-a-php-requirement.txt` | A deterministic, evidence-backed Finding from a System Status Report alone |
| B | `demo-b-plugin-fatal.txt` | A fatal with catalog-resolved plugin ownership driving an executable trigger |
| C | *(no artifact — see below)* | A real Playground run reaching `observed = true` |
| D | `demo-d-limitations.txt` | Honest limitations: premium, unresolved and theme components |

Alongside them, `quick-start.txt` is the artifact the README walkthrough tells a
reviewer to paste. It is deliberately the smallest thing that exercises the whole
product — one plugin, one fatal — so the reproduction boots in seconds. CI drives
this exact file through the real UI in the `ui-e2e-spike` job, so the documented
walkthrough is verified on every push rather than once.

## Demo B's environment does not boot, and that is the demonstration

Demo B analyses cleanly and plans a tier-B reproduction, but its environment
**fails to boot**: `wordfence@7.11.4` throws `WP_MySQL_On_SQLite_Exception` from
`wfDB.php` during activation, because Playground runs on SQLite rather than
MySQL. Installation is all-or-nothing, so all six components are reported as
failed and the target's outcome is **Environment failed** — explicitly not "not
reproduced".

Verified deterministic on both surfaces, and isolated to that one plugin:
dropping `wordfence@7.11.4` boots the same environment with
`woocommerce@8.5.2 (active)` and four other plugins installed. The fixture is
left as it is because an honest *Environment failed* is worth more here than a
fixture edited until it passes. `spike/demos/run.ts` asserts Demo B's analysis
and, separately, executes a small plan to exercise `observed = false`.

## Demo C has no artifact, and why

Demo C proves the full runtime path — environment → trigger → `debug.log` diff
→ `observed = true` — against a real Playground instance, using a plugin that
genuinely fatals on activation.

That plugin is written into the instance by the demo rather than installed from
the artifact, because **no plugin in the WordPress.org repository was found that
fatals on activation under any PHP version Playground offers.** Three
candidates were tested and rejected:

- **A modern plugin on PHP 5.2** — Playground offers 5.2, but its own SQLite
  integration is not 5.2-compatible, so the environment fails to boot before any
  plugin loads. Infrastructure failure, not a reproduction.
- **Contact Form 7 4.9 on PHP 8.x** — uses `create_function()`, removed in PHP
  8, but only inside `wpcf7_autop()` at render time. Activation does not reach
  it.
- **WooCommerce 6.4.1 on PHP 8.4 and 8.5** — produces deprecation notices
  (`Using ${var} in strings`), not a fatal. That syntax is removed in PHP 9,
  which Playground does not offer.

So Demo C is a controlled case by necessity. It is marked as such, and it still
executes through the real shared verification core rather than a stub.

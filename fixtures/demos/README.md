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

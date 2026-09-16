/**
 * Phase 6.1 binary-search harness.
 *
 * Step 1 is the known-good isolation: startPlaygroundWeb → isReady → goTo("/").
 * Each higher step adds exactly one piece of product behaviour, cumulatively.
 * The driver runs every step and reports the first one where WordPress stops
 * rendering.
 *
 * ?step=N selects how much product behaviour to apply.
 */
import { startPlaygroundWeb } from "@wp-playground/client";

const step = Number(new URLSearchParams(location.search).get("step") ?? "1");

interface Report {
  step: number;
  applied: string[];
  errors: string[];
  done: boolean;
}
const report: Report = { step, applied: [], errors: [], done: false };
(window as unknown as Record<string, unknown>)["__BISECT__"] = report;

const note = (m: string): void => {
  report.applied.push(m);
  console.log(`BISECT ${m}`);
};

window.addEventListener("error", (e) => report.errors.push(`error: ${e.message}`));
window.addEventListener("unhandledrejection", (e) =>
  report.errors.push(`rejection: ${String((e as PromiseRejectionEvent).reason)}`),
);

const BLUEPRINT = {
  $schema: "https://playground.wordpress.net/blueprint-schema.json",
  version: 2,
  wordpressVersion: "6.8.2",
  phpVersion: "8.2",
  plugins: [{ source: "classic-editor@1.6.3", active: true }],
  constants: { WP_DEBUG: true, WP_DEBUG_LOG: true },
};

// ---- 2: product page structure ---------------------------------------
const body = document.body;
if (step >= 2) {
  note("2 product page structure");
  const masthead = document.createElement("header");
  masthead.className = "masthead";
  masthead.innerHTML = "<h1>WordPress Support Reproduction Engine</h1><p class='lede'>lede</p>";
  const form = document.createElement("form");
  form.className = "card";
  form.innerHTML = "<label class='label'>Support artifact</label><textarea class='paste' rows='14'></textarea>";
  const results = document.createElement("div");
  results.id = "results";
  results.innerHTML = "<section class='card'><h2>Environment</h2><p>placeholder</p></section>";
  body.prepend(masthead, form, results);
}

// ---- 3: product stylesheet -------------------------------------------
if (step >= 3) {
  note("3 product stylesheet");
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/app-styles.css";
  document.head.append(link);
  body.classList.add("app");
}

// ---- 4: product iframe container -------------------------------------
let frame = document.getElementById("wp") as HTMLIFrameElement;
let panel: HTMLElement | undefined;
if (step >= 4) {
  note("4 product iframe container");
  panel = document.createElement("section");
  panel.id = "playground-panel";
  panel.className = "card playground-panel";
  panel.innerHTML = "<h2>WordPress Playground</h2><p class='hint'>hint</p>";
  frame.remove();
  frame = document.createElement("iframe");
  frame.id = "wp";
  frame.className = "playground-frame";
  frame.title = "WordPress Playground reproduction";
  panel.append(frame);
  body.append(panel);
}

// ---- 5: hidden until launch ------------------------------------------
if (step >= 5 && panel) {
  note("5 panel hidden at load, unhidden before boot");
  panel.hidden = true;
  // Unhide immediately before booting, exactly as the product does.
  panel.hidden = false;
}

async function main(): Promise<void> {
  const client = await startPlaygroundWeb({
    iframe: frame,
    remoteUrl: "https://playground.wordpress.net/remote.html",
    blueprint: BLUEPRINT as never,
  });
  await client.isReady();
  note("ready");

  const run = async (code: string): Promise<string> => {
    try {
      const r = await client.run({ code });
      return String(r.text);
    } catch {
      return "";
    }
  };

  // ---- 9: navigate at ready (product's onInstance behaviour) ---------
  if (step >= 9) {
    note("9 goTo at ready (onInstance)");
    await client.goTo("/");
  }

  // ---- 6: environment verification ----------------------------------
  if (step >= 6) {
    note("6 readSiteState");
    await run(
      `<?php
require_once '/wordpress/wp-load.php';
require_once '/wordpress/wp-admin/includes/plugin.php';
$all = get_plugins();
$out = [];
foreach ($all as $file => $data) { $out[] = $file . '|' . ($data['Version'] ?? ''); }
echo json_encode(['installed' => $out, 'active' => array_values(get_option('active_plugins', []))]);`,
    );
  }

  // ---- 7: log access -------------------------------------------------
  if (step >= 7) {
    note("7 readDebugLog");
    await run(`<?php $p='/wordpress/wp-content/debug.log'; echo file_exists($p) ? file_get_contents($p) : '';`);
  }

  // ---- 8: trigger execution -----------------------------------------
  if (step >= 8) {
    note("8 trigger: deactivate then activate");
    await run(
      `<?php
require_once '/wordpress/wp-load.php';
require_once '/wordpress/wp-admin/includes/plugin.php';
foreach (array_keys(get_plugins()) as $f) { if (strpos($f,'classic-editor/')===0) deactivate_plugins($f); }`,
    );
    await run(`<?php $p='/wordpress/wp-content/debug.log'; echo file_exists($p) ? file_get_contents($p) : '';`);
    await run(
      `<?php
require_once '/wordpress/wp-load.php';
require_once '/wordpress/wp-admin/includes/plugin.php';
foreach (array_keys(get_plugins()) as $f) { if (strpos($f,'classic-editor/')===0) activate_plugin($f); }`,
    );
    await run(`<?php $p='/wordpress/wp-content/debug.log'; echo file_exists($p) ? file_get_contents($p) : '';`);
  }

  // ---- 1 & 10: navigation -------------------------------------------
  // step 0 answers whether any goTo is needed at all.
  if (step >= 1) {
    note("10 goTo after verification");
    await client.goTo("/");
  } else {
    note("0 no goTo at all");
  }
}

try {
  await main();
} catch (e) {
  report.errors.push(`fatal: ${String((e as Error).message).slice(0, 300)}`);
}
report.done = true;
console.log("BISECT DONE");

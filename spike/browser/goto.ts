import { startPlaygroundWeb } from "@wp-playground/client";
const out: Record<string, unknown> = { done: false };
(window as unknown as Record<string, unknown>)["__GOTO__"] = out;
const log = document.getElementById("log") as HTMLPreElement;
const say = (m: string): void => { log.textContent += `\n${m}`; console.log("GOTO " + m); };
try {
  const client = await startPlaygroundWeb({
    iframe: document.getElementById("wp") as HTMLIFrameElement,
    remoteUrl: "https://playground.wordpress.net/remote.html",
    blueprint: {
      $schema: "https://playground.wordpress.net/blueprint-schema.json",
      version: 2, wordpressVersion: "6.8.2", phpVersion: "8.2",
      plugins: [{ source: "classic-editor@1.6.3", active: true }],
      constants: { WP_DEBUG: true, WP_DEBUG_LOG: true },
    } as never,
  });
  await client.isReady();
  say("ready");
  // Replay what the executor does before navigating, to see whether it is
  // what leaves the iframe blank.
  if (new URLSearchParams(location.search).has("execute")) {
    const run = async (code: string): Promise<void> => {
      try { await client.run({ code }); } catch { /* fatals throw */ }
    };
    await run(`<?php require_once '/wordpress/wp-load.php'; require_once '/wordpress/wp-admin/includes/plugin.php'; echo json_encode(array_keys(get_plugins()));`);
    await run(`<?php $p='/wordpress/wp-content/debug.log'; echo file_exists($p)?file_get_contents($p):'';`);
    await run(`<?php require_once '/wordpress/wp-load.php'; require_once '/wordpress/wp-admin/includes/plugin.php'; foreach (array_keys(get_plugins()) as $f) { if (strpos($f,'classic-editor/')===0) deactivate_plugins($f); }`);
    await run(`<?php require_once '/wordpress/wp-load.php'; require_once '/wordpress/wp-admin/includes/plugin.php'; foreach (array_keys(get_plugins()) as $f) { if (strpos($f,'classic-editor/')===0) activate_plugin($f); }`);
    say("replayed executor PHP calls");
  }

  if (!new URLSearchParams(location.search).has("skiprequest")) {
    const r = await client.request({ url: "/" });
    say(`request('/') status=${String((r as { httpStatusCode?: number }).httpStatusCode)} len=${String(String(r.text).length)}`);
    out["status"] = (r as { httpStatusCode?: number }).httpStatusCode;
    out["len"] = String(r.text).length;
  } else {
    say("skipped request('/')");
  }
  await client.goTo("/");
  say("goTo('/') done");
} catch (e) { say("ERROR " + String((e as Error).message).slice(0,200)); out["error"] = String((e as Error).message); }
out["done"] = true;

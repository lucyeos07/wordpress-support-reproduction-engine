/**
 * Phase 0 spike: determine exactly how much STRUCTURE the Playground runtime
 * gives us about a PHP fatal, versus how much is only raw text.
 *
 * This question decides the shape of `Verification` in docs/SPEC.md §9.
 */
import { runCLI } from "@wp-playground/cli";

const server = await runCLI({
  command: "server",
  blueprint: { preferredVersions: { php: "8.2", wp: "6.8.2" } } as never,
  port: 9402,
  verbosity: "quiet",
  skipBrowser: true,
});
const php = server.playground;

const cases: Record<string, string> = {
  undefined_function: `<?php require_once '/wordpress/wp-load.php'; no_such_function_xyz();`,
  uncaught_typed_exception: `<?php require_once '/wordpress/wp-load.php'; throw new InvalidArgumentException('probe-msg');`,
  fatal_memory: `<?php ini_set('memory_limit','2M'); $a=[]; while(true){ $a[]=str_repeat('x',10000); }`,
  parse_error: `<?php require_once '/wordpress/wp-load.php'; this is not php ;;;`,
  clean_success: `<?php echo "fine";`,
};

for (const [name, code] of Object.entries(cases)) {
  console.log(`\n================ ${name} ================`);
  try {
    const res = await php.run({ code });
    console.log("RESOLVED (did not throw)");
    console.log("  exitCode        :", res.exitCode);
    console.log("  httpStatusCode  :", res.httpStatusCode);
    console.log("  errors          :", JSON.stringify(res.errors));
    console.log("  text (300)      :", JSON.stringify(String(res.text).slice(0, 300)));
  } catch (e) {
    const err = e as Error & Record<string, unknown>;
    console.log("THREW");
    console.log("  constructor            :", err.constructor?.name);
    console.log("  ownEnumerableKeys      :", Object.keys(err));
    console.log("  originalErrorClassName :", JSON.stringify(err["originalErrorClassName"]));
    console.log("  source                 :", JSON.stringify(err["source"]));
    console.log("  cause                  :", JSON.stringify(err["cause"]));
    const response = err["response"] as { httpStatusCode?: number; errors?: string; text?: string } | undefined;
    console.log("  response.httpStatusCode:", response?.httpStatusCode);
    console.log("  response.errors        :", JSON.stringify(response?.errors));
    console.log("  response.text (400)    :", JSON.stringify(String(response?.text ?? "").slice(0, 400)));
    console.log("  err.message (600)      :", JSON.stringify(String(err.message).slice(0, 600)));
  }
}

await server[Symbol.asyncDispose]();
process.exit(0);

/**
 * Rendering. Presentation only.
 *
 * Nothing here interprets the artifact: every value shown comes from the
 * Environment, Findings, ReproPlan or Verification produced by the existing
 * modules. The UI adds labels, never conclusions.
 */
import type { Analysis } from "./analyze.js";
import type { Verification } from "../types/verification.js";
import type { Evidence } from "../types/evidence.js";
import type { Finding } from "../types/finding.js";
import { targetOutcome, presentOutcome, summariseOutcomes } from "./outcome.js";
import { REPRO_STAGE_LABELS, type ReproStage } from "./state.js";
import {
  el,
  badge,
  fieldValue,
  SEVERITY_LABEL,
  TIER_LABEL,
  RELEVANCE_LABEL,
  triggerLabel,
} from "./dom.js";

export type EvidenceHandler = (line: number) => void;

function section(title: string, ...children: (Node | string | false | undefined)[]): HTMLElement {
  return el(
    "section",
    { class: "card" },
    el("h2", { text: title }),
    ...children.filter((c): c is Node | string => Boolean(c)),
  );
}

function definition(term: string, value: Node | string, note?: Node): HTMLElement {
  return el(
    "div",
    { class: "def" },
    el("dt", { text: term }),
    el("dd", {}, typeof value === "string" ? value : value, note ?? false),
  );
}

/** The pasted artifact, line-numbered so evidence can point into it. */
export function renderSource(source: string): HTMLElement {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const pre = el("pre", { class: "source", id: "source-view", tabindex: "0" });
  lines.forEach((line, index) => {
    const number = index + 1;
    pre.append(
      el(
        "span",
        { class: "source-line", id: `src-line-${String(number)}` },
        el("span", { class: "source-num", "aria-hidden": "true", text: String(number) }),
        el("span", { class: "source-text", text: line === "" ? " " : line }),
      ),
    );
  });
  return section("Pasted artifact", el("p", { class: "hint", text: "Evidence below links to these lines." }), pre);
}

function evidenceChip(evidence: Evidence, onEvidence: EvidenceHandler): HTMLElement {
  const line = evidence.locator.line;
  const label = line !== undefined ? `line ${String(line)}` : evidence.adapter;
  const button = el("button", {
    class: "chip",
    type: "button",
    title: evidence.excerpt,
    "aria-label": `Show evidence at ${label}: ${evidence.excerpt}`,
  });
  button.append(el("code", { text: evidence.excerpt.trim().slice(0, 90) }), el("span", { class: "chip-loc", text: label }));
  if (line !== undefined) button.addEventListener("click", () => onEvidence(line));
  return button;
}

export function renderEnvironment(analysis: Analysis, onEvidence: EvidenceHandler): HTMLElement {
  const { environment } = analysis;
  const list = el("dl", { class: "defs" });

  const rows: Array<[string, ReturnType<typeof fieldValue>, Evidence | undefined]> = [
    ["WordPress", fieldValue(environment.wordPress.version), environment.wordPress.version.evidence?.[0]],
    ["PHP", fieldValue(environment.server.phpVersion), environment.server.phpVersion.evidence?.[0]],
    ["WooCommerce", fieldValue(environment.wooCommerce.version), environment.wooCommerce.version.evidence?.[0]],
    ["Database", fieldValue(environment.database.engine), environment.database.engine.evidence?.[0]],
    ["Web server", fieldValue(environment.server.webServer), environment.server.webServer.evidence?.[0]],
    ["Memory limit", fieldValue(environment.server.memoryLimit), environment.server.memoryLimit.evidence?.[0]],
    ["Theme", fieldValue(environment.theme.name), environment.theme.name.evidence?.[0]],
    ["Child theme", fieldValue(environment.theme.isChildTheme), undefined],
  ];

  for (const [term, value, evidence] of rows) {
    const dd = el("span", { class: `value value-${value.status}` }, value.text, badge(value.status));
    if (evidence) dd.append(evidenceChip(evidence, onEvidence));
    list.append(definition(term, dd));
  }

  const byKind = (kind: string): number => environment.plugins.filter((p) => p.kind === kind).length;
  list.append(
    definition(
      "Plugins",
      `${String(environment.plugins.length)} total — ${String(byKind("active"))} active, ${String(byKind("inactive"))} inactive, ${String(byKind("must-use"))} must-use, ${String(byKind("dropin"))} drop-in`,
    ),
  );

  const pluginTable = el("table", { class: "plugins" });
  pluginTable.append(
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        el("th", { text: "Plugin" }),
        el("th", { text: "Version" }),
        el("th", { text: "Kind" }),
        el("th", { text: "Source" }),
      ),
    ),
  );
  const tbody = el("tbody");
  for (const plugin of environment.plugins) {
    tbody.append(
      el(
        "tr",
        {},
        el("td", {}, plugin.name, plugin.evidence ? evidenceChip(plugin.evidence, onEvidence) : false),
        el("td", { text: plugin.version ?? "—" }),
        el("td", { text: plugin.kind }),
        el("td", { text: plugin.slug !== undefined ? `${plugin.source} (${plugin.slug})` : plugin.source }),
      ),
    );
  }
  pluginTable.append(tbody);

  const warnings = environment.provenance.warnings;
  const warningBlock =
    warnings.length > 0
      ? el(
          "div",
          { class: "warnings", role: "note" },
          el("h3", {}, "Parser warnings ", badge("warning")),
          el("p", { class: "hint", text: "These describe how well the artifact could be read. They are not diagnoses." }),
          el(
            "ul",
            {},
            ...warnings.map((w) =>
              el("li", {}, el("code", { text: w.code }), ` ${w.detail}`),
            ),
          ),
        )
      : undefined;

  const missing = analysis.diagnosis.informationRequest.missingFields;
  const missingBlock =
    missing.length > 0
      ? el(
          "div",
          { class: "missing-info" },
          el("h3", { text: "Missing information" }),
          el("p", {
            class: "hint",
            text: "Rules that could not run asked for these. This is not a finding.",
          }),
          el("ul", {}, ...missing.map((m) => el("li", {}, el("code", { text: m })))),
        )
      : undefined;

  return section("Environment", list, el("h3", { text: "Components" }), pluginTable, warningBlock, missingBlock);
}

function renderFinding(finding: Finding, onEvidence: EvidenceHandler): HTMLElement {
  return el(
    "article",
    { class: `finding severity-${finding.severity}`, "aria-labelledby": `f-${finding.ruleId}` },
    el(
      "header",
      {},
      el("h3", { id: `f-${finding.ruleId}`, text: finding.title }),
      el(
        "p",
        { class: "meta" },
        el("span", { class: `pill pill-${finding.severity}`, text: `Severity: ${SEVERITY_LABEL[finding.severity] ?? finding.severity}` }),
        el("span", { class: "pill", text: `Confidence: ${finding.confidence}` }),
        el("span", { class: "pill pill-quiet", text: finding.ruleId }),
      ),
    ),
    el("h4", { text: "Explanation" }),
    el("p", { class: "prose", text: finding.cause }),
    el("h4", { text: "Evidence" }),
    el("div", { class: "chips" }, ...finding.evidence.map((e) => evidenceChip(e, onEvidence))),
    el("h4", { text: "Recommended remediation" }),
    el("p", { class: "prose", text: finding.fix }),
    el("h4", { text: "Citations" }),
    el(
      "ul",
      { class: "citations" },
      ...finding.citations.map((c) =>
        el(
          "li",
          {},
          el("a", { href: c.url, target: "_blank", rel: "noreferrer noopener", text: c.title }),
          ` — ${c.publisher}, retrieved ${c.retrievedAt}`,
        ),
      ),
    ),
    el("h4", { text: "Reproducibility impact" }),
    el("p", { class: "prose", text: finding.reproducibilityImpact }),
  );
}

export function renderFindings(analysis: Analysis, onEvidence: EvidenceHandler): HTMLElement {
  const { findings, evaluations } = analysis.diagnosis;

  const declined = evaluations.filter((e) => e.outcome !== "finding" && e.outcome !== "no_match");
  const declinedBlock =
    declined.length > 0
      ? el(
          "details",
          { class: "declined" },
          el("summary", { text: `${String(declined.length)} rule(s) did not evaluate` }),
          el(
            "ul",
            {},
            ...declined.map((e) =>
              el(
                "li",
                {},
                el("code", { text: e.ruleId }),
                ` ${e.outcome}`,
                e.missingFields ? ` — needs ${e.missingFields.join(", ")}` : "",
                e.reason ? ` — ${e.reason}` : "",
              ),
            ),
          ),
        )
      : undefined;

  if (findings.length === 0) {
    return section(
      "Findings",
      el("p", { class: "empty", text: "No rule matched this artifact. That is not the same as the site being healthy." }),
      declinedBlock,
    );
  }

  return section(
    "Findings",
    el("p", { class: "hint", text: `${String(findings.length)} finding(s). Severity and confidence are independent.` }),
    ...findings.map((f) => renderFinding(f, onEvidence)),
    declinedBlock,
  );
}

export function renderReproducibility(analysis: Analysis): HTMLElement {
  const { plan, environment } = analysis;

  const verdict = el(
    "div",
    { class: "verdict" },
    el("p", {}, el("strong", { text: "Plan verdict: " }), TIER_LABEL[plan.verdict.tier] ?? plan.verdict.tier),
    el("p", { class: "hint", text: `Status: ${plan.verdict.status}. The plan reports the most reproducible target and does not override the others.` }),
  );

  const targets = plan.targets.map((target) => {
    const signature = environment.signatures[target.signatureIndex];
    const supported = target.trigger !== undefined;

    return el(
      "article",
      { class: "target", "aria-label": `Target ${String(target.signatureIndex)}` },
      el(
        "header",
        {},
        el("h3", { text: `Target #${String(target.signatureIndex)}` }),
        el(
          "p",
          { class: "meta" },
          el("span", { class: `pill pill-tier-${target.verdict.tier}`, text: TIER_LABEL[target.verdict.tier] ?? target.verdict.tier }),
          el("span", { class: "pill", text: target.verdict.status }),
          el("span", { class: supported ? "pill pill-ok" : "pill pill-warn", text: supported ? "Trigger supported" : "No supported trigger" }),
        ),
      ),
      el("h4", { text: "Reported signature" }),
      el(
        "p",
        { class: "prose mono" },
        signature
          ? `${signature.errorClass ?? "(no class)"}: ${signature.message ?? "(no message)"}${signature.file !== undefined ? ` — ${signature.file}${signature.line !== undefined ? `:${String(signature.line)}` : ""}` : ""}`
          : "(signature unavailable)",
      ),
      el(
        "p",
        { class: "meta" },
        el("span", { class: "pill pill-quiet", text: `Owner: ${signature?.owner.type ?? "unknown"}${signature?.owner.slug !== undefined ? ` (${signature.owner.slug})` : ""}` }),
        el("span", { class: "pill pill-quiet", text: `Attribution confidence: ${signature?.owner.confidence ?? "—"}` }),
      ),
      el("h4", { text: "Trigger" }),
      el("p", { class: "prose", text: triggerLabel(target.trigger) }),
      target.reason !== undefined ? el("p", { class: "prose warn-text", text: target.reason }) : false,
      el("h4", { text: "Why" }),
      el("ul", { class: "reasons" }, ...target.reasons.map((r) => el("li", {}, el("code", { text: r.code }), ` ${r.detail}`))),
    );
  });

  const substitutions =
    plan.substitutions.length > 0
      ? el(
          "div",
          {},
          el("h3", { text: "Substitutions" }),
          el("p", { class: "hint", text: "Differences Playground forces on the reported environment. None is silent." }),
          el(
            "ul",
            { class: "subs" },
            ...plan.substitutions.map((s) =>
              el("li", {}, el("strong", { text: s.requested }), " → ", el("strong", { text: s.substituted }), el("div", { class: "hint", text: s.why })),
            ),
          ),
        )
      : undefined;

  const omissions =
    plan.omissions.length > 0
      ? el(
          "div",
          {},
          el("h3", { text: "Omissions" }),
          el("p", { class: "hint", text: "Reported components that cannot be recreated, with their relevance to the failure." }),
          el(
            "ul",
            { class: "subs" },
            ...plan.omissions.map((o) =>
              el(
                "li",
                {},
                el("strong", { text: o.component }),
                " ",
                el("span", { class: `pill pill-rel-${o.relevance}`, text: RELEVANCE_LABEL[o.relevance] ?? o.relevance }),
                el("div", { class: "hint", text: o.why }),
              ),
            ),
          ),
        )
      : undefined;

  return section(
    "Reproducibility",
    verdict,
    plan.targets.length === 0
      ? el("p", { class: "empty", text: "No reproduction targets: the artifact carried no usable error signature." })
      : el("div", { class: "targets" }, ...targets),
    substitutions,
    omissions,
  );
}

export function renderBlueprint(analysis: Analysis, onCopy: (text: string) => void): HTMLElement {
  const json = JSON.stringify(analysis.plan.blueprint, null, 2);

  const copyButton = el("button", { class: "button", type: "button", text: "Copy Blueprint" });
  copyButton.addEventListener("click", () => onCopy(json));

  const details = el(
    "details",
    { class: "blueprint" },
    el("summary", { text: "View Blueprint" }),
    el("pre", { class: "code", text: json }),
  );

  return section(
    "Blueprint",
    el("p", {
      class: "hint",
      text: "This Blueprint represents the reported environment, not a recommended one. It is generated from the artifact and is not editable here.",
    }),
    el("div", { class: "actions" }, copyButton),
    details,
  );
}

export function renderProgress(stage: ReproStage, progress: string[]): HTMLElement {
  const stages: ReproStage[] = ["booting", "verifying_environment", "executing_triggers", "finalising"];
  const list = el("ol", { class: "stages" });
  for (const s of stages) {
    const done = stages.indexOf(s) < stages.indexOf(stage);
    const current = s === stage;
    list.append(
      el(
        "li",
        {
          class: current ? "stage current" : done ? "stage done" : "stage",
          "aria-current": current ? "step" : undefined,
        },
        REPRO_STAGE_LABELS[s],
        current ? " — in progress" : done ? " — done" : "",
      ),
    );
  }
  return el(
    "div",
    { class: "progress", role: "status", "aria-live": "polite" },
    list,
    progress.length > 0 ? el("pre", { class: "log", text: progress.join("\n") }) : false,
  );
}

export function renderVerification(verification: Verification): HTMLElement {
  const env = verification.environment;

  const environmentBlock = el(
    "div",
    { class: `panel ${env.bootSucceeded ? "panel-ok" : "panel-fail"}` },
    el("h3", { text: "Environment reconstruction" }),
    el(
      "p",
      { class: "status-line" },
      el("strong", { text: env.bootSucceeded ? "Boot succeeded" : "Boot failed" }),
    ),
    el("h4", { text: `Installed components (${String(env.installedComponents.length)})` }),
    env.installedComponents.length > 0
      ? el("ul", {}, ...env.installedComponents.map((c) => el("li", { text: c })))
      : el("p", { class: "empty", text: "None." }),
    el("h4", { text: `Failed components (${String(env.failedComponents.length)})` }),
    env.failedComponents.length > 0
      ? el("ul", { class: "fail-list" }, ...env.failedComponents.map((c) => el("li", { text: c })))
      : el("p", { class: "empty", text: "None." }),
  );

  const outcomes = verification.failureReproduction.targets.map((t) => targetOutcome(verification, t));

  const targetBlocks = verification.failureReproduction.targets.map((target, index) => {
    const outcome = outcomes[index]!;
    const presentation = presentOutcome(outcome);
    return el(
      "article",
      { class: `target target-${presentation.tone}`, "aria-label": `Target ${String(target.signatureIndex)} result` },
      el(
        "header",
        {},
        el("h4", { text: `Target #${String(target.signatureIndex)}` }),
        el("p", { class: "status-line" }, el("strong", { class: `outcome outcome-${presentation.tone}`, text: presentation.label })),
      ),
      el("p", { class: "prose", text: presentation.detail }),
      el(
        "dl",
        { class: "defs" },
        definition("Trigger", triggerLabel(target.trigger)),
        definition("Attempted", target.attempted ? "Yes" : "No"),
        definition("Observed", target.observed ? "Yes" : "No"),
      ),
      target.errorClass !== undefined || target.message !== undefined
        ? el(
            "div",
            {},
            el("h5", { text: "Extracted error" }),
            el("p", { class: "prose mono", text: `${target.errorClass ?? "(no class)"}: ${target.message ?? "(no message)"}` }),
            target.extraction
              ? el("p", { class: "hint", text: `Extracted from ${target.extraction.source}; ${target.extraction.deterministic ? "deterministic" : "not deterministic"}.` })
              : false,
          )
        : false,
      target.reason !== undefined ? el("p", { class: "hint", text: target.reason }) : false,
      target.logs !== undefined && target.logs.length > 0
        ? el(
            "details",
            {},
            el("summary", { text: `New log entries (${String(target.logs.length)})` }),
            el("pre", { class: "code", text: target.logs.join("\n\n") }),
          )
        : false,
    );
  });

  return section(
    "Verification",
    el("p", { class: "hint", text: summariseOutcomes(outcomes) }),
    environmentBlock,
    el("div", { class: "panel" }, el("h3", { text: "Failure reproduction" }), ...targetBlocks),
  );
}

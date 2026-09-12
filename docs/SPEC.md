# WordPress Support Reproduction Engine — MVP Specification

Status: authored constraint. Source of truth for implementation.

Marked `[UNVERIFIED]` items depend on current WordPress Playground behaviour and
must be confirmed experimentally in Phase 0 before any dependent code is written.
An `[UNVERIFIED]` claim in this document is a question, not a permission.

---

## 1. Product

A browser-first developer tool that converts WordPress/WooCommerce support
artifacts into a structured environment, evidence-backed diagnostics, a
reproducibility assessment, and a browser-based WordPress Playground
reproduction.

### 1.1 Core pipeline

```
Support artifact
  → Parser
  → Environment + Signature
  → Diagnosis
  → Reproducibility assessment
  → Blueprint
  → Playground
  → Verification
```

### 1.2 Central architectural principle

> **Reproduce the reported environment, not the diagnosis.**

The reproduction path reconstructs what the reporter described. It is
structurally prevented from reconstructing what the diagnostic system believes
caused the failure. See §7, Reproduction firewall.

### 1.3 What this product does not claim

The tool does not claim universal WordPress reproduction capability. A large
class of reported failures is not reproducible in Playground, and the product
must say so plainly rather than producing a degraded imitation.

---

## 2. Input

### 2.1 Supported artifacts (MVP)

1. WooCommerce System Status Reports.
2. PHP fatal errors / WordPress debug log excerpts.

### 2.2 Adapter contract

Both input adapters produce the same canonical internal representation
(§4, Environment). No downstream stage may branch on which adapter produced the
data. Adapter-specific knowledge terminates at the adapter boundary.

A System Status Report primarily populates `Environment`. A debug log excerpt
primarily populates `ErrorSignature`. Either may populate both. Either may be
supplied alone.

---

## 3. Privacy

The MVP is local-first.

- The user's support artifact must not be uploaded to a project backend.
- No hidden WordPress.org API lookups. No network call may be issued as an
  implicit side effect of parsing, diagnosis, or planning.
- Plugin slug resolution uses a bundled curated catalog (§4.4).
- Unknown plugins remain unresolved. They are never guessed.

Future online resolution may exist as an explicit opt-in feature. It is not part
of the MVP and no code path may anticipate it by leaving a disabled network call
in place.

Playground itself fetches WordPress core, PHP, and plugin packages from public
infrastructure. This is inherent to running a reproduction and must be disclosed
in the privacy documentation (§16), but it never transmits the user's artifact.

---

## 4. Environment

### 4.1 Canonical model

`Environment` contains, where available:

- provenance
- WordPress
- server
- database
- theme
- plugins
- WooCommerce
- signature

### 4.2 Known / missing / inferred

Every field distinguishes three states. Missing information must never become a
fabricated default.

```ts
type FieldStatus = "known" | "missing" | "inferred";

interface Field<T> {
  status: FieldStatus;
  value?: T;               // absent when status === "missing"
  evidence?: Evidence[];   // required when status is "known" or "inferred"
  inferenceBasis?: string; // required when status === "inferred"
}
```

- `known` — read directly from the artifact. Carries evidence.
- `inferred` — derived from other known values by a deterministic, documented
  rule. Carries evidence for the inputs and a stated basis for the derivation.
- `missing` — not present in the artifact. Carries no value. A consumer that
  requires the field must degrade, request the information (§10), or decline.

There is no fourth state. "Default", "assumed", and "typical" are not states.

### 4.3 Evidence

Every important parsed value is traceable to source evidence.

```ts
interface Evidence {
  artifactId: string;            // which supplied artifact
  adapter: "woo-ssr" | "debug-log";
  locator: {
    section?: string;            // e.g. SSR section heading
    line?: number;               // 1-based line in the source artifact
  };
  excerpt: string;               // verbatim span supporting the value
}
```

`excerpt` is copied verbatim from the artifact. It is never normalised,
summarised, or reconstructed.

### 4.4 Plugin

```ts
interface Plugin {
  slug?: string;
  name: string;
  version?: string;
  author?: string;
  active?: boolean;
  source: "wordpress.org" | "premium" | "unknown";
  testedUpTo?: string;
}
```

Slug resolution is performed against a bundled curated catalog keyed by
`(plugin display name, author)` rather than by name alone, because display names
collide across authors and a name-only match silently installs the wrong plugin.

Resolution outcomes:

- matched in catalog → `slug` set, `source: "wordpress.org"`
- known premium plugin in catalog → `slug` unset, `source: "premium"`
- no match → `slug` unset, `source: "unknown"`

An unresolved plugin is never installed by guessing a slug from its name. It
becomes an explicit omission in the reproduction plan (§8).

### 4.5 Error signature

```ts
interface ErrorSignature {
  errorClass?: string;
  message?: string;
  file?: string;
  line?: number;
  frames?: StackFrame[];

  owner: {
    type: "plugin" | "theme" | "core" | "unknown";
    slug?: string;
    confidence: "high" | "medium" | "low";
  };
}

interface StackFrame {
  file?: string;
  line?: number;
  function?: string;
  raw: string;                   // verbatim frame text
}
```

Owner attribution is derived from file paths in `file` and `frames` against
known WordPress directory layout (`wp-content/plugins/<dir>/`,
`wp-content/themes/<dir>/`, `wp-includes/`, `wp-admin/`). A path that does not
resolve to a recognised layout yields `type: "unknown"`. Directory name is not
assumed to equal the WordPress.org slug; the catalog mediates that mapping, and
an unmediated directory name yields at most `confidence: "low"`.

---

## 5. Findings

### 5.1 Model

```ts
interface Finding {
  ruleId: string;
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
  evidence: Evidence[];          // non-empty
  cause: string;
  fix: string;
  citations: Citation[];         // non-empty
  reproducibilityImpact: string;
}

interface Citation {
  title: string;
  url: string;
  publisher: string;             // official upstream source only
  retrievedAt: string;           // ISO 8601
}
```

### 5.2 Rules

- Severity and confidence are separate axes and are never collapsed. A
  high-severity finding may be low-confidence; a low-severity finding may be
  certain.
- No finding ships without evidence.
- No finding ships without an authoritative citation. Authoritative means
  official upstream documentation — WordPress.org, WooCommerce, PHP — not blog
  posts, forum threads, or model-generated prose.
- `reproducibilityImpact` is explanatory text for the reader. It is **not** an
  input to the reproduction planner and must never be read by it (§7).
- "Insufficient information" is not a Finding. It belongs to the
  reproducibility/evidence layer (§10).

### 5.3 Initial diagnostic corpus

Approximately 5–8 deterministic rules. Candidates:

| Rule | Requires |
| --- | --- |
| PHP version incompatibility | PHP version, component requirement |
| WordPress/plugin version incompatibility | WP version, plugin `testedUpTo`/requirement |
| WooCommerce version mismatch | WooCommerce version, related component requirement |
| Fatal error with identifiable plugin ownership | signature with `owner.type === "plugin"` |
| Missing/inactive dependency, objectively detectable | plugin list, declared dependency |
| Outdated WooCommerce template override | SSR template override section |
| Memory-limit issue with explicit supporting evidence | memory limit value and a memory-exhaustion signature |

Every rule is deterministic. Given the same `Environment`, a rule produces the
same result, with no model involvement in the decision.

A rule that cannot evaluate because its required evidence is missing does not
emit a Finding. It registers its unmet requirements (§10).

---

## 6. Reproducibility taxonomy

Draft tiers. Specific examples must be validated against current Playground
capabilities before the taxonomy is coded `[UNVERIFIED]`.

- **A — Reproducible.** The relevant reported condition can be recreated within
  Playground without material environmental substitution.
- **B — Reproducible with substitution.** The condition can potentially be
  tested with an explicit substitution. Every substitution is visible to the
  user.
- **C — Environment-bound.** The condition depends on infrastructure Playground
  cannot faithfully reproduce.
- **D — Dependency-bound.** The condition depends on an external or unavailable
  dependency.
- **E — Insufficient evidence.** There is not enough information to responsibly
  attempt reproduction.

### 6.1 Relevance, not worst-tier-wins

Tier assignment does not simply take the worst tier across all environment
components. A limitation only affects the tier if it is relevant to the
**reported failure**.

Deterministic relevance rules:

- A plugin explicitly named in the error signature is `relevant`.
- An inactive plugin not named in the signature may be treated as `irrelevant`
  to an activation or runtime reproduction, because it is not loaded.
- Otherwise the relevance is `unknown`.

`unknown` relevance is never silently resolved in either direction. It is
surfaced, and it constrains the achievable tier.

---

## 7. Reproduction firewall

A hard architectural boundary, enforced by module structure and by test.

`ReproPlan` may read:

- `Environment`
- `Signature`

`ReproPlan` must never read:

- `Finding`
- diagnostic rules
- AI-generated conclusions

The reproduction reconstructs what was reported, independently of what the
diagnostic system believes caused it. A diagnosis that is wrong must not be able
to steer the reproduction toward confirming itself.

Enforcement: the reproduction module does not import the diagnostic module.
A test asserts the absence of that dependency edge.

---

## 8. Reproduction planning

### 8.1 Trigger model

Triggers derive only from `Environment` and `Signature`. Never from a `Finding`.

```ts
type ReproductionTrigger =
  | { kind: "boot" }
  | { kind: "plugin_activation"; slug: string }
  | { kind: "admin_page_load"; path: string };
```

Initial deterministic mapping:

- identifiable plugin owner in the signature → plugin activation, or another
  trigger the signature actually supports
- stack information clearly indicating a wp-admin page → admin page load
- no usable signature → boot, or unsupported
- unsupported workflow → `attempted: false` with an explicit reason

The MVP supports failures surfacing through **boot**, **plugin activation**, and
**admin page load** only.

Flows such as checkout, external callbacks, webhooks, and other interactive
workflows are not pretended. If the required trigger cannot actually be
executed, the plan records `attempted: false` and states why.

### 8.2 ReproPlan

```ts
interface ReproPlan {
  verdict: {
    tier: "A" | "B" | "C" | "D" | "E";
    status:
      | "reproducible"
      | "partial"
      | "blocked"
      | "insufficient_evidence";
  };

  reasons: Reason[];

  substitutions: {
    requested: string;
    substituted: string;
    why: string;
  }[];

  omissions: {
    component: string;
    why: string;
    relevance: "relevant" | "irrelevant" | "unknown";
  }[];

  blueprint?: unknown;

  verification?: Verification;
}

interface Reason {
  code: string;                  // stable machine-readable identifier
  detail: string;
  evidence?: Evidence[];
}
```

Every substitution appears in `substitutions` and is shown to the user. A
component is never silently swapped for a near-equivalent. Every component
present in `Environment` but absent from the Blueprint appears in `omissions`
with its relevance.

---

## 9. Verification

Environment reconstruction and failure reproduction are kept separate.

```ts
interface Verification {
  environment: {
    bootSucceeded: boolean;
    installedComponents: string[];
    failedComponents: string[];
  };

  failureReproduction: {
    attempted: boolean;
    trigger?: ReproductionTrigger;
    observed: boolean;
    errorClass?: string;
    message?: string;
    logs?: string[];
  };
}
```

The final implementation must reflect what current Playground APIs actually
expose `[UNVERIFIED]`. If only raw logs are available, the runtime must not be
presented as providing structured error classes. In that case `errorClass` and
`message` are populated only when they can be extracted deterministically from
raw log text, and the extraction method — along with whether it was
deterministic — must be representable in the model.

Phase 0 determines whether this shape survives contact with the runtime. It is
expected to change. A weaker but honest verification model is preferable to
fabricated structured data.

### 9.1 Verification semantics

The system distinguishes these states. They are not merged:

1. Blueprint was generated.
2. Environment booted.
3. Components installed.
4. Components failed to install or activate.
5. Reproduction trigger was actually attempted.
6. Reported failure was observed.

> "Playground booted successfully" is not equivalent to "bug reproduced
> successfully."

`observed: true` requires that the trigger was executed and the result was
seen. It is never inferred from a successful boot, from a matching environment,
or from the diagnosis.

---

## 10. Tier E information requests

Missing-information requests are derived dynamically, not hardcoded:

1. Take the evidence required by rules that cannot currently evaluate.
2. Union those missing requirements.
3. Subtract fields already available in `Environment`.
4. Deduplicate.

The result is a targeted "Please provide…" request. It does not create a
`Finding`.

---

## 11. Blueprint

Generate a valid current WordPress Playground Blueprint.

Before implementing generation, verify the current official Blueprint schema and
resource types `[UNVERIFIED]`. Do not invent Blueprint properties. A property
that cannot be found in the current published schema is not used.

Plugin installation:

- use WordPress.org slugs when resolved through the bundled catalog;
- use another officially supported versioned package mechanism only when
  appropriate `[UNVERIFIED]`;
- unresolved and premium plugins become explicit omissions (§8.2), never guessed
  installations.

Pinned WordPress and PHP versions come from `Environment` when known. When not
known, the version is either omitted or explicitly substituted and recorded in
`substitutions` — never silently defaulted.

---

## 12. Playground surfaces

The browser and CLI are **separate technical surfaces**. Both are tested
independently. Neither is assumed to behave like the other.

### 12.1 Browser

The browser Playground instance is the primary user-facing reproduction
experience. The user clicks **Reproduce in WordPress Playground** and receives an
isolated WordPress Playground instance in the browser.

- The project uses the current official browser embedding API `[UNVERIFIED]`.
- The user's real WordPress installation is never modified. The tool has no
  mechanism to reach it.

### 12.2 CLI

The Playground CLI is primarily for automated verification and CI.

The project distinguishes browser Playground feasibility from CLI/headless
Playground feasibility. A capability confirmed on one surface is not assumed on
the other.

---

## 13. Testing

The project is fixture-driven.

```
fixtures/
  ssr/
  logs/
  expected/
```

- Every parser fixture has expected structured output.
- Every diagnostic rule has positive and negative test coverage.
- Blueprints are schema-validated.
- Playground integration is tested wherever technically practical.
- A test enforces the reproduction firewall (§7).

Target: approximately 10–20 realistic fixtures for the MVP.

---

## 14. MVP scope

### 14.1 In

- WooCommerce System Status parser
- Basic fatal/debug log parser
- Environment IR
- Provenance and missing-field tracking
- 5–8 diagnostic rules
- A–E reproducibility taxonomy
- Deterministic reproduction planner
- Blueprint generation
- Browser Playground embedding
- CLI verification spike
- ~10–20 realistic fixtures
- Strict TypeScript, Vite, Vitest, CI

### 14.2 Out

- Accounts
- Authentication
- Backend APIs
- Database services
- Remote storage
- Multi-user functionality
- Chatbot functionality
- Unnecessary analytics

---

## 15. Development phases

| Phase | Scope |
| --- | --- |
| 0 | Playground browser + CLI feasibility spike and project skeleton |
| 1 | System Status parser + fixtures |
| 2 | Environment IR + provenance |
| 3 | Diagnostic rules |
| 4 | Reproducibility planner |
| 5 | Blueprint generation |
| 6 | Browser Playground integration |
| 7 | Automated verification |
| 8 | UI polish |

### 15.1 Phase 0 requirements

Phase 0 must prove both:

1. The current Playground CLI can load a minimal Blueprint and expose enough
   information for automated verification.
2. The current browser Playground API can embed/load the same Blueprint and
   expose enough runtime information for the application.

Minimum Blueprint:

- pinned WordPress version
- pinned PHP version
- one free WordPress.org plugin

The spike must investigate:

- installation success
- activation success
- runtime readiness
- logs
- errors
- fatal activation behaviour
- whether structured error data or only raw logs are available
- CI feasibility
- runtime cost

Phase 0 does not build the parser, diagnostic engine, reproduction planner,
Blueprint generator, or production UI.

Failure is a valid Phase 0 result. A capability that does not work is reported
as not working, not stubbed and not worked around silently.

---

## 16. Documentation

The project eventually documents:

- architecture
- supported diagnostic rules
- evidence/citation model
- reproducibility taxonomy
- Playground limitations
- verification semantics
- known unsupported cases
- privacy model

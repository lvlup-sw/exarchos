# Substrate vs Authoring Partition

> **Workflow:** `workload-agnostic-runtime-invariants` (discovery, Phase D per charter)
> **Date:** 2026-05-20
> **Status:** Research deliverable D4 of 5
> **Parent:** epic #1441

## 1. Why partition

The v1 catalog mixes two kinds of statements without distinguishing them:

- **Substrate invariants** govern the runtime's behavior — what the system *does* at execution time. Examples: "events are the source of truth," "every ToolResult carries next_actions," "every adapter is zero-behavior."
- **Authoring invariants** govern the *content* of artifacts the runtime produces or consumes — what artifacts *look like*. Example: "skill prose must not exhibit AI-writing tells" (DIM-8).

Conflating them creates two operational problems:

1. **Wrong consumers.** Substrate invariants govern the runtime engineer's design decisions; authoring invariants govern artifact reviewers (or `/axiom:humanize`). When `/ideate` Phase 0 loads "the catalog," it surfaces both kinds — but the design discussion that follows is almost always about substrate. The authoring entries are noise during runtime design.
2. **Wrong enforcement.** Substrate invariants are enforced by parity tests, schema validation, projection rebuild, and CI gates. Authoring invariants are enforced by prose linters and human review. Code that satisfies substrate invariants can fail authoring invariants (and vice versa) without crossing concerns.

The v2 catalog distinguishes them with a frontmatter `axis: substrate | authoring` field. Substrate-axis entries load at `/ideate` Phase 0 according to their `cost-of-load`. Authoring-axis entries never load at Phase 0 — they're addressed by `/axiom:humanize` and reviewer skills.

## 2. Formal criteria

**Substrate invariant** — a statement true of the runtime's behavior, expressible as an assertion over runtime state or runtime operations. Enforceable via parity test, schema check, projection rebuild, CI gate, or operational observation.

**Authoring invariant** — a statement true of an artifact's *content*. Enforceable via prose analysis, structural validation of human-readable text, or human review.

**Decision procedure** (apply in order):

1. **Question Q1:** Can the invariant be violated by code that runs correctly to completion?
   - YES → likely **substrate** (the runtime allowed a violation; the runtime is at fault).
   - NO → continue to Q2.

2. **Question Q2:** Does the invariant constrain the *content* of a document, skill body, comment, log message, or other prose artifact?
   - YES → **authoring**.
   - NO → return to Q1; re-examine whether "code running correctly" is the right frame.

3. **Tiebreaker (Q3):** Does the invariant's enforcement mechanism involve reading natural-language text and judging it?
   - YES → **authoring**.
   - NO → **substrate**.

## 3. Partition table

Apply the decision procedure to every entry (existing + new candidates from D2).

| ID | Statement | Q1 (runtime allows violation?) | Q2 (constrains prose?) | Q3 (enforcement reads text?) | Axis |
|---|---|---|---|---|---|
| INV-1 | Events are source of truth; reducers are pure folds | YES (in-place mutation runs but breaks integrity) | NO | NO | **substrate** |
| INV-2 | CLI and MCP are facades over single dispatch core | YES (an adapter could carry behavior; parity test catches it) | NO | NO | **substrate** |
| INV-3 | No design presumes MCP is local-only | YES (a handler could read `runtimes/<name>.yaml` at request time) | NO | NO | **substrate** |
| INV-4 | Platform-agnosticity — 6 runtimes; tokenization + guards | YES (a skills-src file could hardcode `Skill({...})`) | PARTIAL (constrains skill body content) | PARTIAL (vocabulary lint reads text) | **substrate** (the *enforcement* reads text, but the invariant is about runtime portability, not content quality) |
| INV-5a | Tool inputs schema-constrained; "do NOT use for" guidance | YES (a registry could ship a tool without input schema) | PARTIAL (constrains tool *description* content) | PARTIAL | **substrate** (same as INV-4 — content rule serves runtime portability) |
| INV-5b | ToolResult carries `next_actions`, `_meta`, `_perf` | YES (a handler could return without these fields) | NO | NO | **substrate** |
| INV-5c | Aspire verbs — observation + dry-run mutating | YES (a verb could be defined that violates this) | NO | NO | **substrate** |
| INV-5d | 4 visible composite tools with action discriminator | YES (a new top-level tool could be added) | NO | NO | **substrate** |
| INV-6 (sharpened) | Runtime makes no assumption about which workload is executing | YES (a runtime change could bake in a workflow concept) | NO | NO | **substrate** |
| DIM-1 Topology | Module boundaries, dependency direction | YES | NO | NO | **substrate** |
| DIM-2 Observability | Silent catches, missing log context | YES | NO | NO | **substrate** |
| DIM-3 Contracts | Schema-runtime drift, type-assertion safety | YES | NO | NO | **substrate** |
| DIM-4 Test-fidelity | Mock overuse, fixture drift | YES | NO | NO | **substrate** |
| DIM-5 Hygiene | Dead code, unused exports, legacy flags | YES | NO | NO | **substrate** |
| DIM-6 SOLID-coupling | Dependency direction, single-responsibility | YES | NO | NO | **substrate** |
| DIM-7 Resilience | Silent fallbacks, retry storms, degradation | YES | NO | NO | **substrate** |
| **DIM-8 Prose-quality** | **AI-writing tells in prose** | **NO** (code runs correctly; prose can still be terrible) | **YES** | **YES** | **authoring** |
| basileus-boundary | Cross-product coordination via Ontology MCP Server | YES | NO | NO | **substrate** |
| INV-7 substrate-serialization | Two-tier serialization (in-process + WAL/PK) | YES | NO | NO | **substrate** |
| INV-8 idempotency-at-the-boundary | Unique idempotency keys; collapsed duplicates | YES | NO | NO | **substrate** |
| INV-9 HSM-as-state-machine | Per-workflow-type guarded transitions | YES | NO | NO | **substrate** |
| INV-10 liveness-event-protocol | `<surface>.executing_started` for long-running ops | YES | NO | NO | **substrate** |
| INV-11 posture-declared-capabilities | Agent declares posture; handshake-authoritative | YES | NO | NO | **substrate** |
| INV-12 next-actions-as-affordance | Agents read affordances; runtime makes valid transitions perceptible | YES | NO | NO | **substrate** |
| INV-13 process-manager-two-event-split | `*.requested`/`*.executed` with idempotent precheck | YES | NO | NO | **substrate** |
| INV-14 native-primitive-first-recovery | Tool's native recovery first; substrate-level undo second; never destructive | YES | NO | NO | **substrate** |
| INV-15 single-machine-frame | No distributed consensus / leader election / vector clocks | YES | NO | NO | **substrate** |

**Outcome:** 26 substrate, 1 authoring. **DIM-8 is the sole authoring entry**, exactly as the charter predicted.

## 4. Edge cases

Two entries deserve closer examination — INV-4 and INV-5a — because both *enforce* via text-reading vocabulary lints, even though their invariant statements are about runtime portability.

### 4.1 INV-4 platform-agnosticity

The invariant is: "skill rendering must work across 6 runtimes." The enforcement mechanism includes a vocabulary-lint scan for `Skill({...})` literals in `skills-src/` outside `<!-- requires:claude -->` guards.

**Q1: Can code violate INV-4 while running correctly?**
Yes — a `skills-src/<name>/SKILL.md` could hardcode `Skill({...})` outside a `<!-- requires:claude -->` guard. The Claude Code runtime would render it correctly; OpenCode would render a broken skill. The *runtime* (the skills renderer) accepted the input; the *artifact* is the failure mode.

So INV-4 is borderline: the failure surfaces in an *artifact* (the rendered skill for a non-Claude runtime), but the invariant is about *runtime portability* — that the rendering substrate produces working output across runtimes.

**Tiebreaker (Q3):** Vocabulary lint reads text. So enforcement does involve reading natural-language text.

**Resolution:** **substrate**. The reasoning: the invariant's *subject* is the runtime's portability guarantee; the *enforcement mechanism* happens to read text because the runtime's input is text. Distinguishing-marker: ask *what would change if the runtime were redesigned*. If the invariant would still hold post-redesign, it's substrate; if it's only true given the current text-driven authoring substrate, it's authoring.

INV-4 would still hold under a Theoretical-Exarchos that compiles skills from a typed DSL — the *substrate* would still need to produce runtime-portable output. The invariant survives the runtime redesign. **Substrate.**

### 4.2 INV-5a input-ergonomics

Same shape: the invariant is "tool inputs are schema-constrained + descriptions include 'do NOT use for' guidance." Vocabulary lint reads tool descriptions for the absence of negative guidance.

**Resolution:** **substrate**, by the same reasoning. The invariant is about *agent ergonomics over MCP* (a runtime-substrate concern); the enforcement reads text because tool descriptions are text. Under a typed-IDL alternative, the invariant would still hold — the "do NOT use for" guidance would just live in a structured field.

### 4.3 What pure-authoring would look like

DIM-8 is the only entry whose subject is *prose content* — AI-writing tells, em-dash overuse, padded adjectives. These are properties only definable over natural-language text; they have no substrate analog.

A hypothetical second authoring entry might be:

- **"Skill bodies must lead with the trigger condition"** — a structural constraint on prose ordering. No substrate effect; pure artifact-quality concern.
- **"Reference files must not have YAML frontmatter"** — already a Exarchos convention; structural, but borderline (the build pipeline rejects frontmatter in references, so it has a substrate enforcement). Probably substrate.

For v2, DIM-8 is the only authoring entry. The schema admits the axis but isn't expected to grow it.

## 5. Schema impact

Add to v2 catalog frontmatter:

```yaml
invariants:
  - id: INV-N
    axis: substrate    # required; one of "substrate" | "authoring"
    ...
```

Loader behavior:

- `/ideate` Phase 0 default scope (`scope: "core"`) loads only `axis: substrate` AND `cost-of-load: always-load` entries.
- Authoring entries are never loaded by `/ideate`. They are surfaced by `/axiom:humanize` and review skills via dedicated calls.
- Vocabulary-lint cross-references work on the full set regardless of axis (the catalog remains the source-of-truth for the ID vocabulary).

## 6. Tiebreaker rule (for future authors)

When adding a new candidate to the catalog, apply the decision procedure (§2). If the verdict is ambiguous after Q1–Q3, default to **substrate** unless the entry is *exclusively* about artifact content. The reasoning: substrate is the catalog's primary purpose; authoring is the exception (1 of 27 entries in v2). New authoring entries should be rare and justified.

If the candidate seems to span both axes, split it into two entries (one per axis). This is the same pattern v2 applies when splitting INV-1 into INV-1 + INV-7 + INV-8.

## 7. Consumer responsibilities

For the substrate/authoring split to land in practice, each catalog consumer must honor the axis:

| Consumer | Current behavior | v2 behavior |
|---|---|---|
| `/ideate` Phase 0 loader | Loads all entries by `cost-of-load` | Filters to `axis: substrate` first, then by `cost-of-load`. Implementation: `loadInvariants({scope: 'core'})` returns `axis: substrate AND cost-of-load: always-load`. |
| `design-invariants` skill | Walks all entries by ID | Continues to walk all entries by ID; the axis is informational for the skill body. |
| `vocabulary-lint` | Scans all IDs | No change; vocabulary is axis-independent. |
| `/axiom:humanize` | Owns prose-quality independently of catalog | Continues independently; v2 lets the catalog *point to* `/axiom:humanize` as the authoring-axis enforcement surface. |
| `/axiom:design` pairing-discovery | Looks for `pairs-with: axiom:design` | No change re axis; but every `axis: substrate` entry should declare `axiom_overlap: DIM-N` where applicable (per task E in charter). |

## 8. Verification

To confirm the partition is sharp, two sanity checks pass:

1. **No substrate entry can be enforced solely by `/axiom:humanize`.** Verified — `humanize` reads prose for AI-writing tells; substrate invariants need parity tests, schema checks, or projection rebuild.
2. **DIM-8 cannot be enforced by a substrate mechanism.** Verified — em-dash overuse is not detectable by schema validation, projection rebuild, or parity test. It requires reading text and judging quality.

These sanity checks should be added to the catalog v2 introductory prose as a "test your partition" recipe for future authors.

## 9. References

- D2 candidate list with provisional IDs: [`docs/research/2026-05-20-runtime-invariants-gap-analysis.md`](2026-05-20-runtime-invariants-gap-analysis.md) §10
- D3 workload-agnosticism stress test: [`docs/research/2026-05-20-workload-agnosticism-stress-test.md`](2026-05-20-workload-agnosticism-stress-test.md)
- axiom DIM-8 owner: `/axiom:humanize` skill
- INV-4 enforcement: `scripts/lint-inv*.mjs` (vocabulary lint)

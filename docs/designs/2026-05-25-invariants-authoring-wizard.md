# Invariants Authoring Wizard + dev-catalog migration to the registered-catalog pattern

- **Status:** design (ideate) — pending plan
- **Feature id:** `invariants-catalog-wizard`
- **Date:** 2026-05-25
- **Anchored invariants:** INV-1, INV-2, INV-4, INV-5a/b/c/d, INV-6 (see [Constraints](#constraints))
- **Builds on:** #1465 (v3 schema + loader + projection + conformance gate), #1467 (`SDLC-*` baseline), #1478/#1479 (init/doctor onboarding), #1482 (catalog content-complete)

## 1. Problem

After PR #1482 the invariant **destination** is fully built — the v3 schema (`invariant-schema.ts`), the layered loader (`resolveEffectiveCatalog`), the `check_invariant_conformance` gate, the `invariants_effective` view, the `exarchos doctor` `invariants-catalog` check, and a commented `invariants:` stanza seeded into `.exarchos.yml` by `init`. What is missing is the **on-ramp**: the only way a consumer turns "an architectural rule in my head" into a registered, enforced `U-*` catalog entry today is to hand-write v3 YAML from `docs/guides/authoring-invariants.md`. There is no guided construction path.

A second, structural problem surfaces once we build that on-ramp. `resolveEffectiveCatalog` hand-codes three layers, and the **dev catalog is special-cased**: it loads from a *hardcoded path* (`docs/architecture/invariants.md`) behind a *bespoke `devCatalog: enabled` boolean gate*, whereas user catalogs flow through the *generic `invariants.catalogs` registration list* — even though both call the identical `loadInvariants` loader. Building a user-authoring wizard without unifying these means we ship two authoring patterns and two registration mechanisms for what is one concept. The dev catalog should become **just another registered catalog**, authored through the same wizard and loaded through the same path.

## Constraints

Anchored to `docs/architecture/invariants.md` (dev catalog `enabled` in this repo):

- **INV-5a** (input-ergonomics): inputs constrained at the schema level, not prose; every tool states when NOT to use it; visible tool count < 15; static reference content is a Resource, not a tool.
- **INV-5b** (output-contract): every ToolResult carries `next_actions`, `_meta`, `_perf`; errors carry `validTargets`, `expectedShape`, `suggestedFix`; carrier is `structuredContent` with a registered `outputSchema`.
- **INV-5c** (aspire-verbs): agents query state; mutating verbs default to `--dry-run`.
- **INV-5d** (action-discriminator): 4 visible composite tools, each with an action discriminator; new capabilities are *actions*, not new top-level tools.
- **INV-2** (facade-equivalence): CLI and MCP produce byte-identical payloads.
- **INV-4** (platform-agnosticity): the enforcement DSL is `.strict()` and declarative-only — no executable escape hatch.
- **INV-1** (event-sourcing-integrity): session/authoring state is a fold over events; mutations are events.
- **INV-6** (workflow-agnosticism): the surface and its output are workload-neutral.

## 2. Scope

| In scope | Out of scope |
|---|---|
| Agent-led `authoring-invariants` skill (the "wizard") | A human-first interactive TUI prompt loop |
| `exarchos invariants scaffold` / `add` orchestrate actions (CLI + MCP) | A new top-level composite tool (would violate INV-5d) |
| Tier-aware authoring (`user` **and** `dev`) | Consumer authoring of `SDLC-*` content (maintainer + inline only) |
| Migrating the dev catalog onto the registered-catalog pattern | Re-homing the `SDLC-*` inline catalog (must stay compiled-in for packaging) |
| `audit`-mode authoring by default; `check`-mode as opt-in | A combinator-tree visual builder |
| Wiring `.exarchos.yml` + validating via `doctor` | A consumer-facing SDLC catalog redesign |

## 3. Approach: agent-led skill over deterministic verbs

The "wizard" is **not** a stdin question loop. It is an LLM-driven authoring conversation (a skill) whose every *mutation* is committed through a deterministic, schema-validated CLI/MCP verb. The agent supplies judgment and natural-language elicitation; the verb supplies schema enforcement, file-write, `.exarchos.yml` wiring, and event emission. This is the only shape consistent with the agent-first philosophy (INV-5a/5c) and the retirement of the old `axiom:scaffold-invariants` SKILL-emitting model.

The division of labor also resolves the agnosticism constraint (INV-6): the agent never asks "what framework do you use?" and never emits framework-specific output. It helps the author express a rule either as a `mode: audit` prompt (pure judgment — always portable) or as a `mode: check` combinator tree over **grep/structural/heuristic leaves against globs the author names** — a vocabulary that is platform-agnostic precisely because it is declarative and sandbox-free.

### 3.1 The verbs (orchestrate actions; CLI facade)

Authoring is mutating, so the actions live under `exarchos_orchestrate` (where `init`/`doctor` live), **not** a fifth visible tool (INV-5d). The read surface stays `exarchos_view → invariants_effective`.

| Action (MCP) | CLI facade | Contract |
|---|---|---|
| `invariants_scaffold` | `exarchos invariants scaffold` | Create a starter catalog file for a tier; idempotently register it in `.exarchos.yml`. Never overwrites an existing file (mirrors `seedExarchosConfig`). |
| `invariants_add` | `exarchos invariants add` | Validate one entry against `InvariantEntryV3Schema` (incl. the `.strict()` enforcement DSL), then append it to a registered catalog. `--dry-run` default: returns the rendered entry + file diff without writing. |
| (validate) | `exarchos doctor` | Reuse the existing `invariants-catalog` check — no new validate verb; `doctor` already resolves and reports malformed files / reserved-namespace ids. |
| `invariants_effective` (existing) | `exarchos view invariants_effective` | Post-write confirmation: the merged, projected catalog the gate will enforce. |

Each action returns the INV-5b carrier shape: success carries `next_actions` (`["doctor", "view invariants_effective"]`), errors carry `validTargets`/`expectedShape`/`suggestedFix` sourced from the Zod error. Flags auto-emit from each action's Zod schema via `addFlagsFromSchema` (the CLI is schema-driven — do not hand-add flags).

### 3.2 The interview (the skill's behavior)

A new `skills-src/authoring-invariants/SKILL.md`, entered via a thin `/exarchos:invariants` command. The skill walks:

1. **Elicit** the rule in prose → `summary`.
2. **Locate** it: `dimension` (free text), `applies-to` globs, `phase-affinity`, `workflow-affinity` (absent ⇒ all).
3. **Weight** it: `severity.default` + optional `by-workflow` downgrades; `integrity-class` (`user` for consumers).
4. **Enforce** it: default `mode: audit` — the agent drafts the `audit-prompt` from the elicited rule. On opt-in, the agent proposes a `mode: check` combinator tree and validates it live via `invariants_add --dry-run` (the verb is the validator; the agent never declares an entry valid on its own authority).
5. **Number** it: auto-assign the next free id in the target catalog's namespace (`U-N` for user, `INV-N` for dev).
6. **Commit**: `invariants_add --dry-run` → show the rendered entry + diff → confirm → write; register the catalog in `.exarchos.yml` if not already; run `doctor`; surface the `invariants_effective` delta.

## 4. Migration: the dev catalog becomes a registered catalog

This is the structural half of the feature and the reason the wizard is worth building well — it forces dev/user convergence onto one pattern.

### 4.1 Today's asymmetry

`resolveEffectiveCatalog` has three hand-coded layers:

- **Layer 1 — dev:** hardcoded `docs/architecture/invariants.md`, gated by `config.invariants.devCatalog === 'enabled'`, loaded via `loadInvariants`.
- **Layer 2 — sdlc:** `loadSdlcCatalog()` — compiled-in constant (must stay inline; `docs/` is not in the npm `files` list).
- **Layer 3 — user:** iterate `config.invariants.catalogs` paths, each loaded via `loadInvariants`.

Layers 1 and 3 use the **same loader** but differ only in *discovery* (hardcoded path + boolean flag vs. registration list). That is the duplication to remove.

### 4.2 Target: a `CatalogSource` with a `tier`

Introduce a single registered-file-source abstraction. A catalog registration carries a `tier`:

```yaml
# .exarchos.yml (Exarchos's own repo, post-migration)
invariants:
  catalogs:
    - { path: docs/architecture/invariants.md, tier: dev }   # was: devCatalog: enabled
    - { path: .exarchos/invariants.yml }                      # tier defaults to user
```

`resolveEffectiveCatalog` collapses Layer 1 + Layer 3 into a single loop over registered file sources, tagging each entry by its source `tier`. Layer 2 (sdlc inline) stays separate by necessity. The wizard's `invariants_add` becomes tier-aware for free: it appends to whichever registered catalog the author targets, dev or user, through one code path.

### 4.3 Reserved-namespace + back-compat

- `INV-*` and `SDLC-*` stay **globally reserved**; the merge rejects them in any source whose `tier` is not the privileged built-in (`dev`/`sdlc`). `mergeCatalogs`' existing `RESERVED_USER_ID_PREFIXES` check becomes keyed off the source `tier` rather than off "is this the user layer."
- **Back-compat (recommended):** keep `invariants.devCatalog: enabled` as **sugar** that desugars to registering `docs/architecture/invariants.md` with `tier: dev`. Existing `.exarchos.yml` files (including this repo's) keep working unchanged; internally there is one path. (Alternative: a hard replacement of the flag with explicit registration — cleaner config, but a breaking change to every contributor's `.exarchos.yml` and to the loader's public `loadInvariants(config)` contract. Recommend the desugaring.)
- A consumer *may* register a `tier: dev` catalog in their own repo; it only governs their own design loop (invariants gate the author's own workflow — no privilege escalation). `doctor` emits an advisory if a non-built-in source claims a reserved namespace.

### 4.4 Why this satisfies "use the same infrastructure"

After migration there is exactly one authoring tool (`invariants_add` + the skill), one validator (`doctor`), one loader (`loadInvariants`), and one merge (`mergeCatalogs`) for every file-source catalog — dev and user alike. The dev catalog stops being a hardcoded special case and becomes the maintainers' own first use of the consumer-facing authoring path. We dogfood the wizard.

## 5. Invariant compliance

- **INV-5d:** no new visible tool — `invariants_scaffold`/`invariants_add` are `exarchos_orchestrate` actions; the count stays at 4.
- **INV-2:** the CLI verbs are thin facades over the orchestrate actions; the `invariants_effective` payload is byte-identical across CLI `--json` and MCP (existing parity test extended).
- **INV-4:** `invariants_add` validates through `InvariantEntryV3Schema`; the `.strict()` enforcement DSL rejects any embedded `script`/`exec`/`code` and any unknown leaf `kind` at write time, so the wizard cannot emit an executable escape hatch even if the agent is coaxed to.
- **INV-1:** authoring emits events (`invariant.authored` / `catalog.registered`) appended to the store; no in-place state. The `--dry-run`-then-confirm flow is a read followed by a single append.
- **INV-5b/INV-12:** every action returns the carrier shape and publishes `next_actions` (`doctor`, `view invariants_effective`) so the agent's path forward is perceivable, not polled.
- **INV-6:** the skill and verbs are workload-neutral; output is grep/audit over author-named globs, never framework-specific.
- **INV-5c:** mutating verbs default to `--dry-run`; `invariants_effective` is the observation verb.

## 6. Phasing

1. **P1 — registered-catalog refactor (migration first):** introduce `CatalogSource`/`tier`, collapse Layers 1+3 in `resolveEffectiveCatalog`, key the reserved-namespace check off `tier`, add the `devCatalog → tier:dev` desugaring. Pure refactor — existing gate/view/parity tests must stay green. **Ships before the wizard** so the wizard has one path to target.
2. **P2 — authoring verbs:** `invariants_scaffold` + `invariants_add` orchestrate actions with Zod schemas, `--dry-run` default, `.exarchos.yml` wiring (idempotent, `seedExarchosConfig`-style), event emission, facade parity.
3. **P3 — the skill + command:** `skills-src/authoring-invariants/SKILL.md` + `/exarchos:invariants` command driving the verbs; rendered to all runtimes via `build:skills`.
4. **P4 — dogfood + docs:** migrate this repo's `.exarchos.yml` to the desugared form (or leave the sugar), update `docs/guides/authoring-invariants.md` to lead with the wizard, regenerate skills, add the `check`-mode opt-in path if not already in P2.
5. **P5 — relocate the dev catalog to `.exarchos/` (folded into #1487 per user request).** The migration above converged the *loading* path but left the dev catalog at `docs/architecture/invariants.md`, registered via the `devCatalog` desugaring rather than a literal `catalogs:` entry. P5 finishes the convergence: `git mv` the catalog to `.exarchos/invariants.md`, point `DEV_CATALOG_PATH` + `vocabulary-lint` + the `/ideate` Phase-0 prose (`commands/ideate.md`, `skills-src/brainstorming/SKILL.md`) at the new location, and register it explicitly in this repo's `.exarchos.yml` as `catalogs: [{ path: .exarchos/invariants.md, tier: dev }]` — exactly how a user catalog is stored and registered. **`devCatalog: enabled` is retained** (not retired): `vocabulary-lint` and the direct `loadInvariants` Phase-0 gate still key off it; P1's path-dedupe collapses the desugared + explicit dev source into one. The supplementary `docs/architecture/invariants/references/INV-*.md` prose files stay put (entry `references:` arrays are repo-root-relative and still resolve). **Full retirement of the `devCatalog` boolean** — refactoring `loadInvariants`/Phase-0/`vocabulary-lint` to be registration-aware instead of flag-gated — remains a tracked follow-up (see `[[project_dev_catalog_relocate_exarchos_dir]]`).

## 7. Risks / open questions

- **`loadInvariants` public contract:** its `(filePath, opts, config)` signature and the `devCatalog` gate are referenced widely (loader, gate, view, parity tests). The desugaring keeps the signature; verify no caller depends on the *absence* of a registration list.
- **`--dry-run` default UX in an agent loop:** the agent must always make the confirm step explicit so it doesn't silently re-invoke with `--dry-run=false`. The skill spells out the gate.
- **`tier:dev` for consumers:** confirm we are content to *allow* it (governs only the author's own repo) rather than forbid it; `doctor` advisory is the chosen mitigation.
- **`check`-mode authoring depth in v1:** P2 ships `add` validating both modes; whether the *skill* guides full combinator authoring in P3 or defers it is a sizing call for planning.

## 8. References

- `servers/exarchos-mcp/src/architecture/resolve-effective-catalog.ts` — the three-layer resolver to refactor.
- `servers/exarchos-mcp/src/architecture/catalog-merge.ts` — `mergeCatalogs`, `RESERVED_USER_ID_PREFIXES`.
- `servers/exarchos-mcp/src/architecture/sdlc-catalog.ts` — why sdlc stays inline.
- `servers/exarchos-mcp/src/architecture/invariant-schema.ts` — `InvariantEntryV3Schema`, the `.strict()` enforcement DSL.
- `servers/exarchos-mcp/src/orchestrate/init/seed-exarchos-config.ts` — idempotent `.exarchos.yml` write pattern to mirror.
- `docs/guides/authoring-invariants.md` — the prose on-ramp the wizard replaces as the primary path.
- `docs/proposals/2026-05-20-invariants-catalog-v2-spec.md` §1.1, §4.0, §10 — audience-scope rationale.

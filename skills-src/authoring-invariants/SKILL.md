---
name: authoring-invariants
description: "Guided authoring of an architectural invariant catalog entry through a 6-step interview (elicit, locate, weight, enforce, number, commit). Drives the invariants_scaffold and invariants_add orchestrate verbs — the agent supplies judgment and natural-language elicitation; the verbs own schema validation, file writing, and event emission. Defaults to mode: audit; mode: check is an advanced opt-in. Triggers: 'add an invariant', 'author an invariant', 'enforce an architectural rule', or {{COMMAND_PREFIX}}invariants. Do NOT use for: editing workflow state, running a review, or hand-writing YAML (the verbs write it — never emit catalog YAML yourself)."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: authoring
---

# Authoring Invariants Skill

## Overview

This skill turns an architectural rule in the author's head into a **registered,
enforced catalog entry**. It is the on-ramp described in
`docs/designs/2026-05-25-invariants-authoring-wizard.md` — an LLM-driven
authoring conversation, **not** a stdin question loop.

The division of labor is strict and load-bearing:

- **The agent (you) supplies judgment + natural-language elicitation.** You
  interview the author, draft prose, propose globs, and shape the entry.
- **The verbs own validation + writing.** Every *mutation* goes through a
  deterministic, schema-validated orchestrate action — `invariants_scaffold`
  and `invariants_add`. **You never hand-write or append catalog YAML
  yourself.** The verb renders it; you confirm it.

This shape is the only one consistent with the agent-first philosophy: inputs
are constrained at the schema level (INV-5a), mutating verbs default to
dry-run (INV-5c), and authoring is event-sourced (INV-1).

## When to Use

- The author wants a new architectural rule enforced on their own SDLC path
  (surfaced at ideate, turned into acceptance criteria at planning, audited at
  review by the `check_invariant_conformance` gate).
- An author says "add an invariant", "enforce that X", "make this a rule".

## When NOT to Use

- The author wants to *hand-write* YAML — point them at the verbs instead; the
  skill exists so they don't have to.
- The rule is a one-off lint, not an architectural invariant → a project linter
  is the right home.
- You are mid-workflow editing state, running a review, or planning — those are
  other skills. This skill only authors catalog entries.

## The verbs (what you drive — never bypass)

| Action (MCP) | CLI facade | What it does |
|---|---|---|
| `invariants_scaffold` | `exarchos invariants scaffold` | Create a starter catalog file for a tier; idempotently register it in `.exarchos.yml`. Never overwrites an existing file. |
| `invariants_add` | `exarchos invariants add` | Validate ONE entry against the v3 schema (including the `.strict()` enforcement DSL — INV-4), then append it. **`dryRun` defaults to true**: returns the rendered entry + file diff, writes nothing. |
| `doctor` | `exarchos doctor` | Reuse the existing `invariants-catalog` check — the validator. No new validate verb. |
| `invariants_effective` | `exarchos view invariants_effective` | The merged, projected catalog the gate will enforce. Post-write confirmation. |

The agent **never** declares an entry valid on its own authority — the verb is
the validator. `invariants_add` returns the INV-5b carrier shape: success
carries `next_actions` (`["doctor", "view invariants_effective"]`); validation
errors carry `validTargets` / `expectedShape` / `suggestedFix` sourced from the
Zod error, so you can self-correct and re-run rather than re-guess.

## The interview (6 steps)

Walk the author through these in order. Elicit in prose, never make them think
in YAML field names.

### 1. Elicit — the rule → `summary`

Ask the author to state the rule in one sentence. Distill it into a precise
`summary`. Probe for the *failure* it prevents ("what goes wrong if this is
violated?") — that sharpens both the summary and the later enforcement.

### 2. Locate — `dimension`, `applies-to`, affinities

- `dimension`: a free-text grouping (e.g. `audit-completeness`, `error-handling`).
- `applies-to`: the glob(s) the rule governs — ask the author to name the paths
  (`src/handlers/**`, `**/*.ts`). These are **author-named globs**, never
  framework-inferred (INV-6: the surface is workload-neutral).
- `phase-affinity`: phases where it bites (`ideate | plan | delegate | review |
  synthesize`). Absent ⇒ all phases.
- `workflow-affinity`: workflow types (`feature | debug | refactor | discover |
  oneshot`). Absent ⇒ all.

### 3. Weight — `severity` + `integrity-class`

- `severity.default`: `blocking` or `advisory`.
- `severity.by-workflow` (optional): downgrade for cheap workflows
  (e.g. `oneshot: advisory`).
- `integrity-class`: `user` for a consumer-authored entry (the default target).
  `dev` only when the author is a maintainer extending Exarchos's own substrate
  catalog.

### 4. Enforce — DEFAULT `mode: audit`, `mode: check` is opt-in

**Default to `mode: audit`.** You draft the `audit-prompt` from the elicited
rule — a question the review subagent answers against the diff. Audit mode is
pure judgment and always portable:

```yaml
enforcement:
  mode: audit
  audit-prompt: >-
    Does this diff let a request handler return before emitting an audit event?
    Cite the offending file + line.
```

Offer `mode: check` only as an **advanced opt-in** when the rule is mechanically
checkable. If the author opts in, propose a declarative combinator tree over
grep/structural/heuristic leaves and **validate it live via `invariants_add`
with `dryRun: true`** before showing it. See `@references/check-mode.md` for the
combinator vocabulary and the opt-in flow. The enforcement DSL is `.strict()`
and declarative-only: there is no `script` / `exec` / `code` escape hatch
(INV-4), so you cannot emit an executable check even if asked.

### 5. Number — auto-id in the target namespace

Do **not** pick an id. `invariants_add` auto-assigns the next free id in the
target catalog's namespace (`U-N` for user, `INV-N` for dev). Mention the id the
verb assigned when you show the dry-run.

### 6. Commit — dry-run → confirm → write → verify

This step is a **gate, not a formality.** Always:

1. Call `invariants_add` with `dryRun: true` (the default). This renders the
   entry + diff and writes nothing.
2. Show the author the rendered entry and the file diff verbatim. Make the
   confirmation explicit: ask "commit this entry?" — do not silently re-invoke.
3. Only on explicit confirmation, re-invoke `invariants_add` with
   `dryRun: false`. This appends the entry, wires `.exarchos.yml` if the catalog
   is unregistered, and emits `invariant.authored` (+ `catalog.registered` on
   first registration — INV-1).
4. Run `doctor` (the `invariants-catalog` check) to validate the resolved catalog.
5. Show the `invariants_effective` delta so the author sees exactly what the
   gate will now enforce.

If `invariants_add` returns a `CATALOG_NOT_FOUND` error, the target catalog does
not exist yet — run `invariants_scaffold` first (the error's `suggestedFix`
names the call), then resume at step 6.

## Tool invocations

Scaffold a user catalog (idempotent; never overwrites):

```
{{MCP_PREFIX}}exarchos_orchestrate({
  action: "invariants_scaffold",
  tier: "user",
  path: "docs/architecture/my-invariants.md"
})
```

Dry-run preview (DEFAULT — writes nothing):

```
{{MCP_PREFIX}}exarchos_orchestrate({
  action: "invariants_add",
  tier: "user",
  catalog: "docs/architecture/my-invariants.md",
  entry: { /* the fields from steps 1-4; NO id — auto-assigned */ }
})
```

Commit after explicit confirmation:

```
{{MCP_PREFIX}}exarchos_orchestrate({
  action: "invariants_add",
  tier: "user",
  catalog: "docs/architecture/my-invariants.md",
  entry: { /* same entry */ },
  dryRun: false
})
```

Use `{{MCP_PREFIX}}exarchos_orchestrate({ action: "describe" })` (or the CLI
`--help`) to discover the exact schema at runtime — flags auto-emit from each
action's Zod schema (the CLI is schema-driven; do not assume hand-added flags).

## Worked example

For one `U-*` entry authored end-to-end through all 6 steps, see
`@references/worked-example.md`.

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Hand-write or `Edit` catalog YAML | Always route mutations through `invariants_add` |
| Declare an entry valid yourself | The verb validates; you confirm |
| Default to `mode: check` | Default to `mode: audit`; `check` is opt-in (`@references/check-mode.md`) |
| Skip the dry-run | `dryRun: true` first, ALWAYS, then explicit confirm |
| Silently re-invoke with `dryRun: false` | Make the confirmation step explicit |
| Pick an id by hand | The verb auto-assigns the next free id in the namespace |
| Infer globs from the framework | Ask the author to name the globs (INV-6) |
| Skip `doctor` + `invariants_effective` after commit | Verify the resolved catalog and show the delta |

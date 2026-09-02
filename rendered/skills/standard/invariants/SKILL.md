---
name: invariants
description: "Guided authoring of an architectural invariant catalog entry through a 6-step interview (elicit, locate, weight, enforce, number, commit). Drives the invariants_scaffold, invariants_add and invariants_amend orchestrate verbs — the agent supplies judgment and natural-language elicitation; the verbs own schema validation, file writing, and event emission. Correcting an existing entry is invariants_amend (id-targeted, field-scoped), never a re-run of invariants_add. Defaults to mode: audit; mode: check is an advanced opt-in. Triggers: 'add an invariant', 'author an invariant', 'enforce an architectural rule', 'fix/correct/amend an invariant', or invariants. Do NOT use for: editing workflow state, running a review, or hand-writing YAML (the verbs write it — never emit catalog YAML yourself)."
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
`docs/designs/archive/2026-05-25-invariants-authoring-wizard.md` — an LLM-driven
authoring conversation, **not** a stdin question loop.

The division of labor is strict and load-bearing:

- **The agent (you) supplies judgment + natural-language elicitation.** You
  interview the author, draft prose, propose globs, and shape the entry.
- **The verbs own validation + writing.** Every *mutation* goes through a
  deterministic, schema-validated orchestrate action — `invariants_scaffold`,
  `invariants_add`, and `invariants_amend`. **You never hand-write, append, or
  edit catalog YAML yourself.** The verb renders it; you confirm it.

This shape is the only one consistent with the agent-first philosophy: inputs
are constrained at the schema level (INV-5a), mutating verbs default to
dry-run (INV-5c), and authoring is event-sourced (INV-1).

## When to Use

- The author wants a new architectural rule enforced on their own SDLC path
  (surfaced at ideate, turned into acceptance criteria at planning, audited at
  review by the `check_invariant_conformance` gate).
- An author says "add an invariant", "enforce that X", "make this a rule".
- An author wants to **correct** an already-committed entry — a wrong summary, a
  stale glob, a weak `audit-prompt`. That is `invariants_amend`, and it is the
  only sanctioned way to change a shipped entry (see step 7).

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
| `invariants_add` | `exarchos invariants add` | Validate ONE **new** entry against the v3 schema (including the `.strict()` enforcement DSL — INV-4), then append it. **`dryRun` defaults to true**: returns the rendered entry + file diff, writes nothing. Append-only: a colliding `id` is rejected. |
| `invariants_amend` | `exarchos invariants amend` | Correct ONE **existing** entry in place. `id` names the target (identity is not patchable); `patch` names the top-level fields to replace, and anything it omits survives verbatim. The merged entry is re-validated in full. **`dryRun` defaults to true**: returns the amended entry + a before/after diff, writes nothing. |
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
- `workflow-affinity`: workflow types (`feature | debug | refactor | discovery |
  oneshot`). Absent ⇒ all.

### 3. Weight — `severity`, `integrity-class`, and the `tier` you author into

- `severity.default`: `blocking` or `advisory`.
- `severity.by-workflow` (optional): downgrade for cheap workflows
  (e.g. `oneshot: advisory`).
- `integrity-class` (entry field; enum `substrate | sdlc | authoring | user`):
  the entry's **override authority**, not its namespace. For a consumer-authored
  rule this is `user`. (`substrate`/`sdlc` are exarchos's own classes — you do
  not author those.)
- **`tier` (the verb arg) picks the catalog _namespace_, and the choice is
  *exarchos-substrate vs project-authored*, NOT "which developers".** This is the
  one that bites — get it wrong and you silently collide with exarchos's own ids:
  - **`tier: user` → `U-N` ids — your project's own invariants. The default for
    _everyone_ consuming exarchos.** If you are authoring a rule for your own
    repo, this is always the answer (even if your project happens to name its
    rules `INV-N` internally — they map to `U-N` here).
  - **`tier: dev` → `INV-N` ids — exarchos's _own_ reserved substrate catalog.**
    Exarchos ships its own `INV-1..6` inside the tool, and they merge into every
    `invariants_effective` projection. Authoring into `dev` from a consumer repo
    **collides your `INV-N` with exarchos's own** — a silent namespace clash the
    `doctor` check can't catch (it only flags `INV-*` in a *user* catalog). Use
    `dev` **only when working inside the exarchos repo itself**. The verbs
    enforce this: `invariants_scaffold` / `invariants_add` reject `tier: dev`
    outside the exarchos repo (heuristic: `package.json` name ≠
    `@lvlup-sw/exarchos`) with a `RESERVED_TIER` error that redirects to `user`;
    a genuine exarchos fork opts in with `allowReservedTier: true`.

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

### 7. Amend — correcting an entry that is already committed

Steps 1–6 author a NEW entry. Correcting one that already exists is a different
verb, and `invariants_add` is not it: it only ever **appends**, and re-running it
with an existing `id` is rejected (`DUPLICATE_INVARIANT_ID`) precisely because
committing that duplicate would author a catalog the loader then refuses to read.

Use `invariants_amend`. It is **id-targeted and field-scoped**:

- `id` names the entry to correct. It is **not** patchable — an entry's identity
  survives an amendment, because every `references:` pointer and audit record
  naming the old id would otherwise go stale. Renaming is not an amendment.
- `patch` names only the top-level fields that change. **Every field the patch
  omits is carried through verbatim** — you do not restate the whole entry, and
  an amendment cannot silently drop a `references` list or an affinity the
  author never mentioned. A named field is replaced *wholesale* (patching
  `enforcement` swaps the entire enforcement block).
- The merged entry is re-validated against the full v3 schema, so an amendment
  can never produce an entry that would have been rejected at authoring time —
  including the `.strict()` enforcement DSL (INV-4).

The gate is the same as step 6: `dryRun: true` first (the default) → show the
author the before/after diff verbatim → explicit confirmation → re-invoke with
`dryRun: false`, which emits `invariant.amended` naming the changed fields →
`doctor` → show the `invariants_effective` delta.

Two refusals worth recognizing:

- `ENTRY_NOT_FOUND` — no entry carries that id. The error's `validTargets` lists
  the ids actually resolved, so pick from those or author a new entry instead.
- `CATALOG_EMPTY` / `CATALOG_UNREADABLE` — the catalog resolved zero entries, or
  its `invariants:` list could not be read at all. Neither is reported as a
  clean "not found": a moved or renamed catalog must not look like a catalog
  that simply lacks your entry. Check you named the right catalog.

## Tool invocations

Scaffold a user catalog (idempotent; never overwrites):

```ts
exarchos:exarchos_orchestrate({
  action: "invariants_scaffold",
  tier: "user",
  path: ".exarchos/invariants.md"
})
```

Dry-run preview (DEFAULT — writes nothing):

```ts
exarchos:exarchos_orchestrate({
  action: "invariants_add",
  tier: "user",
  catalog: ".exarchos/invariants.md",
  entry: { /* the fields from steps 1-4; NO id — auto-assigned */ }
})
```

Commit after explicit confirmation:

```ts
exarchos:exarchos_orchestrate({
  action: "invariants_add",
  tier: "user",
  catalog: ".exarchos/invariants.md",
  entry: { /* same entry */ },
  dryRun: false
})
```

Amend an EXISTING entry — dry-run first (note: only the fields that change;
everything else is carried through):

```ts
exarchos:exarchos_orchestrate({
  action: "invariants_amend",
  tier: "user",
  catalog: ".exarchos/invariants.md",
  id: "U-3",
  patch: { summary: "The corrected one-sentence rule." }
})
```

Commit the amendment after explicit confirmation:

```ts
exarchos:exarchos_orchestrate({
  action: "invariants_amend",
  tier: "user",
  catalog: ".exarchos/invariants.md",
  id: "U-3",
  patch: { summary: "The corrected one-sentence rule." },
  dryRun: false
})
```

Use `exarchos:exarchos_orchestrate({ action: "describe" })` (or the CLI
`--help`) to discover the exact schema at runtime — flags auto-emit from each
action's Zod schema (the CLI is schema-driven; do not assume hand-added flags).

## Worked example

For one `U-*` entry authored end-to-end through all 6 steps, see
`@references/worked-example.md`.

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Hand-write or `Edit` catalog YAML | Route mutations through a verb: `invariants_add` to append a NEW entry, `invariants_amend` to correct an EXISTING one |
| Re-run `invariants_add` with an existing `id` to "update" an entry | `invariants_add` only appends — a colliding `id` is rejected. Use `invariants_amend` |
| Re-author a whole entry to change one field | `invariants_amend` is field-scoped: `patch` names only what changes, everything else survives |
| Rename an entry's `id` | `id` is the catalog's primary key and is not patchable — every reference to the old id would go stale |
| Declare an entry valid yourself | The verb validates; you confirm |
| Default to `mode: check` | Default to `mode: audit`; `check` is opt-in (`@references/check-mode.md`) |
| Skip the dry-run | `dryRun: true` first, ALWAYS, then explicit confirm |
| Silently re-invoke with `dryRun: false` | Make the confirmation step explicit |
| Pick an id by hand | The verb auto-assigns the next free id in the namespace |
| Author into `dev`/`INV-N` from a consumer repo | `dev` is exarchos's reserved substrate namespace — use `user`/`U-N` (the verb rejects consumer `tier: dev`) |
| Infer globs from the framework | Ask the author to name the globs (INV-6) |
| Skip `doctor` + `invariants_effective` after commit | Verify the resolved catalog and show the delta |

---
description: Author an architectural invariant catalog entry through a guided interview
---

# Invariants

Author an architectural invariant for: "$ARGUMENTS"

A guided, agent-led interview that turns an architectural rule into a
registered, enforced catalog entry. The agent supplies judgment and
natural-language elicitation; the `invariants_scaffold` and `invariants_add`
orchestrate verbs own schema validation, file writing, and event emission. The
agent never hand-writes catalog YAML.

## Skill Reference

Follow the authoring-invariants skill: `@skills/authoring-invariants/SKILL.md`

## What it does

Walks the 6-step interview:

1. **Elicit** the rule in prose → `summary`.
2. **Locate** it: `dimension`, `applies-to` globs, phase/workflow affinity.
3. **Weight** it: `severity` (+ optional per-workflow downgrades), `integrity-class`.
4. **Enforce** it: DEFAULT `mode: audit` (the agent drafts the `audit-prompt`);
   `mode: check` is an advanced declarative opt-in
   (`@skills/authoring-invariants/references/check-mode.md`).
5. **Number** it: the verb auto-assigns the next free id (`U-N` user, `INV-N` dev).
6. **Commit** it: `invariants_add` `dryRun: true` → show the rendered entry +
   diff → explicit confirmation → write → `doctor` → show the
   `invariants_effective` delta.

See `@skills/authoring-invariants/references/worked-example.md` for one entry
authored end-to-end.

## When to Use

- You want a new architectural rule enforced on your own SDLC path (surfaced at
  ideate, turned into acceptance criteria at planning, audited at review).
- You would otherwise hand-write v3 catalog YAML — this command exists so you
  do not have to.

## When NOT to Use

- You are editing workflow state, running a review, or planning — those are
  other commands.
- The rule is a one-off lint, not an architectural invariant.

## See also

- Authoring guide: `docs/guides/authoring-invariants.md`
- Design: `docs/designs/2026-05-25-invariants-authoring-wizard.md`
- `exarchos doctor` → `invariants-catalog` check (the validator)
- `invariants_effective` view (inspect the merged, projected catalog)

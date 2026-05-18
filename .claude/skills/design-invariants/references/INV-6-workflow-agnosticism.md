# INV-6: Workflow-Agnosticism (Skills Describe Behaviors, Playbooks Describe Workflows)

A skill prescribing a **behavior** must describe its triggers in workflow-neutral terms — e.g., "activated when `next_actions` surfaces verb `merge_branch` with idempotency key `<feature-id>:merge`" — not in terms of a specific workflow stage like `feature/merge-pending` or `delegate`. Workflow-typed triggers belong in **playbooks/commands**, not in skill prose. A skill that **is** intentionally workflow-specific declares `workflow-type:` in its frontmatter so audits can distinguish "intentionally scoped" from "leaky abstraction." The advisory lint `scripts/lint-inv6.mjs` formalizes the candidate-violation grep.

The invariant is the design discipline. The frontmatter declaration is the escape hatch — without it, every workflow-typed literal in a skill body is treated as a candidate violation.

## Rule

1. **Behavior-skills** (the default) describe activation triggers in terms of MCP outputs, idempotency keys, and verb names — not workflow stages or branch prefixes.
2. **Workflow-specific skills** declare `metadata.workflow-type: <type>` in frontmatter. Once declared, the skill is permitted to reference that workflow's stages and branch conventions in its body.
3. A skill body containing workflow-typed literals (`feature/`, `featureId`, `merge-pending`, `delegate`, `synthesize`, `review`, `gathering`) WITHOUT a `workflow-type:` declaration is a candidate INV-6 violation.
4. Skills under `_shared/` are exempt — by convention they are cross-workflow utilities and are expected to reference workflow vocabulary as part of their cross-cutting role.

## Examples

### Positive — workflow-neutral behavior skill

```markdown
---
name: handle-merge-result
description: "Surface when next_actions emits verb=merge_branch."
---

# Handle merge result

Activated when `next_actions` surfaces the verb `merge_branch` with an
idempotency key. Idempotency: re-running with the same key MUST be a no-op.
```

This skill never names a workflow type or branch convention. It can be reused by any workflow that emits `merge_branch`.

### Positive — explicitly workflow-typed skill

```markdown
---
name: feature-merge-playbook
description: "Drive the merge-pending stage of the feature workflow."
metadata:
  workflow-type: feature
---

# Feature merge playbook

When the `feature/<id>` branch reaches `merge-pending`, validate the rebase
state then dispatch `merge_branch`. This playbook owns the `merge-pending`
→ `merged` transition.
```

The `workflow-type: feature` declaration tells the audit that workflow-typed literals in the body are intentional, not leaks.

### Negative — leaky abstraction

```markdown
---
name: rebase-helper
description: "Rebase the working branch onto its base."
---

# Rebase helper

When you reach the `merge-pending` stage of a `feature/` workflow, run
`git rebase origin/feature/<integration>`...
```

This skill claims to be a generic rebase helper but its body is hard-coded to the feature workflow. Either rename it `feature-rebase-helper` and declare `workflow-type: feature`, or genericize the body to take the base branch as a parameter.

## Deterministic checks

```bash
# Workflow-typed literals in skill bodies under skills-src/ (excluding _shared/)
rg -n 'feature/|featureId|merge-pending|delegate|synthesize|review|gathering' \
   skills-src/ \
   --glob '!skills-src/_shared/**' \
   --glob '*.md'

# Cross-reference: which of the matching SKILL.md files declare workflow-type:?
for f in $(rg -l 'feature/|featureId|merge-pending|delegate|synthesize|review|gathering' \
              skills-src/ \
              --glob '!skills-src/_shared/**' \
              --glob 'SKILL.md'); do
  if ! head -20 "$f" | grep -q '^  workflow-type:'; then
    echo "CANDIDATE: $f references workflow literals without workflow-type declaration"
  fi
done
```

The advisory script `scripts/lint-inv6.mjs` formalizes this check and emits JSON findings of shape `{file, line, snippet, rule: 'workflow-type-literal-without-declaration', severity: 'LOW', message}`.

## Audit recipe

1. **Inventory.** List every `SKILL.md` body that contains workflow-typed literals.
2. **Declaration check.** For each, inspect frontmatter for `metadata.workflow-type: <type>`.
3. **Triage.**
   - Has `workflow-type:` → no finding; the literal is intentional.
   - No `workflow-type:` and skill is under `_shared/` → no finding; cross-cutting utility.
   - Otherwise → LOW finding. Choose remediation: (a) add `workflow-type:` if the skill really is workflow-specific, or (b) genericize the body — replace literals with parameterized triggers (verb + idempotency key) so the skill works across workflows.
4. **Re-render.** No re-render needed for this invariant — it operates on `skills-src/` source, and the build pipeline copies frontmatter through verbatim.

## Severity guide

- **HIGH:** A reusable utility skill (no `workflow-type:`) whose body is structurally tied to a single workflow's stages, such that lifting it to another workflow would require body rewrites.
- **MEDIUM:** A skill that uses workflow-typed verbs (`delegate`, `synthesize`, `review`) in prescriptive instructions without `workflow-type:`, but where the skill's intent is genuinely cross-workflow.
- **LOW:** Incidental workflow-typed literals in examples / illustrative prose (e.g., a `feature/` branch in a code block) that don't change the skill's portability. The lint flags these; reviewers usually dismiss them.

## See also

- Deterministic checks for INV-6 → [deterministic-checks.md](deterministic-checks.md#inv-6-workflow-agnosticism)
- [INV-4](INV-4-platform-agnosticity.md) — INV-4 keeps skills runtime-agnostic; INV-6 keeps them workflow-agnostic. They share the same authoring discipline: tokenize/parameterize the specific bits.
- `scripts/lint-inv6.mjs` — advisory lint that surfaces candidate INV-6 violations as JSON findings.

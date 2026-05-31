# Fix Design: Pin native subagent worktrees to the integration tip

**Issues:** #1509, #1501 (bundled) · **Milestone:** v2.10.1
**RCA:** [`docs/rca/2026-05-31-implementer-worktree-base.md`](../rca/2026-05-31-implementer-worktree-base.md)
**Workflow:** `debug-implementer-worktree-base` (thorough-track) · **Invariant:** INV-11

## Goal

Make native `isolation: worktree` subagents base on the orchestrator's
integration tip instead of `main`, with a fail-closed guard so a misconfigured
or unsupported host **halts loud** rather than silently dispatching onto a stale
base. Keep `isolation: worktree` on the agent definitions.

## Design

Two layers + prose/dogfood, no new public tool surface.

### Layer 1 — `worktree.baseRef: "head"` (primary lever)

The documented Claude Code setting that branches worktrees from local `HEAD`
(= integration tip at dispatch time) instead of `origin/HEAD`. Worktrees are
clean-tree, so only *committed* HEAD state propagates — composes with the
existing commit-before-dispatch discipline.

- **This repo (dogfood):** create committed `.claude/settings.json`:
  ```json
  { "worktree": { "baseRef": "head" } }
  ```
  `.claude/settings.json` is absent today; `settings.local.json` (personal) is
  the wrong home for a shared invariant. New file, single key.

### Layer 2 — detect-and-block in `prepare_delegation` (delivery to consumers)

Exarchos ships as a binary + plugin and does not own a consumer's
`.claude/settings.json`, so the setting cannot be applied transparently. Instead,
gate dispatch on it.

**Seam:** `servers/exarchos-mcp/src/orchestrate/prepare-delegation.ts`. The
handler already runs DR-1 ancestry + DR-2 worktree-location guards and **skips
the worktree check when `nativeIsolation: true`** (L522) — the exact branch with
no base verification. Add a new `baseRef` guard *in that branch*.

```
if (args.nativeIsolation) {
  const effective = resolveWorktreeBaseRef(process.cwd());   // new helper
  guardOutcomes.baseRef.passed = effective === 'head';
  if (effective !== 'head') {
    emit preflight.blocked { reason: 'worktree-baseref-unset', details: {...} }
    emit dispatch.preflight (aggregate)
    return { success: true, data: { blocked: true, reason: 'worktree-baseref-unset',
             effective, remediation: { file: '.claude/settings.json',
             patch: { worktree: { baseRef: 'head' } } } }, next_actions: [...] }
  }
}
```

- **Settings resolution helper** `resolveWorktreeBaseRef(cwd)`: read, in Claude
  Code precedence order, `.claude/settings.local.json` → `.claude/settings.json`
  → `~/.claude/settings.json`; return the first `worktree.baseRef` found, else
  `null`. Resolve consumer paths from `process.cwd()`, **never** `import.meta.url`
  (plugin-mode module-relative resolution silently fails — known footgun). Missing
  / malformed files are swallowed and treated as unset (**fail-closed → block**).
  Cannot see enterprise/CLI-arg overrides; that residual is covered by Layer 3.
- **`guardOutcomes`** gains `baseRef: { passed: boolean }`; folded into the
  `emitDispatchPreflight` aggregate and the `dispatch.preflight` event `guards`
  map. Runs after ancestry, before the `preflight.executed` summary;
  `checksRun` becomes `['ancestry', 'baseRef']` on the native path.
- **`nativeIsolation: false`** path is **unchanged** — that is the
  exarchos-managed worktree route (`setup-worktree.ts` sets `baseBranch`
  explicitly), which is not exposed to the bug.

### Layer 3 — version-independent ancestry assert (safety net)

A pure-git STEP 0 baked into the implementer dispatch template so any host that
ignores `baseRef` still fails closed:

```bash
git -C "$WORKTREE" merge-base --is-ancestor "$INTEGRATION_TIP" HEAD \
  && echo "BASE OK" \
  || { echo "BASE STALE — worktree is not based on the integration tip; halting"; exit 1; }
```

The orchestrator fills `[integration-tip]` from the workflow's integration
branch — which it already holds (workflow state / current HEAD). `merge-base
--is-ancestor` accepts a **branch ref**, not just a SHA, so no result-threading
from `prepare_delegation` is required; the assert works directly against the
integration branch name the orchestrator passes into the dispatch prompt.
(`prepare_delegation` does record the integration branch on its `preflight.executed`
audit event for observability.) Replaces the hand-pinned `git reset --hard <tip>`
operators run today (#1501).

### Layer 4 — prose + runbook

`skills-src/delegation/SKILL.md` §"When integration advances mid-wave": correct
the base contract (default = `origin/HEAD`; integration-tip base requires
`baseRef: "head"`), add the prerequisite + the STEP 0 assert. Regenerate
`skills/<runtime>/` and agents. Add operator runbook note (stop hand-pinning).

## Invariants validation (per design discipline)

| INV | Verdict |
|---|---|
| **INV-11** posture | ✅ Core fix — a `task-isolated` agent's base becomes bounded by construction (setting) + fail-closed guard, not operator convention. |
| **INV-4** platform-agnosticity | ⚠️→✅ `baseRef` is Claude-Code-specific. The Layer-2 guard is gated on `nativeIsolation` (the CC path) and lives in dispatch-core TS, not skill bodies. In `skills-src/delegation/SKILL.md` the `baseRef` instruction is wrapped in a `<!-- requires:claude -->` guard (or tokenized); the Layer-3 ancestry assert is **pure git → unconditional across all 6 runtimes**. Edit `skills-src/`, regenerate. |
| **INV-5b** output-contract | ✅ Blocked result keeps the `{ success:true, data:{ blocked:true, reason, … } }` shape used by sibling guards, plus `next_actions` remediation affordance. |
| **INV-12** next-actions | ✅ The block publishes the remediation as a perceivable affordance, not buried prose. |
| **INV-1** event-sourcing | ✅ Guard emits `preflight.blocked` / `dispatch.preflight`; reads consumer `settings.json` as *input*, derives no cross-call state from it. |
| **INV-2** facade-equivalence | ✅ Guard lives in the shared handler; CLI + MCP inherit it; no adapter behavior. |
| **INV-6** workload-agnosticism | ✅ No workflow-type branching; delegation mechanics only. |
| **INV-5c** aspire-verbs | ✅ `prepare_delegation` stays queryable + fail-loud; no silent mutation of consumer settings. |

## Task breakdown (TDD)

| # | Task | Tests-first |
|---|---|---|
| T1 | `resolveWorktreeBaseRef(cwd)` settings-resolution helper | precedence (local>project>user), unset→null, malformed→null, head/fresh values |
| T2 | `prepare_delegation` baseRef guard + `guardOutcomes`/event wiring + integration-tip SHA in result | block when unset/fresh; pass when head; `nativeIsolation:false` skips guard; event shape |
| T3 | `skills-src/delegation/SKILL.md` prose + STEP 0 + `requires:claude` guard; regenerate `skills/` + agents | `skills:guard` clean; INV-4 lint clean; delegation skill `.test.sh` green |
| T4 | Create `.claude/settings.json` `{worktree:{baseRef:head}}` (dogfood) | n/a (config) |
| T5 | Operator runbook note | n/a (docs) |

T1+T2 are the code core (co-located vitest). Given the change is small, cohesive,
and *itself repairs the delegation path*, implement inline in the main worktree
rather than delegating onto the very mechanism under repair.

## Out of scope

- Dropping `isolation: worktree` (#1509 opt 1) / self-heal rebase (#1509 opt 2) — unnecessary; lever exists.
- `WorktreeCreate` hook (heavy; disables `.worktreeinclude`) — Layer 1+2 suffice.
- #1119 mid-wave ancestry-advance handling — separate, pre-existing.

# RCA: Native `isolation: worktree` bases subagent worktrees on `main`, not the integration tip

**Issues:** [#1509](https://github.com/lvlup-sw/exarchos/issues/1509) (bug), [#1501](https://github.com/lvlup-sw/exarchos/issues/1501) (spike) — bundled.
**Milestone:** v2.10.1 · **Workflow:** `debug-implementer-worktree-base` (thorough-track)
**Invariant:** INV-11 (posture-declared-capabilities — a `task-isolated` agent's base is part of its bounded-by-construction contract).

## Summary

`exarchos-implementer` (and `fixer`, `scaffolder`) declare `isolation: worktree`
in their agent frontmatter (`agents/implementer.md:25`). On Claude Code, native
worktree isolation branches the subagent's worktree from the repository's
**default branch (`origin/HEAD` → `main`)**, not from the orchestrator's current
HEAD / integration branch. For any feature branch stacked above `main`, the
subagent receives a base missing every prerequisite in-branch commit, so a
correct, mergeable TDD implementation is impossible. A disciplined agent
self-blocks with zero file changes (the observed-and-correct outcome); a less
careful one could silently reintroduce pre-migration code on a divergent base.

This was reported twice from the field (#1509 dynatoi, #1501 canonical-identity)
as an *inferred* behavior. This RCA records the **authoritative, documented**
base-selection rule (closing the #1501 spike) and the durable fix.

## Symptom

The merge-orchestrator/dispatch path produces a subagent whose worktree HEAD is
`main`'s tip rather than the integration branch's tip:

```text
# Obs A (#1509) — repo lvlup-sw/dynatoi
Orchestrator on feature/chain-of-command (92 commits ahead of main) @ b198065
Dispatched exarchos-implementer (isolation: worktree)
→ .claude/worktrees/agent-<id> @ 15fc02b == `git rev-parse main`   (92 commits behind)
→ ForcePool / House / RelationalModifier / provider seams ALL absent → agent STOPPED

# Obs B (#1501) — feat/canonical-identity-schema @ fafe60f8 (P-16 tip)
→ worktree HEAD == cfd5875e (main tip / merge-base)
→ git merge-base --is-ancestor fafe60f8 HEAD  ⇒  NO
→ P-01..P-16 chain missing; deriveRoleLinks, ref tests, migrated GET handler absent
→ GREEN phase impossible → agent halted (0 commits, BLOCKED)
```

### Reproduction

1. Check out any branch that is ahead of `origin/HEAD` (a stacked feature/integration branch).
2. Dispatch a subagent whose frontmatter declares `isolation: worktree` (e.g. `exarchos-implementer`), with default Claude Code settings.
3. In the subagent's worktree, run `git rev-parse HEAD` and `git rev-parse main`.

**Observed:** worktree HEAD == `main` tip; in-branch prerequisites absent.
**Expected (per delegation contract):** worktree based at the integration branch's tip.

## Root cause

### Authoritative base-selection rule (closes #1501 spike)

Verified against the official Claude Code documentation
(`code.claude.com/docs/en/worktrees.md`, `…/sub-agents.md`), not inferred:

> "Worktrees branch from your repository's default branch, `origin/HEAD`, so they
> start from a clean tree matching the remote. If no remote is configured or the
> fetch fails, the worktree falls back to your current local `HEAD`."
>
> "Subagent worktrees use the same base branch as `--worktree`, so they branch
> from your repository's default branch **unless `worktree.baseRef` is set to
> `"head"`**."

| Question | Authoritative answer |
|---|---|
| Default base | `origin/HEAD` (default branch = `main`); falls back to local `HEAD` only if no remote / fetch fails |
| Override | `worktree.baseRef: "head"` in `.claude/settings.json` → branches from **local HEAD**. Accepts only `"fresh"` \| `"head"` — *not* arbitrary refs |
| Tool vs frontmatter | No difference — both paths use the same base-selection logic and respect `worktree.baseRef` |
| Inherited changes | None — worktrees are a **clean tree**; only *committed* state at the chosen base propagates. `.worktreeinclude` copies gitignored files only |
| Full override | `WorktreeCreate` hook replaces git worktree logic entirely (heavy; disables `.worktreeinclude`) |

So both field observations were correct **and by design**. The documented remedy
the issue authors did not know about: `worktree.baseRef: "head"` makes new
worktrees "carry your unpushed commits and feature-branch state, which is useful
when isolating subagents that need to operate on in-progress work" — our exact
use case.

### The exarchos-side defects

1. **Contract violated, undelivered prerequisite.** The delegation skill
   (`skills-src/delegation/SKILL.md:392`) asserts: *"Each subagent worktree is
   created at the integration branch's tip at dispatch time."* That sentence is
   **false under default Claude Code settings** — it only becomes true once
   `worktree.baseRef: "head"` is set, which exarchos neither sets nor documents.
   The "When integration advances mid-wave" runbook reasons about worktrees
   *advancing past* the integration tip while, by default, they never start there.

2. **No dispatch-time base guard.** `prepare-delegation.ts` runs a DR-1 ancestry
   preflight (integration branch descends from `main`) and a DR-2 worktree-location
   assertion — but **skips the worktree check entirely when `nativeIsolation: true`**
   (`prepare-delegation.ts:522`), trusting Claude Code to "manage isolation
   natively." Nothing verifies the *base commit* that native isolation actually
   selects. The only ancestry check that could catch a stale base runs at **merge**
   time (`merge-preflight.ts`), long after the wasted dispatch. The blind spot is
   exactly the `nativeIsolation: true` path.

3. **Upstream remedy assumed absent.** #1509 opt 3 / #1501 opt 3 proposed *filing
   upstream* for a base param. It already exists (`worktree.baseRef`), so the
   "drop isolation" (#1509 opt 1) and "self-heal rebase" (#1509 opt 2 / #1501) work
   is unnecessary.

## Impact

Delegation via native `isolation: worktree` is unusable for **any integration
branch != `main`** — i.e. every stacked-PR workflow, which the delegation skill
explicitly supports. Today operators hand-prepend a `git reset --hard
<integration-tip>` STEP 0 to each dispatch (the in-use workaround in #1501); the
fallback (non-isolated agent on an orchestrator-managed worktree) bypasses the
agent definition's system prompt, hooks, skills, and `memory: project`.

## Fix decision (recorded — closes #1501 acceptance box 2)

Two-layer, defense-in-depth. **Keep `isolation: worktree`** on the agent
definitions; the upstream lever exists.

1. **Primary lever — `worktree.baseRef: "head"`.** Set it in this repo's
   `.claude/settings.json` (dogfood + fixes our own stacked delegation). Aligns
   native isolation with the delegation contract: worktrees base on local HEAD =
   the integration tip at dispatch time. Composes with the existing
   commit-before-dispatch discipline (clean-tree worktrees propagate only
   *committed* HEAD state).

2. **Delivery to consumers — detect-and-block in `prepare_delegation`.** Exarchos
   ships as a binary + plugin and does not own a consumer's `.claude/settings.json`,
   so the setting cannot be applied transparently. Instead, when
   `nativeIsolation: true`, `prepare_delegation` reads the consumer's
   `.claude/settings.json`; if `worktree.baseRef !== "head"`, it emits a
   `preflight.blocked` (reason `worktree-baseref-unset`) with the exact JSON to add
   — **never silently dispatching onto `main`**. This is the loud-fail of #1509 opt
   4, elevated from a post-hoc guard to a pre-dispatch gate, and it occupies the
   precise branch that currently skips all base verification (line 522).

3. **Safety net — version-independent base-ancestry assert.** A
   `git merge-base --is-ancestor <integration-tip> HEAD` check baked into the
   implementer dispatch template (delegation skill), so on any Claude Code version
   that does not honor `baseRef` (or if it is misconfigured), the agent **halts
   loud** instead of building on a stale base. Replaces the hand-pinned operator
   STEP 0.

4. **Truth-up the prose** — correct `skills-src/delegation/SKILL.md` to state the
   `baseRef: "head"` prerequisite and the default `origin/HEAD` behavior; regenerate
   rendered skills/agents. Add the operator runbook note (#1501 acceptance box 3).

INV-11 holds: a `task-isolated` agent's worktree base is now bounded by
construction (the setting) plus a fail-closed guard, not by operator convention.

## Affected surfaces

| Surface | Change |
|---|---|
| `.claude/settings.json` (this repo) | add `worktree.baseRef: "head"` |
| `servers/exarchos-mcp/src/verbs/team/prepare-delegation.ts` | new `baseRef` guard in the `nativeIsolation` branch (~L520) + `guardOutcomes` extension |
| `skills-src/delegation/SKILL.md` (~L390) | correct base contract + add baseRef prerequisite + ancestry STEP 0; regenerate `skills/<runtime>/` |
| `agents/{implementer,fixer,scaffolder}.md` | **unchanged** — keep `isolation: worktree` |
| docs runbook | operator note: stop hand-pinning the base |

## References

- `code.claude.com/docs/en/worktrees.md` §"Choose the base branch", §"Isolate subagents with worktrees"
- `code.claude.com/docs/en/sub-agents.md` §"Supported frontmatter fields"
- `skills-src/delegation/SKILL.md` §"When integration advances mid-wave"
- `servers/exarchos-mcp/src/verbs/team/prepare-delegation.ts` (DR-1/DR-2 preflight; `nativeIsolation` skip at L522)
- Related: #1119 (merge-orchestrator ancestry preflight, same stacked-branch family)

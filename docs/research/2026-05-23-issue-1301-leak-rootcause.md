# #1301 Working-Tree Mirroring Leak — Root-Cause Diagnosis (T-09)

**Date:** 2026-05-23
**Task:** T-09 (`docs/plans/2026-05-23-v2-10-0-rc-dogfooding-reliability.md`)
**Issue:** #1301
**Verdict:** ESCALATED-TO-RC2 (harness-layer root cause; not reproducible from MCP-server code)
**Shipping mitigation:** T-08 `verify-worktree-baseline` leak backstop (already merged)

## Symptom

An implementer agent's worktree edits surface as **byte-identical UNCOMMITTED
modifications in the orchestrator's MAIN worktree**. At merge time these
modifications FF-block the merge even though the change is already committed on
the agent branch (hence "mirroring" — the same bytes appear in two places).

Issue #1301's leading hypothesis (#1) is a "file-tool path resolution leak":
an agent file-write occasionally resolving to BOTH the worktree path AND the
equivalent main-worktree path.

## Question for T-09

Does this leak originate in **MCP-server-owned code**
(`servers/exarchos-mcp/src/orchestrate/`) or in the **agent harness** (Claude
Code's file-tool layer, outside this repo)?

## What was inspected

1. **`prepare-delegation.ts`** — the delegation readiness composite. It queries
   projections, runs preflight guards (ancestry, protected-branch,
   main-worktree assertion), emits audit events, and returns a readiness
   assessment + quality hints for prompt assembly. **It does not resolve any
   agent file-write target and does not spawn the agent.** Its only path input
   is `process.cwd()` (for the stash probe and main-worktree guard), never an
   agent write path.

2. **`setup-worktree.ts`** — the *only* server surface that materializes an
   on-disk location an agent will subsequently write into. The worktree path is
   constructed as `join(args.repoRoot, '.worktrees', '<taskId>-<taskName>')`
   (line ~423) and provisioned via `git worktree add`. This path is
   **by-construction strictly inside `<repoRoot>/.worktrees/`** — there is no
   code path by which it resolves to the main worktree root.

3. **Orchestrate layer file-writes** — `grep` for `writeFile*`/`openSync`/
   `createWriteStream` across `src/orchestrate/` and `src/dispatch/core/` returns only:
   - `new-project.ts`, `init/seed-exarchos-config.ts`, `init/writers/*` —
     project scaffolding (orchestrator-side, not agent-isolated writes).
   - `generate-traceability.ts` — orchestrator report writer to a
     caller-supplied `outputFile` (orchestrator-side).
   None of these is a `task-isolated` agent file-write surface.

4. **Agent dispatch / spawn** — `grep` for `spawn`/`exec.*claude`/`Task(`/
   `subagent`/`child_process` in `composite.ts` and `dispatch/core/dispatch.ts` returns
   **nothing**. The MCP server is a stdio tool layer; it emits events, runs
   gates, and provisions worktrees. **It never spawns the agent and never
   resolves the agent's individual file-tool write targets.** That resolution
   is performed entirely by the Claude Code harness.

## What was ruled out

- **MCP-server path-resolution leak.** The characterization test
  `ImplementerDispatch_WorktreeEdit_DoesNotAppearInMainWorktree`
  (`src/orchestrate/prepare-delegation.integration.test.ts`) drives
  `handleSetupWorktree` against a real temp git repo, performs an agent-side
  write at the server-provisioned worktree path, and asserts the edited path
  does **not** surface as a modification in the main worktree. It passes: the
  server's worktree-provisioning surface preserves isolation by construction
  (INV-11 holds on the server side). The leak does **not** reproduce from
  server code.

  (Note: `handleSetupWorktree` step 1, `ensureGitignored`, legitimately writes
  `.gitignore` into the main worktree as part of provisioning. The test asserts
  specifically on the agent-edited path, not whole-tree cleanliness, so this
  expected provisioning write is not mistaken for a leak.)

## Recommendation

**Escalate the root fix to RC2 as a harness-layer (file-tool path resolution)
concern.** The mirroring leak cannot originate in the MCP-server code reviewed
above because the server never resolves an agent's per-file write target. The
byte-identical mirroring is consistent with the Claude Code file-tool
occasionally resolving a relative write path against the orchestrator's main
worktree in addition to the agent worktree — a layer this repo does not own.

**RC1 guarantee:** T-08's `verify-worktree-baseline` leak backstop ships as the
mitigation. It classifies a main-worktree path whose working-tree blob is
byte-identical to the agent-branch-committed blob as `leaked-committed`
(distinct from genuine dirt) and surfaces the safe `git checkout -- <path>`
remediation, turning the opaque FF-block into an actionable, recoverable state.

**Guard retained:** the T-09 characterization test stays in the suite as a
regression guard documenting that the server-side isolation invariant holds. If
a future change to `setup-worktree.ts` or the delegation surface ever resolves
an agent write root outside `<repoRoot>/.worktrees/`, the guard fails.

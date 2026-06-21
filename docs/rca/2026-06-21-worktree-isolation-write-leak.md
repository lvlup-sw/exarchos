# RCA: Worktree-isolation write leak — implementer edits land in the main worktree (#1301, root fix)

**Date:** 2026-06-21
**Issue:** #1301 (mirroring leak) — root-cause + structural fix
**Workflow:** `debug-worktree-isolation-leak` (thorough track)
**Invariant:** INV-11 (posture-declared-capabilities — a `task-isolated` agent's write surface is part of its bounded-by-construction contract)
**Supersedes the disposition of:** `docs/research/2026-05-23-issue-1301-leak-rootcause.md` (verdict ESCALATED-TO-RC2 / "harness-layer, not ownable")
**Related but distinct:** `docs/rca/2026-05-31-implementer-worktree-base.md` (#1509/#1501 — worktree *base* selection, a different INV-11 gap)

## Symptom

An `exarchos-implementer` subagent dispatched with `isolation: worktree` edits and commits
cleanly *inside* its worktree, yet after it reports complete the orchestrator's **main**
worktree shows uncommitted `M` on the same paths — byte-identical to the agent's commit. At
merge time these phantom modifications FF-block the merge ("mirroring"). Under parallel
dispatch two agents' leaks overlap and corrupt the main working tree against both branches.

## Why the prior investigation stalled

The 2026-05-23 RCA (T-09) asked exactly one question: *"Does the leak originate in
MCP-server-owned code (`orchestrate/`)?"* It correctly proved the server never resolves an
agent's per-file write target (`setup-worktree.ts` provisions strictly inside
`<repoRoot>/.worktrees/`; nothing in `composite.ts`/`core/dispatch.ts` spawns the agent), and
concluded "harness-layer, not ownable → escalate; ship the merge-time backstop." That framing
was too narrow: it never examined the **prompt contract and the agent-hook adapter** — both of
which exarchos *does* own — and so it foreclosed the structural fix. The merge-time
`verify-worktree-baseline` `leaked-committed` classifier (`ac2efe72`) has been the only line of
defense since; it *detects after the fact*, exactly what we want to eliminate.

## Root cause (two facts, both inside exarchos's control)

**1. The dispatch contract feeds the agent absolute *main-repo* file paths.**
`skills-src/delegation/references/implementer-prompt.md` — "Key Principles" #3 — instructs the
orchestrator: *"Explicit Paths — **Absolute paths** to working directory and files."* Those
absolute paths are built from the orchestrator's cwd, which is the **main worktree**. They are
interpolated verbatim into the agent's `## Files` section
(`{{filePaths}}`, `servers/exarchos-mcp/src/agents/definitions.ts` `renderImplementerPrompt`).

A git worktree shares the object store but has a **separate working tree**. An `Edit`/`Write`
to an *absolute* path resolves literally and **ignores the agent's cwd** — so an absolute
main-repo path writes into main even though the agent has dutifully `cd`-ed into its worktree.
This matches the 2026-05-17 field diagnosis ("the implementer's Edit/Read/Write calls used the
main repo's absolute path instead of the worktree's") and explains the byte-identical
mirroring: same bytes, written through a main-repo path, then also committed in the worktree.

**2. There is no enforcement — only ~90 lines of prose asking the agent to behave.**
`agents/implementer.md` carries a large "Working Directory Setup / Worktree Verification /
Worktree Hygiene" block (`cd`, `pwd`-check, `git -C`, `$WORKTREE`-prefix). All of it is
*advisory*. None of it constrains an absolute-path `Edit`. The agent's only enforced hook is
`PostToolUse: Bash → exarchos run-tests`. So isolation depends on model compliance — the
definition of "detected/instructed, not by construction."

**Net:** the contract *hands* the agent a main-repo write address (fact 1) and *nothing
prevents* its use (fact 2). The leak is a designed-in capability, not a harness accident.

## Evidence

- `skills-src/delegation/references/implementer-prompt.md:456` — "Absolute paths to … files."
- `servers/exarchos-mcp/src/agents/definitions.ts` — `## Files\n{{filePaths}}` interpolation;
  IMPLEMENTER `validationRules` has a `pre-write` rule with **no `command`** (guidance only).
- `servers/exarchos-mcp/src/agents/adapters/claude.ts:51-53` — `TRIGGER_MAP` already maps
  `pre-write → PreToolUse {matcher:'Write|Edit'}` and `post-test → PostToolUse {Bash}`.
- `servers/exarchos-mcp/src/agents/adapters/claude.ts:67-91` — `buildHooksFromRules` emits a
  real hook **iff the rule has a `command`** (line 73 skips command-less rules). This is the
  exact, proven path `exarchos run-tests` rides today.
- Claude Code hook contract (verified against current docs): a `PreToolUse` hook **can deny**
  `Edit|Write|MultiEdit` (exit 2, or `hookSpecificOutput.permissionDecision:"deny"`); it
  receives `tool_input.file_path` and `cwd` on stdin; under `isolation: worktree` `cwd` **is the
  worktree path** and agent-scoped frontmatter hooks fire only for that subagent.

## Structural fix (guaranteed by construction)

Two layers — the hook is load-bearing; the contract change removes the source.

**Layer A — Enforcement (the guarantee): a PreToolUse worktree-boundary hook.**
Add a new CLI subcommand `exarchos verify-worktree-boundary` (mirrors `exarchos run-tests`):
read the PreToolUse JSON on stdin, resolve `tool_input.file_path` against `cwd`, and **deny
(exit 2) any write whose realpath escapes the worktree root**. Wire it by adding a `pre-write`
`validationRule` *with a `command`* to the `task-isolated` agent specs (IMPLEMENTER, FIXER,
SCAFFOLDER) in `definitions.ts`; the existing `claude.ts` adapter renders it as a `PreToolUse`
`Write|Edit` hook automatically. Extend the matcher to `Write|Edit|MultiEdit` (+ `NotebookEdit`).
Result: an absolute main-repo path → realpath outside cwd → **denied**; a correct
relative/worktree path → inside cwd → allowed. The leak becomes unrepresentable (INV-11).

**Layer B — Prevention (remove the source): relative path contract.**
Invert "Key Principles" #3 to *"repo-relative paths, resolved against the worktree root — never
absolute paths into the parent repo,"* and make `renderImplementerPrompt`/the orchestrator emit
worktree-relative `filePaths`. With cwd = worktree (harness chdir) and only relative paths, the
common case never even reaches the hook.

**Cross-runtime parity (INV-4).** The guarantee must exist on every runtime's path, not just
Claude. Map the `pre-write→PreToolUse-equivalent` trigger in the other runtime adapters
(codex/cursor/copilot/opencode); where a runtime has no pre-write hook surface, **log the gap
explicitly** rather than silently shipping an unprotected path.

**Backstop demotion.** The merge-time `verify-worktree-baseline` `leaked-committed` classifier
stays as defense-in-depth, but is no longer the only line — the hook prevents the leak upstream.

## Verification plan (debug → fix, TDD)

- **High tier** — `verify-worktree-boundary` guard: deny absolute-main path; allow
  worktree-relative path; allow nested worktree path; deny `..`-escape; handle missing/symlink
  paths. Unit-test the resolver against a temp repo + worktree.
- **Medium tier** — adapter: a `pre-write` rule *with* command renders a `PreToolUse`
  `Write|Edit|MultiEdit` hook; command-less `pre-write` still renders nothing (regression).
- **Snapshot** — `generate-agents.test.ts` byte-pins agent markdown; dual-baseline update
  (`vitest -u` + regenerate `agents/` + per-runtime trees) is expected and intentional.
- **Regression guard retained** — the T-09 `ImplementerDispatch_WorktreeEdit_DoesNotAppearInMainWorktree`
  characterization stays green (server-side isolation invariant).

## Definition of done

- `exarchos verify-worktree-boundary` ships and denies out-of-worktree writes (exit 2).
- `task-isolated` agents render the PreToolUse boundary hook on Claude; parity mapped or gap
  logged on every other runtime.
- Implementer prompt contract uses worktree-relative paths; no absolute main-repo path is
  emitted by the renderer.
- Snapshots + `skills:guard`/`hooks:guard` green; the #1301 leak no longer reproduces by
  construction; merge-time backstop retained as secondary.

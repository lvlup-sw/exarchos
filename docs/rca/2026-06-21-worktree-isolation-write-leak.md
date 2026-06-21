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

## Structural fix

Defense-in-depth across the dispatch lifecycle. **INV-4 is load-bearing here: the structural
fix must hold on every runtime's path, so the *platform-agnostic* mechanisms are primary.** A
Claude-only mechanism cannot *be* the fix — it would leave codex/cursor/copilot/opencode
unprotected. exarchos has exactly two runtime-agnostic seams (it never spawns the agent and has
no agnostic during-work interception point), and both are used:

**Primary — agnostic prevention: the relative-path contract.** Remove the leak source. The
dispatch contract — delegation `SKILL.md`, the IMPLEMENTER/FIXER/SCAFFOLDER system prompts
(`definitions.ts`), and the `implementer-prompt.md` reference — emits **worktree-relative** file
paths (absolute only for the `cd` target). With cwd = worktree and only relative paths, no agent
on *any* runtime is handed a main-repo address. Path construction is the orchestrator's job on
every runtime, so this is enforced by a *consistent, prominent contract* rather than a code
rewrite — but it is the one mechanism that reaches all five runtimes, so it is the load-bearing
line. (It propagates into all 5 rendered agent artifacts + all 8 skill variants.)

**Primary — agnostic detection: the merge-time backstop.** `verify-worktree-baseline`'s
`leaked-committed` classifier runs in exarchos code at merge on **every** runtime, catching any
leak the contract misses and surfacing a safe `git checkout -- <path>` remediation. By
construction, runtime-independent — the agnostic safety net.

**Per-runtime hardening (NOT the guarantee): the PreToolUse boundary hook.** On Claude — the one
runtime that exposes a during-work tool-call interception seam — `exarchos
verify-worktree-boundary` is wired as a `PreToolUse` deny-hook (via a `pre-write` validationRule
*with a command*; the `claude.ts` adapter renders it automatically; matcher
`Write|Edit|MultiEdit|NotebookEdit`). It makes an out-of-worktree write impossible *on Claude*.
This is **belt-and-suspenders on top of the agnostic layers, explicitly not a substitute** for
them: codex/cursor/copilot/opencode treat `isolation:worktree` as advisory and expose no hook,
so elevating this to "the fix" would violate INV-4.

**INV-4 parity — extension path, logged gaps.** The correct way to extend *by-construction*
enforcement beyond Claude is each runtime's **native confinement** primitive, not one Claude
mechanism: e.g. codex's `sandbox_mode: workspace-write` scoped to the worktree, or each host's
equivalent sandbox/workspace seam. Where a runtime exposes no confinement seam, the gap is
**logged** (a regression test pins that the hook renders on Claude only) — never faked. Until
those land, the agnostic prevention + detection layers above are what hold the line everywhere.

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

- **Agnostic prevention (primary):** the dispatch contract emits worktree-relative paths
  everywhere it is stated — delegation `SKILL.md`, the IMPLEMENTER/FIXER/SCAFFOLDER system
  prompts (→ all 5 rendered agent artifacts), and `implementer-prompt.md`. No surface instructs
  absolute parent-repo paths. (This is the line that holds on every runtime.)
- **Agnostic detection (primary):** the merge-time `verify-worktree-baseline` `leaked-committed`
  backstop is retained as the runtime-independent safety net.
- **Per-runtime hardening (Claude):** `exarchos verify-worktree-boundary` ships, denies
  out-of-worktree writes (exit 2), and renders as a `PreToolUse` hook on Claude only. The
  Claude-only scope is **logged** (parity regression test), with native-confinement on other
  runtimes (e.g. codex `sandbox_mode`) noted as the extension path — not faked as parity.
- Snapshots + `skills:guard`/`hooks:guard` green. The #1301 leak is prevented by contract +
  detected by backstop on **every** runtime, and additionally unrepresentable by construction
  on Claude.

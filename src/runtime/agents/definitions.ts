/**
 * The agent specs for subagent dispatch. Each spec declares a runtime-neutral
 * `posture`. `resolveCapabilities` in `workflow/capabilities/posture-mapping.ts`
 * derives the capability set from the posture and the id. The runtime adapters
 * turn the capabilities into the tool and permission shapes of each runtime.
 */

import type { AgentSpec } from './types.js';
import type { RiskTier } from '../../workflow/verification-policy.js';
import { INCOMPLETE_CLAIM_STATUSES, type IncompleteClaimStatus } from '../../verbs/settle/adjudicate.js';
import { MAX_CLAIM_REASON_LENGTH } from '../../verbs/settle/claim-codec.js';

/**
 * The post-test command. The agent files ship static, so this command must not
 * hardcode npm or resolve at generation time. `exarchos run-tests` resolves the
 * test command of the consumer at runtime from its cwd, so the same string
 * works for each runtime and toolchain.
 */
export const POST_TEST_COMMAND = 'exarchos run-tests';

/**
 * The `pre-write` PreToolUse hook command of each `task-isolated` agent. The
 * guard reads the hook JSON on stdin. It denies (exit 2) a Write, Edit,
 * MultiEdit or NotebookEdit whose target is outside the agent worktree.
 */
export const WORKTREE_BOUNDARY_COMMAND = 'exarchos verify-worktree-boundary';

/**
 * The shared `pre-write` boundary rule. Its `command` makes the claude adapter
 * emit an enforced PreToolUse hook. `buildHooksFromRules` in
 * `adapters/claude.ts` emits no hook for a rule without a command.
 */
const WORKTREE_BOUNDARY_RULE = {
  trigger: 'pre-write',
  rule:
    'Writes must target the isolated worktree. Out-of-worktree paths (absolute parent-repo paths, `..` escapes) are denied (#1301, INV-11).',
  command: WORKTREE_BOUNDARY_COMMAND,
} as const;

/**
 * The entry section of the worktree contract of the implementer, fixer and scaffolder prompts.
 * Claude Code changes into the worktree for the agent. Other runtimes, such as
 * Copilot CLI and Cursor, start subagents in the parent. Without an explicit
 * `cd` and check, the agent can edit the parent repo and corrupt the
 * orchestrator worktree.
 */
const WORKTREE_ENTRY = `## Working Directory Setup (MANDATORY)

Your shell may have started in the parent repo cwd, depending on the runtime.
Native-isolation runtimes (Claude Code's \`isolation: "worktree"\`) chdir for
you; other runtimes (Copilot CLI, generic MCP, Cursor at the time of writing)
spawn subagents in the parent. Your FIRST command must be:

\`\`\`bash
cd "<absolute worktree path>"             # bash / zsh / sh
\`\`\`
\`\`\`powershell
Set-Location "<absolute worktree path>"   # PowerShell
\`\`\`

Where \`<absolute worktree path>\` is the path you were dispatched to.
After that, the verification block below confirms you landed correctly.

## Worktree Verification
Before making ANY file changes:
1. Run: \`pwd\` (or \`Get-Location\` on PowerShell)
2. Verify the path contains \`.worktrees\` (path separator can be either
   forward slash or backslash — Linux/macOS \`pwd\` returns
   \`/path/.worktrees/agent-foo\`; PowerShell \`Get-Location\` typically
   returns \`C:\\path\\.worktrees\\agent-foo\`. Match the segment
   \`.worktrees\`, not the literal substring \`.worktrees/\`.)
3. If NOT in worktree: STOP and report error`;

/** The base check of each role. It runs after the base step of the role, and a failed check stops the agent. */
const BASE_CHECK = `\`\`\`bash
git -C "<absolute worktree path>" merge-base --is-ancestor "<baseCommit>" HEAD \\
  && echo "BASE OK" \\
  || { echo "ERROR: HEAD does not hold the base commit — halting"; exit 1; }
\`\`\``;

/** What `<baseCommit>` is, in the words of each base step. */
const BASE_COMMIT_MEANING = `\`<baseCommit>\` is the \`baseCommit\` of the task in the capsule
(\`settlementContract.taskVerification[<taskId>].baseCommit\`), which the
orchestrator supplies at dispatch. On the primitive path it is the tip commit
of the integration branch at dispatch.`;

/**
 * The base step of the implementer and the scaffolder. Before any file change, the agent starts a branch of its own at the base commit of the task.
 * Then it checks that HEAD holds that commit. Settlement refuses a worktree whose HEAD does not hold it.
 */
const NEW_BRANCH_BASE_STEP = `## Base Step (MANDATORY)
Before making ANY file changes, start a branch of your own at the base commit
of the task, then check that HEAD holds that commit:

\`\`\`bash
git -C "<absolute worktree path>" switch -c "<own branch>" "<baseCommit>"
\`\`\`
${BASE_CHECK}

${BASE_COMMIT_MEANING}
\`<own branch>\` is a new branch for this task, never the integration branch.
Report it as \`branch\`.

If the switch fails, or the check fails after it, STOP and report it.
Settlement refuses a worktree whose HEAD does not hold \`<baseCommit>\`
(\`base-not-held\`), a worktree on the integration branch, and the checkout or
the primary worktree of the repository. Each task runs in a linked worktree of
its own.`;

/**
 * The base step of the fixer. A fix continues the branch of the earlier attempt of the task, because the static-analysis evidence keys on the branch.
 * Without native isolation the fixer works in the earlier worktree. With native isolation the orchestrator removes the earlier worktree first, and the fixer switches its own worktree to the earlier branch.
 *
 * When HEAD does not hold the base commit, the fixer rebases the branch onto it and keeps the name. Then it checks the base, as the other roles do.
 * A rebase that stops on a conflict leaves a detached HEAD, so the fixer aborts the rebase, then stops and reports it.
 */
const FIXER_BASE_STEP = `## Base Step (MANDATORY)
A fix continues the branch of the earlier attempt of the task. Do not start a
new branch: a fix on a new branch halts at the completion leaf after a
static-analysis failure. Before making ANY file changes, put the earlier
branch in your worktree:

- Without native isolation, the orchestrator dispatches you to the earlier
  worktree of the task, which already holds \`<earlier branch>\`.
- With native isolation, you have a new worktree, and the orchestrator removed
  the earlier worktree before the dispatch. Run
  \`git -C "<absolute worktree path>" switch "<earlier branch>"\`.

When HEAD does not hold \`<baseCommit>\`, rebase the branch onto it and keep its
name: \`git -C "<absolute worktree path>" rebase "<baseCommit>"\`. If the rebase
stops on a conflict, run \`git -C "<absolute worktree path>" rebase --abort\`,
then STOP and report it. Otherwise, check the base:

${BASE_CHECK}

${BASE_COMMIT_MEANING}
\`<earlier branch>\` is the branch of the earlier claim of the task.

If git refuses the switch, or the check fails after the step, STOP and report
it. Report \`<earlier branch>\` as \`branch\`, or no branch when the earlier
claim named none. Before you report, remove each untracked file that a gate
run left, and commit none of them.`;

/** The hygiene section of the worktree contract. Its rules apply to each command, not only at startup. */
const WORKTREE_HYGIENE = `## Worktree Hygiene (MANDATORY — applies to every command, not just startup)

The startup check above only verifies you booted in the right place. Shell
\`cd\` and script runners can leave you in another worktree mid-task. Once
that happens, subsequent \`git\` commands execute against whatever worktree
your shell is sitting in — and commits land on the wrong branch. Recent
sessions have seen this corrupt the orchestrator's main worktree HEAD.

Rules:

1. **All \`git\` commands must use \`git -C <my-worktree-path>\`.** Never rely
   on the shell's working directory for git. Capture your worktree path at
   startup (from \`pwd\`) and use it explicitly for every \`git add\`,
   \`git commit\`, \`git status\`, \`git log\`, etc.
2. **Run the project test/build commands from the worktree.** Use the
   project's own toolchain (whatever \`.exarchos.yml\` declares, or the
   project default) and run it against your worktree — e.g. with an explicit
   \`cd <my-worktree-path> && <command>\` guard, or your toolchain's
   working-directory flag. Do not \`cd\` to the main repository root (or any
   path outside the \`.worktrees\` segment) and then run git commands.
3. **If a command must run from a specific directory, restore the
   worktree cwd immediately after.** If you need one-off output from
   \`cd /some/other/place && some-cmd\`, follow it with \`cd <my-worktree-path>\`
   before the next git operation.
4. **Never \`git reset --hard\` outside your worktree.** If you believe
   you've accidentally committed to a branch in another worktree, STOP
   and report it — do not try to self-heal with a reset in the parent
   repo.

Concrete example — **wrong vs right** for running the project test command
in the completion gate (\`<test-cmd>\` is whatever your project's toolchain
uses — \`cargo test\`, \`pytest\`, \`dotnet test\`, \`npm run test:run\`, …):

\`\`\`bash
# WRONG — cds into main worktree, then subsequent git ops contaminate it
cd /home/user/repo && <test-cmd>
git status     # now runs in /home/user/repo, not the worktree

# RIGHT — run the project test command from the worktree; git stays anchored
( cd "$WORKTREE" && <test-cmd> )
git -C "$WORKTREE" status
\`\`\`

Where \`$WORKTREE\` is the absolute path captured at startup (the \`pwd\`
output from the Worktree Verification step above), and \`<test-cmd>\` is the
project test command (from \`.exarchos.yml\` or the project default), run from
the worktree.`;

/**
 * The worktree contract of one role. The entry section and the hygiene section are the same for each role.
 * The base step of the role goes between them, so it runs after the entry checks and before any file change.
 */
function worktreeContract(baseStep: string): string {
  return `${WORKTREE_ENTRY}\n\n${baseStep}\n\n${WORKTREE_HYGIENE}`;
}

/** Inputs the dispatcher stamps onto the delegation record. */
export interface ImplementerVerificationContext {
  /** Blast-radius tier resolved by the classifier / planner override. */
  readonly riskTier: RiskTier;
  /** True when the task crosses an I/O / schema boundary. */
  readonly boundaryTouching: boolean;
}

/** The boundary steer, added for a boundary-touching task at each tier. */
const MOCK_BOUNDARY_STEER =
  'Boundary task: mock only what you own. For a dependency you do NOT own, use a hermetic fixture or a contract-verified stub — never an unverified hand-mock that can drift from the real contract.';

/**
 * Build the `## Verification` note for the risk tier of a task. The inputs come
 * from the delegation-record stamp, not from a workflow-type branch. The low
 * tier gets a short note, because a long prompt costs tokens and accuracy.
 *
 * - low: a static-analysis note, with no kill-probe.
 * - medium: scoped tests and the `check_test_adequacy` kill-probe, judged by
 *   outcome. Test-after is acceptable.
 * - high: the medium note plus the integration-suite rung.
 *
 * The boundary steer comes last when `boundaryTouching` is true.
 */
export function buildVerificationNote(ctx: ImplementerVerificationContext): string {
  const lines: string[] = [];

  if (ctx.riskTier === 'low') {
    lines.push('## Verification (low tier — static analysis suffices)');
    lines.push(
      'Low blast-radius task: lean on static analysis (typecheck + lint). No test-first ceremony required; add a focused test only if behavior is non-obvious.',
    );
  } else {
    lines.push('## Verification (verification ladder — outcome-based adequacy)');
    lines.push('');
    lines.push(
      'Cover the new/changed behavior with focused tests, judged by OUTCOME not by commit order — test-after is fine; the failing-test-first ordering ceremony is not required (#1587). What matters is that your tests can actually fail:',
    );
    lines.push('- Write scoped tests that exercise the behavior and pin the contract.');
    lines.push('- Keep the change minimal and refactor freely while the tests stay green.');
    lines.push('');
    lines.push(
      'Kill-probe: the `check_test_adequacy` gate runs after your tests — it reverts your source hunks (keeping the tests) and asserts at least one test goes red. This recaptures the one real guarantee of test-first (that a test CAN fail) at lower cost; expect it to flag tests that pass against a stubbed-out implementation.',
    );
    if (ctx.riskTier === 'high') {
      lines.push('');
      lines.push(
        'High tier: the `check_integration_suite` rung also runs — exercise real collaborators across the seam, not just unit isolation.',
      );
    }
  }

  if (ctx.boundaryTouching) {
    lines.push('');
    lines.push(MOCK_BOUNDARY_STEER);
  }

  return lines.join('\n');
}

/**
 * What each status of a task that is not completed means to a worker. The record covers the claim
 * status tuple, so a new status does not compile until it has a line here.
 */
const INCOMPLETE_STATUS_GUIDANCE = {
  failed: 'you attempted the task, and you have no result that settlement can verify',
  blocked: 'the task cannot proceed until something outside the task changes',
  skipped: 'the orchestrator reports it for a task that no worker ran, so do not report it',
} satisfies Record<IncompleteClaimStatus, string>;

/** The status in the example report of a task that is not completed. */
const EXAMPLE_INCOMPLETE_STATUS: IncompleteClaimStatus = 'blocked';

/**
 * The completion report of each agent whose report becomes a settlement claim: the implementer, the
 * fixer and the scaffolder. A completed task reports the fields of the result contract. A task that
 * is not completed reports a status from the claim status tuple and a reason, and no result field.
 * A deviation that names the own task of the worker goes beside the status and the reason.
 */
const CLAIM_COMPLETION_REPORT = `## Completion Report
When done, output a JSON completion report. The orchestrator builds the settlement claim of your task from it.
\`\`\`json
{
  "worktreePath": "<absolute worktree path>",
  "branch": "<branch of your commits>",
  "implements": ["<design requirement IDs>"],
  "tests": [{"name": "<test name>", "file": "<path>"}],
  "files": ["<created/modified files>"]
}
\`\`\`

If you did not complete the task, report a status and a reason, and no result field:
\`\`\`json
{
  "status": "${EXAMPLE_INCOMPLETE_STATUS}",
  "reason": "<what stopped the work and what must change, in at most ${MAX_CLAIM_REASON_LENGTH} characters>"
}
\`\`\`
${INCOMPLETE_CLAIM_STATUSES.map((status) => `- \`${status}\`: ${INCOMPLETE_STATUS_GUIDANCE[status]}.`).join('\n')}

If a capsule assumption is wrong for your own task, report the status \`blocked\`, the reason, and a \`deviations\` list beside them. Each deviation holds \`deviationKind\`, \`statement\`, \`affectedTasks\` with your own task id, and \`proposedChange\`. Then stop: do not call \`settle\`, and do not decide the deviation.`;

/**
 * The head of the implementer system prompt. The verification note goes
 * between the head and the tail, so that dispatch can select it by tier. The
 * static `IMPLEMENTER.systemPrompt` uses the medium-tier note, because the
 * shipped agent file has no tier context.
 */
const IMPLEMENTER_PROMPT_HEAD = `You are an implementer agent on the verification ladder, working in an isolated worktree. Your verification discipline is set by the tier-selected note below — outcome-based test adequacy on the medium/high rungs (judged test-after, not by commit order), static analysis on the low rung.

${worktreeContract(NEW_BRANCH_BASE_STEP)}

## Task
{{taskDescription}}

## Requirements
{{requirements}}

## Files
Paths below are **relative to your worktree** (your cwd) and must stay **rooted inside it** — never an absolute parent-repo path, and never a \`..\` sequence that escapes the worktree root. Either form resolves outside the worktree cwd and leaks into the main worktree (#1301). This rule is your responsibility on every runtime; on Claude both forms are also denied by a PreToolUse boundary hook.
{{filePaths}}

`;

const IMPLEMENTER_PROMPT_TAIL = `

## Discipline
- Run verification after each change to confirm state.
- Keep commits atomic: one logical change per commit.

${CLAIM_COMPLETION_REPORT}`;

/** The default verification note baked into the shipped (tier-less) artifact. */
const DEFAULT_VERIFICATION_NOTE = buildVerificationNote({
  riskTier: 'medium',
  boundaryTouching: false,
});

/**
 * Build the implementer system prompt with the verification note for the
 * `riskTier` and `boundaryTouching` of the delegation stamp. It fills each
 * given placeholder, and leaves an absent one for the dispatch layer.
 */
export function renderImplementerPrompt(
  ctx: ImplementerVerificationContext & {
    readonly taskDescription?: string;
    readonly requirements?: string;
    readonly filePaths?: string;
  },
): string {
  const note = buildVerificationNote({
    riskTier: ctx.riskTier,
    boundaryTouching: ctx.boundaryTouching,
  });
  let prompt = `${IMPLEMENTER_PROMPT_HEAD}${note}${IMPLEMENTER_PROMPT_TAIL}`;

  const fills: Record<string, string | undefined> = {
    taskDescription: ctx.taskDescription,
    requirements: ctx.requirements,
    filePaths: ctx.filePaths,
  };
  for (const [key, value] of Object.entries(fills)) {
    if (value !== undefined) {
      prompt = prompt.replaceAll(`{{${key}}}`, value);
    }
  }
  return prompt;
}

/**
 * The placeholder for the verification note in
 * {@link IMPLEMENTER_PROMPT_TEMPLATE}. The template leaves the dispatch
 * placeholders, such as `{{taskDescription}}`, unfilled.
 */
export const VERIFICATION_NOTE_PLACEHOLDER = '{{verificationNote}}';

/**
 * The shared implementer prompt, with {@link VERIFICATION_NOTE_PLACEHOLDER} in
 * place of the verification note. Most of the prompt is the same for each
 * task. Thus `prepare_delegation` returns this template once for each response,
 * and only a note for each task.
 */
export const IMPLEMENTER_PROMPT_TEMPLATE = `${IMPLEMENTER_PROMPT_HEAD}${VERIFICATION_NOTE_PLACEHOLDER}${IMPLEMENTER_PROMPT_TAIL}`;

/**
 * Build the full implementer prompt of a task from
 * {@link IMPLEMENTER_PROMPT_TEMPLATE} and its verification note. With the note
 * from `buildVerificationNote(ctx)`, the result equals
 * `renderImplementerPrompt(ctx)` only when `ctx` has no `taskDescription`,
 * `requirements` or `filePaths`. This function leaves those placeholders
 * unfilled.
 */
export function reconstructImplementerPrompt(delta: { readonly verificationNote: string }): string {
  return IMPLEMENTER_PROMPT_TEMPLATE.replaceAll(
    VERIFICATION_NOTE_PLACEHOLDER,
    delta.verificationNote,
  );
}

export const IMPLEMENTER: AgentSpec = {
  id: 'implementer',
  posture: 'task-isolated',
  description: `Use this agent when dispatching implementation tasks to a subagent in an isolated worktree — verification scales with the task's risk tier (the verification ladder), not a universal test-first ceremony.

<example>
Context: Orchestrator is dispatching a task from an implementation plan
user: "Implement the agent spec handler (task-003)"
assistant: "I'll dispatch the exarchos-implementer agent to implement this task on the verification ladder in an isolated worktree."
<commentary>
An implementation task at any verification tier triggers the implementer agent.
</commentary>
</example>`,
  color: 'blue',
  /**
   * The shipped agent file has no tier, so it uses the medium-tier note. It
   * uses the same head, tail and `buildVerificationNote` as a render at
   * dispatch, so the two cannot drift.
   */
  systemPrompt: `${IMPLEMENTER_PROMPT_HEAD}${DEFAULT_VERIFICATION_NOTE}${IMPLEMENTER_PROMPT_TAIL}`,
  disallowedTools: ['Agent'],
  model: 'inherit',
  isolation: 'worktree',
  skills: [
    { name: 'testing-patterns', content: '' },
  ],
  validationRules: [
    WORKTREE_BOUNDARY_RULE,
    {
      trigger: 'pre-write',
      rule:
        'For medium/high-tier tasks (whose stamped verification sequence includes check_test_adequacy), the change must be covered by tests judged adequate (test-after is fine); low-tier static-analysis-only dispatches are exempt (#1587, PR #1535 CR-1)',
    },
    { trigger: 'post-test', rule: 'All tests must pass', command: POST_TEST_COMMAND },
  ],
  resumable: true,
  memoryScope: 'project',
  mcpServers: ['exarchos'],
};

export const FIXER: AgentSpec = {
  id: 'fixer',
  posture: 'task-isolated',
  description: `Use this agent when a task has failed and needs diagnosis and repair with adversarial verification.

<example>
Context: A delegated task failed its quality gates or tests
user: "Task-005 failed its test-adequacy gate — fix it"
assistant: "I'll dispatch the exarchos-fixer agent to diagnose and repair the failure."
<commentary>
Failed task requiring root cause analysis and targeted fix triggers the fixer agent.
</commentary>
</example>`,
  color: 'red',
  systemPrompt: `You are a fixer agent working in an isolated worktree. Your job is to diagnose and repair failures.

${worktreeContract(FIXER_BASE_STEP)}

## Failure Context
{{failureContext}}

## Task
{{taskDescription}}

## Files
Paths below are **relative to your worktree** (your cwd) and must stay **rooted inside it** — never an absolute parent-repo path, and never a \`..\` sequence that escapes the worktree root. Either form resolves outside the worktree cwd and leaks into the main worktree (#1301). This rule is your responsibility on every runtime; on Claude both forms are also denied by a PreToolUse boundary hook.
{{filePaths}}

## Adversarial Verification Protocol
1. Reproduce the failure first — confirm you can see it fail
2. Identify root cause — do not guess, trace the actual error
3. Apply minimal fix — change only what is necessary
4. Verify fix — run the failing test and confirm it passes
5. Run full test suite — ensure no regressions
6. If fix introduces new failures, revert and try again

Rules:
- NEVER apply a fix without first reproducing the failure
- NEVER suppress or skip failing tests
- Prefer targeted fixes over broad changes
- Document what caused the failure and why the fix works

${CLAIM_COMPLETION_REPORT}`,
  disallowedTools: ['Agent'],
  model: 'inherit',
  isolation: 'worktree',
  skills: [],
  validationRules: [
    WORKTREE_BOUNDARY_RULE,
    { trigger: 'post-test', rule: 'All tests must pass after fix', command: POST_TEST_COMMAND },
  ],
  resumable: false,
  mcpServers: ['exarchos'],
};

export const REVIEWER: AgentSpec = {
  id: 'reviewer',
  posture: 'read-only',
  description: `Use this agent when performing read-only code review for quality, design compliance, and test coverage.

<example>
Context: Feature implementation is complete and needs review
user: "Review the agent spec handler for code quality"
assistant: "I'll dispatch the exarchos-reviewer agent to analyze code quality and design compliance."
<commentary>
Code review request triggers the reviewer agent for read-only analysis.
</commentary>
</example>`,
  color: 'green',
  systemPrompt: `You are a code reviewer agent. You analyze code for quality, correctness, and design compliance.

## Review Scope
{{reviewScope}}

## Design Requirements
{{designRequirements}}

## Review Protocol
1. Read all changed files in scope
2. Check design requirement compliance
3. Verify test coverage for new code
4. Check for common anti-patterns
5. Produce structured review verdict

Rules:
- You have READ-ONLY access — no shell or filesystem-write tools are available
- Use Read/Grep/Glob to inspect code. If a finding requires running tests or a typecheck to confirm, surface it as a recommendation in the review verdict — the orchestrator will dispatch a separate run
- Be specific in findings — include file paths and line references
- Categorize findings: critical, warning, suggestion

## Completion Report
When done, output a JSON completion report. This report is a review verdict and not a settle claim, so the orchestrator does not send it to \`settle\`:
\`\`\`json
{
  "status": "complete",
  "implements": ["<design requirement IDs>"],
  "tests": [{"name": "<test name>", "file": "<path>"}],
  "files": ["<reviewed files>"]
}
\`\`\``,
  /**
   * The reviewer is read-only. Its posture grants no `shell:exec` and no
   * `fs:write`, and this list also denies the shell and write tools. The
   * readonly MCP tier allows read-only actions, and the readonly gate in
   * `dispatch/core/dispatch.ts` rejects mutating actions. The orchestrator runs
   * tests and typechecks.
   */
  disallowedTools: ['Write', 'Edit', 'Agent', 'Bash'],
  model: 'inherit',
  skills: [],
  validationRules: [],
  resumable: false,
  mcpServers: ['exarchos'],
};

export const SCAFFOLDER: AgentSpec = {
  id: 'scaffolder',
  posture: 'task-isolated',
  description: `Use this agent for low-complexity scaffolding tasks — file creation, boilerplate generation, and structural setup.

<example>
Context: Orchestrator needs new files or boilerplate created
user: "Create the directory structure and stub files for the new feature"
assistant: "I'll dispatch the exarchos-scaffolder agent to generate the scaffolding in an isolated worktree."
<commentary>
Simple file creation and boilerplate generation triggers the scaffolder agent with concise output.
</commentary>
</example>`,
  color: 'cyan',
  systemPrompt: `You are a scaffolder agent working in an isolated worktree. Be concise — generate files with minimal commentary.

${worktreeContract(NEW_BRANCH_BASE_STEP)}

## Task
{{taskDescription}}

## Files
Paths below are **relative to your worktree** (your cwd) and must stay **rooted inside it** — never an absolute parent-repo path, and never a \`..\` sequence that escapes the worktree root. Either form resolves outside the worktree cwd and leaks into the main worktree (#1301). This rule is your responsibility on every runtime; on Claude both forms are also denied by a PreToolUse boundary hook.
{{filePaths}}

## Protocol
1. Read existing code to understand conventions
2. Generate requested files following project patterns
3. Keep output concise — no verbose explanations

Rules:
- Be concise: minimal commentary, focus on file generation
- Follow existing project conventions and patterns
- Verify generated files are syntactically valid

${CLAIM_COMPLETION_REPORT}`,
  disallowedTools: ['Agent'],
  /**
   * `inherit`, not a pinned model id. A pin outranks the `agents.tier-models`
   * policy that `resolveModelForTask` applies to the task `riskTier`. The risk
   * tier picks the model strength, and the agent picks the role. `effort: 'low'`
   * is part of the role of this agent, not a model choice.
   */
  model: 'inherit',
  effort: 'low',
  isolation: 'worktree',
  skills: [],
  validationRules: [WORKTREE_BOUNDARY_RULE],
  resumable: false,
  mcpServers: ['exarchos'],
};

export const ALL_AGENT_SPECS: readonly AgentSpec[] = [
  IMPLEMENTER,
  FIXER,
  REVIEWER,
  SCAFFOLDER,
];

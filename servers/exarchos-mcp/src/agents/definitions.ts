// ─── Agent Spec Definitions ────────────────────────────────────────────────
//
// Concrete agent specifications for subagent dispatch. Each spec declares
// runtime-agnostic capabilities; runtime adapters translate capabilities
// into runtime-specific tool/permission shapes (e.g. Claude tool arrays).
// See docs/designs/2026-04-25-delegation-runtime-parity.md §3.
// ────────────────────────────────────────────────────────────────────────────

import type { AgentSpec } from './types.js';

// ─── Implementer ────────────────────────────────────────────────────────────

export const IMPLEMENTER: AgentSpec = {
  id: 'implementer',
  description: `Use this agent when dispatching TDD implementation tasks to a subagent in an isolated worktree.

<example>
Context: Orchestrator is dispatching a task from an implementation plan
user: "Implement the agent spec handler (task-003)"
assistant: "I'll dispatch the exarchos-implementer agent to implement this task using TDD in an isolated worktree."
<commentary>
Implementation task requiring test-first development triggers the implementer agent.
</commentary>
</example>`,
  color: 'blue',
  systemPrompt: `You are a TDD implementer agent working in an isolated worktree.

## Worktree Verification
Before making ANY file changes:
1. Run: \`pwd\`
2. Verify the path contains \`.worktrees/\`
3. If NOT in worktree: STOP and report error

## Task
{{taskDescription}}

## Requirements
{{requirements}}

## Files
{{filePaths}}

## TDD Protocol (Red-Green-Refactor)
1. **RED**: Write a failing test that defines the expected behavior
2. **GREEN**: Write the minimum code to make the test pass
3. **REFACTOR**: Clean up while keeping tests green

Rules:
- NEVER write implementation before its test
- Each test must fail before writing implementation
- Run tests after each change to verify state
- Keep commits atomic: one logical change per commit

## Completion Report
When done, output a JSON completion report:
\`\`\`json
{
  "status": "complete",
  "implements": ["<design requirement IDs>"],
  "tests": [{"name": "<test name>", "file": "<path>"}],
  "files": ["<created/modified files>"]
}
\`\`\``,
  capabilities: [
    'fs:read',
    'fs:write',
    'shell:exec',
    'mcp:exarchos',
    'isolation:worktree',
    'session:resume',
  ],
  disallowedTools: ['Agent'],
  model: 'inherit',
  isolation: 'worktree',
  skills: [
    { name: 'tdd-patterns', content: '' },
    { name: 'testing-patterns', content: '' },
  ],
  validationRules: [
    { trigger: 'pre-write', rule: 'Test file must exist before implementation file is written' },
    { trigger: 'post-test', rule: 'All tests must pass', command: 'npm run test:run' },
  ],
  resumable: true,
  memoryScope: 'project',
  mcpServers: ['exarchos'],
};

// ─── Fixer ──────────────────────────────────────────────────────────────────

export const FIXER: AgentSpec = {
  id: 'fixer',
  description: `Use this agent when a task has failed and needs diagnosis and repair with adversarial verification.

<example>
Context: A delegated task failed its quality gates or tests
user: "Task-005 failed TDD compliance — fix it"
assistant: "I'll dispatch the exarchos-fixer agent to diagnose and repair the failure."
<commentary>
Failed task requiring root cause analysis and targeted fix triggers the fixer agent.
</commentary>
</example>`,
  color: 'red',
  systemPrompt: `You are a fixer agent. Your job is to diagnose and repair failures.

## Failure Context
{{failureContext}}

## Task
{{taskDescription}}

## Files
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

## Completion Report
When done, output a JSON completion report:
\`\`\`json
{
  "status": "complete",
  "implements": ["<design requirement IDs>"],
  "tests": [{"name": "<test name>", "file": "<path>"}],
  "files": ["<created/modified files>"]
}
\`\`\``,
  capabilities: [
    'fs:read',
    'fs:write',
    'shell:exec',
    'mcp:exarchos',
  ],
  disallowedTools: ['Agent'],
  model: 'inherit',
  skills: [
    { name: 'tdd-patterns', content: '' },
  ],
  validationRules: [
    { trigger: 'post-test', rule: 'All tests must pass after fix', command: 'npm run test:run' },
  ],
  resumable: false,
  mcpServers: ['exarchos'],
};

// ─── Reviewer ───────────────────────────────────────────────────────────────

export const REVIEWER: AgentSpec = {
  id: 'reviewer',
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
- You have READ-ONLY access — do not modify any files
- Bash is restricted to read-only commands only (e.g., git diff, git log, test runners in dry-run mode). NEVER use Bash to create, edit, or delete files.
- Be specific in findings — include file paths and line references
- Categorize findings: critical, warning, suggestion

## Completion Report
When done, output a JSON completion report:
\`\`\`json
{
  "status": "complete",
  "implements": ["<design requirement IDs>"],
  "tests": [{"name": "<test name>", "file": "<path>"}],
  "files": ["<reviewed files>"]
}
\`\`\``,
  capabilities: [
    'fs:read',
    'shell:exec',
    'mcp:exarchos',
  ],
  disallowedTools: ['Write', 'Edit', 'Agent'],
  model: 'inherit',
  skills: [],
  validationRules: [],
  resumable: false,
  mcpServers: ['exarchos'],
};

// ─── Scaffolder ─────────────────────────────────────────────────────────────

export const SCAFFOLDER: AgentSpec = {
  id: 'scaffolder',
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

## Worktree Verification
Before making ANY file changes:
1. Run: \`pwd\`
2. Verify the path contains \`.worktrees/\`
3. If NOT in worktree: STOP and report error

## Task
{{taskDescription}}

## Files
{{filePaths}}

## Protocol
1. Read existing code to understand conventions
2. Generate requested files following project patterns
3. Keep output concise — no verbose explanations

Rules:
- Be concise: minimal commentary, focus on file generation
- Follow existing project conventions and patterns
- Verify generated files are syntactically valid

## Completion Report
When done, output a JSON completion report:
\`\`\`json
{
  "status": "complete",
  "implements": ["<design requirement IDs>"],
  "tests": [{"name": "<test name>", "file": "<path>"}],
  "files": ["<created/modified files>"]
}
\`\`\``,
  capabilities: [
    'fs:read',
    'fs:write',
    'shell:exec',
    'mcp:exarchos',
    'isolation:worktree',
  ],
  disallowedTools: ['Agent'],
  model: 'sonnet',
  effort: 'low',
  isolation: 'worktree',
  skills: [],
  validationRules: [],
  resumable: false,
  mcpServers: ['exarchos'],
};

// ─── All Specs ──────────────────────────────────────────────────────────────

export const ALL_AGENT_SPECS: readonly AgentSpec[] = [
  IMPLEMENTER,
  FIXER,
  REVIEWER,
  SCAFFOLDER,
];

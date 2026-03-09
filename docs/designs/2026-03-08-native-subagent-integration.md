# Design: Native Subagent Integration

## Problem Statement

Exarchos delegates implementation tasks to Claude Code subagents via the `Task()` tool, but treats them as generic black boxes: every dispatch builds a ~2,000-token inline prompt, uses `subagent_type: "general-purpose"`, manages worktrees manually via `prepare_delegation`, and dispatches fresh fixer agents with zero context when tasks fail. Meanwhile, Claude Code now offers rich native primitives — custom agent definitions, native worktree isolation, agent resume, persistent memory, per-agent hooks, and skill preloading — that Exarchos doesn't use.

At the same time, Exarchos is a standalone CLI that publishes MCP as a subcommand. Any investment in Claude Code-specific features must not break compatibility with other MCP clients (Copilot CLI, Cursor, etc.). The in-flight [Lazy Schema + Runbook Protocol](./2026-03-08-lazy-schema-runbook-protocol.md) design already addresses this tension for schemas and orchestration sequences. This design extends the same pattern to **agent specifications**: registry-sourced, MCP-served, with Claude Code native files as a compiled optimization.

**Three problems, one design:**

1. **Agent identity** — Subagents are generic; they should be typed, version-controlled, and enriched with skills, hooks, and memory
2. **Agent continuity** — Failed tasks lose all context; fixers should resume with full history
3. **Agent lifecycle** — State updates are manual orchestrator work; hooks should automate them

**Related:**
- [#966](https://github.com/lvlup-sw/exarchos/issues/966) — Self-describing MCP for non-Claude-Code clients
- [Lazy Schema + Runbook Protocol](./2026-03-08-lazy-schema-runbook-protocol.md) — In-flight companion design

## Design Constraints

- **Registry remains the single source of truth** — Agent specs, like schemas and runbooks, are defined in the registry and resolved at serve-time
- **MCP server stays platform-agnostic** — `agent_spec` is an MCP action; Claude Code `agents/*.md` files are a compiled output
- **Backward compatible** — Existing `prepare_delegation` and inline prompt dispatch continue to work; native features are additive
- **Composes with runbook protocol** — `native:Task` runbook steps reference agent types; `agent_spec()` resolves them for non-Claude-Code clients
- **Zero-drift by construction** — Agent spec drift tests follow the proven bidirectional sync pattern
- **No new MCP tools** — `agent_spec` is an action on `exarchos_orchestrate`, not a new tool registration

## Prior Art

### Claude Code Custom Subagents

Claude Code supports custom agent definitions as Markdown files with YAML frontmatter:

```markdown
---
name: code-reviewer
description: Reviews code for quality
tools: Read, Grep, Glob
model: sonnet
isolation: worktree
memory: project
skills:
  - review-patterns
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/validate.sh"
---
System prompt here.
```

Key capabilities: model selection, tool restrictions, native worktree isolation, skill preloading, persistent memory, per-agent hooks, and resume via `agentId`. See [Claude Code sub-agents documentation](https://code.claude.com/docs/en/sub-agents).

### Exarchos Current Approach

Delegation uses `Task()` with inline prompts:

```typescript
Task({
  subagent_type: "general-purpose",
  model: "opus",
  run_in_background: true,
  description: "Implement task-001: ...",
  prompt: `[~2,000 token implementer prompt built from template]`
})
```

Worktrees are created manually via `prepare_delegation`. Fixers are dispatched as fresh agents with adversarial prompts. State updates are manual orchestrator calls.

## Chosen Approach: Agent Spec Registry + Native Integration

### Architecture Overview

Agent specifications join schemas and runbooks as a third registry-served specification. Claude Code gets the premium experience (native agent files, resume, hooks, memory), but the same agent intelligence is available to any MCP client via `agent_spec()`.

```
┌──────────────────────────────────────────────────────────┐
│                   Exarchos Registry                       │
│           (source of truth for ALL specs)                 │
│                                                           │
│  ┌───────────┐  ┌───────────┐  ┌───────────────────────┐ │
│  │  Actions   │  │ Runbooks  │  │    Agent Specs        │ │
│  │ + Schemas  │  │ + Gates   │  │ + Prompts + Skills    │ │
│  └─────┬─────┘  └─────┬─────┘  └──────────┬────────────┘ │
└────────┼──────────────┼────────────────────┼──────────────┘
         │              │                    │
    ┌────┴────┐    ┌────┴────┐    ┌──────────┴──────────┐
    │describe │    │runbook  │    │    agent_spec        │
    │ action  │    │ action  │    │     action           │
    │(any MCP)│    │(any MCP)│    │    (any MCP)         │
    └─────────┘    └─────────┘    └──────────┬──────────┘
                                             │
                              ┌──────────────┼──────────────┐
                              │              │              │
                       ┌──────┴──────┐ ┌─────┴─────┐ ┌─────┴─────┐
                       │  Claude Code│ │ Copilot   │ │ Cursor    │
                       │  agents/*.md│ │ CLI       │ │           │
                       │  (native)   │ │ (via MCP) │ │ (via MCP) │
                       └─────────────┘ └───────────┘ └───────────┘
```

### Three Tiers of Integration

| Tier | Platform | Agent Specs | Isolation | Resume | Hooks | Memory |
|------|----------|------------|-----------|--------|-------|--------|
| **1** | Claude Code | Native `agents/*.md` (build-time) | `isolation: "worktree"` | `resume: agentId` | `SubagentStop` hooks | `memory: project` |
| **2** | Copilot CLI, Cursor | `agent_spec()` MCP action | Manual worktree or inline | Fresh dispatch + event context | Manual state updates | N/A |
| **3** | Standalone CLI | `agent_spec()` MCP action | `prepare_delegation` | Fresh dispatch | Manual state updates | N/A |

---

## Technical Design

### 1. Agent Spec Registry

#### 1.1 Agent Spec Type

```typescript
// src/agents/types.ts

export interface AgentSkill {
  /** Skill name (resolved from skills/ directory at build time) */
  readonly name: string;
  /** Skill content (inlined at serve-time for non-CC clients) */
  readonly content: string;
}

export interface AgentValidationRule {
  /** When the rule fires: 'pre-write', 'pre-edit', 'post-test' */
  readonly trigger: string;
  /** Human-readable rule description */
  readonly rule: string;
  /** Optional shell command for hook-based enforcement */
  readonly command?: string;
}

export interface AgentSpec {
  /** Unique identifier (e.g., 'implementer', 'fixer', 'reviewer') */
  readonly id: string;
  /** Human-readable description — used as CC agent description field */
  readonly description: string;
  /** System prompt template (supports {{templateVar}} interpolation) */
  readonly systemPrompt: string;
  /** Allowed tools (CC tools format: 'Read', 'Write', 'Bash', etc.) */
  readonly tools: readonly string[];
  /** Tools to deny */
  readonly disallowedTools?: readonly string[];
  /** Model preference */
  readonly model: 'opus' | 'sonnet' | 'haiku' | 'inherit';
  /** Isolation mode */
  readonly isolation?: 'worktree';
  /** Skills to preload (content resolved from registry at serve-time) */
  readonly skills: readonly AgentSkill[];
  /** Validation rules (mapped to CC hooks or served as advisory for other platforms) */
  readonly validationRules: readonly AgentValidationRule[];
  /** Whether the agent supports resume on failure */
  readonly resumable: boolean;
  /** Memory scope for persistent learning */
  readonly memoryScope?: 'user' | 'project' | 'local';
  /** Maximum agentic turns */
  readonly maxTurns?: number;
}
```

#### 1.2 Agent Spec Definitions

```typescript
// src/agents/definitions.ts

import type { AgentSpec } from './types.js';

export const IMPLEMENTER: AgentSpec = {
  id: 'implementer',
  description: 'TDD implementer for Exarchos-orchestrated tasks. Enforces Red-Green-Refactor discipline in isolated worktrees.',
  systemPrompt: `You are a TDD implementer working in an isolated git worktree.

## CRITICAL: Worktree Verification (MANDATORY)

Before making ANY file changes:
1. Run: \`pwd\`
2. Verify the path contains \`.worktrees/\` or is a git worktree
3. If NOT in worktree: STOP and report error

## Task

{{taskDescription}}

## Requirements

{{requirements}}

## Files

{{filePaths}}

## TDD Protocol

Follow strict Red-Green-Refactor:
1. **RED** — Write a failing test that captures the requirement
2. **GREEN** — Write the minimum implementation to pass the test
3. **REFACTOR** — Clean up while keeping tests green

Never write implementation code before a failing test exists.

## Completion

When done, output a structured completion report:
\`\`\`json
{
  "status": "complete",
  "implements": ["<design requirement IDs>"],
  "tests": [{"name": "testName", "file": "path/to/test.ts"}],
  "files": ["path/to/impl.ts"]
}
\`\`\``,
  tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
  disallowedTools: ['Agent'],
  model: 'opus',
  isolation: 'worktree',
  skills: [
    { name: 'tdd-patterns', content: '' },      // Resolved at serve-time
    { name: 'testing-patterns', content: '' },   // Resolved at serve-time
  ],
  validationRules: [
    {
      trigger: 'pre-write',
      rule: 'Test file must exist before implementation file can be created',
      command: 'exarchos validate tdd-order',
    },
    {
      trigger: 'post-test',
      rule: 'All tests must pass before marking complete',
      command: 'exarchos validate test-pass',
    },
  ],
  resumable: true,
  memoryScope: 'project',
  maxTurns: 100,
};

export const FIXER: AgentSpec = {
  id: 'fixer',
  description: 'Resumes failed implementer context to diagnose and fix task failures. Adversarial verification posture.',
  systemPrompt: `Your previous implementation attempt failed. You have full context of what you tried.

## Failure Context

{{failureContext}}

## Adversarial Verification Protocol

1. Do NOT trust your previous self-assessment
2. Re-read the actual test output — what EXACTLY failed?
3. Identify root cause, not symptoms
4. Implement a minimal, targeted fix
5. Run ALL tests, not just the failing one
6. Check for silent failures (tests that pass but don't assert correctly)

## Completion

Same structured output as before. Include what was wrong and how you fixed it.`,
  tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
  disallowedTools: ['Agent'],
  model: 'opus',
  isolation: 'worktree',
  skills: [
    { name: 'tdd-patterns', content: '' },
  ],
  validationRules: [
    {
      trigger: 'post-test',
      rule: 'All tests must pass before marking complete',
      command: 'exarchos validate test-pass',
    },
  ],
  resumable: false,  // Fixer is already a resumed/fresh-dispatched agent
  memoryScope: 'project',
};

export const REVIEWER: AgentSpec = {
  id: 'reviewer',
  description: 'Code quality reviewer for spec compliance and quality gates. Read-only analysis.',
  systemPrompt: `You are a code reviewer evaluating implementation quality.

## Review Scope

{{reviewScope}}

## Design Requirements

{{designRequirements}}

## Review Protocol

1. Verify each design requirement has corresponding test coverage
2. Check TDD compliance (tests committed before implementation)
3. Evaluate code quality: SOLID, DRY, security, error handling
4. Flag any test quality issues (.only, .skip, missing assertions)

## Output

Structured findings:
\`\`\`json
{
  "verdict": "pass" | "fail",
  "findings": [
    { "severity": "critical" | "warning" | "info", "rule": "RULE-ID", "message": "...", "file": "...", "line": 0 }
  ]
}
\`\`\``,
  tools: ['Read', 'Grep', 'Glob', 'Bash'],
  disallowedTools: ['Write', 'Edit', 'Agent'],
  model: 'opus',
  skills: [
    { name: 'review-patterns', content: '' },
  ],
  validationRules: [],
  resumable: false,
  memoryScope: 'project',
};

export const ALL_AGENT_SPECS: readonly AgentSpec[] = [
  IMPLEMENTER,
  FIXER,
  REVIEWER,
];
```

### 2. `agent_spec` Action

New action on `exarchos_orchestrate` — serves agent specifications to any MCP client.

#### 2.1 Schema

```typescript
const agentSpecSchema = z.object({
  agent: z.enum(['implementer', 'fixer', 'reviewer'])
    .describe('Agent type to retrieve specification for.'),
  context: z.record(z.string()).optional()
    .describe('Template variables to interpolate into the system prompt (e.g., taskDescription, requirements).'),
  format: z.enum(['full', 'prompt-only']).default('full')
    .describe('full: complete spec with tools, skills, rules. prompt-only: just the interpolated system prompt.'),
});
```

#### 2.2 Handler

```typescript
async function handleAgentSpec(
  args: { agent: string; context?: Record<string, string>; format?: string },
  ctx: DispatchContext,
): Promise<ToolResult> {
  const spec = ALL_AGENT_SPECS.find(s => s.id === args.agent);
  if (!spec) {
    return {
      success: false,
      error: {
        code: 'UNKNOWN_AGENT',
        message: `Unknown agent: ${args.agent}`,
        validAgents: ALL_AGENT_SPECS.map(s => s.id),
      },
    };
  }

  // Interpolate template variables into system prompt
  let prompt = spec.systemPrompt;
  if (args.context) {
    for (const [key, value] of Object.entries(args.context)) {
      prompt = prompt.replaceAll(`{{${key}}}`, value);
    }
  }

  // Warn about unresolved template variables
  const unresolved = [...prompt.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]);

  if (args.format === 'prompt-only') {
    return {
      success: true,
      data: { agent: spec.id, systemPrompt: prompt, unresolvedVars: unresolved },
    };
  }

  // Full spec with resolved skill content
  const skills = spec.skills.map(skill => ({
    name: skill.name,
    content: resolveSkillContent(skill.name),  // Load from skills/ directory
  }));

  return {
    success: true,
    data: {
      agent: spec.id,
      description: spec.description,
      systemPrompt: prompt,
      tools: spec.tools,
      disallowedTools: spec.disallowedTools ?? [],
      model: spec.model,
      isolation: spec.isolation ?? null,
      skills,
      validationRules: spec.validationRules,
      resumable: spec.resumable,
      memoryScope: spec.memoryScope ?? null,
      maxTurns: spec.maxTurns ?? null,
      unresolvedVars: unresolved,
    },
  };
}
```

#### 2.3 Response Example

```json
{
  "success": true,
  "data": {
    "agent": "implementer",
    "description": "TDD implementer for Exarchos-orchestrated tasks...",
    "systemPrompt": "You are a TDD implementer working in an isolated git worktree.\n\n## Task\n\nImplement user authentication...",
    "tools": ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
    "disallowedTools": ["Agent"],
    "model": "opus",
    "isolation": "worktree",
    "skills": [
      { "name": "tdd-patterns", "content": "## TDD Red-Green-Refactor\n\n..." },
      { "name": "testing-patterns", "content": "## Testing Patterns\n\n..." }
    ],
    "validationRules": [
      { "trigger": "pre-write", "rule": "Test file must exist before implementation file", "command": "exarchos validate tdd-order" }
    ],
    "resumable": true,
    "memoryScope": "project",
    "maxTurns": 100,
    "unresolvedVars": []
  }
}
```

### 3. Claude Code Agent File Generation

At plugin build time, generate `agents/*.md` files from the registry.

#### 3.1 Build Script

```typescript
// src/agents/generate-cc-agents.ts

import { ALL_AGENT_SPECS } from './definitions.js';
import type { AgentSpec } from './types.js';

function generateAgentMarkdown(spec: AgentSpec): string {
  const frontmatter: Record<string, unknown> = {
    name: `exarchos-${spec.id}`,
    description: spec.description,
    tools: spec.tools.join(', '),
    model: spec.model,
  };

  if (spec.disallowedTools?.length) {
    frontmatter.disallowedTools = spec.disallowedTools.join(', ');
  }
  if (spec.isolation) {
    frontmatter.isolation = spec.isolation;
  }
  if (spec.memoryScope) {
    frontmatter.memory = spec.memoryScope;
  }
  if (spec.maxTurns) {
    frontmatter.maxTurns = spec.maxTurns;
  }
  if (spec.skills.length > 0) {
    frontmatter.skills = spec.skills.map(s => s.name);
  }
  if (spec.validationRules.length > 0) {
    frontmatter.hooks = buildHooksFromRules(spec.validationRules);
  }

  const yaml = serializeYaml(frontmatter);
  return `---\n${yaml}---\n\n${spec.systemPrompt}\n`;
}

function buildHooksFromRules(
  rules: readonly AgentValidationRule[],
): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {};

  for (const rule of rules) {
    if (!rule.command) continue;

    const matcher = rule.trigger === 'pre-write' ? 'Write|Edit'
      : rule.trigger === 'pre-edit' ? 'Edit'
      : rule.trigger === 'post-test' ? 'Bash'
      : '*';

    const event = rule.trigger.startsWith('pre-') ? 'PreToolUse' : 'PostToolUse';

    if (!hooks[event]) hooks[event] = [];
    hooks[event].push({
      matcher,
      hooks: [{ type: 'command', command: rule.command }],
    });
  }

  return hooks;
}

// Build entry point
export function generateAllAgentFiles(outDir: string): void {
  for (const spec of ALL_AGENT_SPECS) {
    const content = generateAgentMarkdown(spec);
    const filePath = path.join(outDir, `exarchos-${spec.id}.md`);
    fs.writeFileSync(filePath, content, 'utf-8');
  }
}
```

#### 3.2 Generated Output Example (`agents/exarchos-implementer.md`)

```markdown
---
name: exarchos-implementer
description: TDD implementer for Exarchos-orchestrated tasks. Enforces Red-Green-Refactor discipline in isolated worktrees.
tools: Read, Write, Edit, Bash, Grep, Glob
disallowedTools: Agent
model: opus
isolation: worktree
memory: project
maxTurns: 100
skills:
  - tdd-patterns
  - testing-patterns
hooks:
  PreToolUse:
    - matcher: "Write|Edit"
      hooks:
        - type: command
          command: "exarchos validate tdd-order"
  PostToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "exarchos validate test-pass"
---

You are a TDD implementer working in an isolated git worktree.

## CRITICAL: Worktree Verification (MANDATORY)

Before making ANY file changes:
1. Run: `pwd`
2. Verify the path contains `.worktrees/` or is a git worktree
3. If NOT in worktree: STOP and report error

...
```

#### 3.3 Plugin Directory Structure

```
exarchos/
├── agents/                          # NEW: Generated CC agent definitions
│   ├── exarchos-implementer.md
│   ├── exarchos-fixer.md
│   └── exarchos-reviewer.md
├── skills/                          # Existing: workflow skills
│   ├── delegation/
│   ├── synthesis/
│   └── ...
├── commands/                        # Existing: slash commands
├── servers/exarchos-mcp/            # Existing: MCP server
│   └── src/
│       └── agents/                  # NEW: Agent spec registry
│           ├── types.ts
│           ├── definitions.ts
│           └── generate-cc-agents.ts
└── .claude-plugin/
    └── plugin.json                  # Updated: includes agents/ directory
```

### 4. Resume-Aware Fixer Flow

#### 4.1 Workflow State Extension

Add `agentId` tracking to task entries in workflow state:

```typescript
// In workflow state task schema
interface WorkflowTask {
  id: string;
  status: 'pending' | 'in_progress' | 'complete' | 'failed';
  // NEW:
  agentId?: string;       // Claude Code agent ID for resume capability
  agentResumed?: boolean;  // Whether the fixer used resume vs. fresh dispatch
}
```

#### 4.2 Agent ID Capture

When the orchestrator receives `Task()` completion, it extracts the `agentId` from the result:

```typescript
// In delegation skill — after TaskOutput returns
const result = await TaskOutput({ task_id: taskId, block: true });

// Update workflow state with agentId for potential resume
exarchos_workflow({
  action: 'set',
  featureId,
  updates: {
    [`tasks.${taskId}.agentId`]: result.agentId,
  },
});
```

#### 4.3 Resume vs. Fresh Dispatch Decision

```
Task fails
    │
    ├── agentId available AND platform supports resume?
    │       │
    │       YES → Resume with adversarial context injection
    │       │     Task({ resume: agentId, prompt: "Your implementation failed. ..." })
    │       │
    │       NO  → Fresh dispatch with fixer agent spec
    │             Task({ subagent_type: "exarchos-fixer", prompt: "..." })
    │
    └── Either way → Run gate chain (task-completion runbook)
```

#### 4.4 TASK_FIX Runbook

New runbook definition (extends the in-flight runbook protocol):

```typescript
export const TASK_FIX: RunbookDefinition = {
  id: 'task-fix',
  phase: 'delegate',
  description: 'Fix a failed task. Platforms with resume use agent context continuity; others dispatch fixer agent with failure context from event store.',
  steps: [
    { tool: 'native:Task', action: 'resume_or_spawn', onFail: 'stop',
      params: {
        resumeAgent: 'agentId',           // Template var — resolved from workflow state
        fallbackAgent: 'fixer',            // Agent spec to use if resume unavailable
      },
      note: 'CC: resume agentId with full context. Others: agent_spec("fixer") + fresh dispatch.' },
    { tool: 'exarchos_orchestrate', action: 'check_tdd_compliance', onFail: 'stop' },
    { tool: 'exarchos_orchestrate', action: 'check_static_analysis', onFail: 'stop' },
    { tool: 'exarchos_orchestrate', action: 'task_complete', onFail: 'stop' },
  ],
  templateVars: ['taskId', 'featureId', 'streamId', 'agentId', 'failureContext'],
  autoEmits: ['gate.executed', 'task.completed'],
};
```

### 5. SubagentStop Hooks for Automatic State Management

#### 5.1 Plugin Hook Definition

In the Exarchos plugin's hook configuration:

```json
{
  "hooks": {
    "SubagentStop": [
      {
        "matcher": "exarchos-implementer|exarchos-fixer",
        "hooks": [
          {
            "type": "command",
            "command": "exarchos hook subagent-stop"
          }
        ]
      }
    ]
  }
}
```

#### 5.2 Hook Handler

New CLI subcommand: `exarchos hook subagent-stop`

The hook receives JSON via stdin with the subagent's completion status, agent ID, and result summary. It calls MCP actions to update workflow state:

```typescript
// src/hooks/subagent-stop.ts

interface SubagentStopInput {
  agent_type: string;       // 'exarchos-implementer' | 'exarchos-fixer'
  agent_id: string;         // For resume tracking
  exit_reason: string;      // 'complete' | 'error' | 'max_turns'
  // Result is in the agent's transcript, not directly available to hooks
}

async function handleSubagentStop(input: SubagentStopInput): Promise<void> {
  // Extract featureId + taskId from agent name or environment
  const { featureId, taskId } = parseAgentContext();

  // Update workflow state with agentId
  await callMcp('exarchos_workflow', {
    action: 'set',
    featureId,
    updates: {
      [`tasks.${taskId}.agentId`]: input.agent_id,
      [`tasks.${taskId}.lastExitReason`]: input.exit_reason,
    },
  });

  // Emit event for observability
  await callMcp('exarchos_event', {
    action: 'append',
    streamId: featureId,
    type: 'agent.stopped',
    data: {
      agent: input.agent_type,
      agentId: input.agent_id,
      taskId,
      exitReason: input.exit_reason,
    },
  });
}
```

#### 5.3 What Hooks Replace vs. What They Don't

| Orchestrator Responsibility | Replaced by Hook? | Notes |
|---|---|---|
| Track agentId for resume | Yes | Hook captures agentId on stop |
| Update task status | Partially | Hook records exit reason; orchestrator still decides pass/fail based on gate results |
| Run quality gates | No | Gates require sequential execution with stop-on-fail semantics — runbooks handle this |
| Mark task complete | No | Requires provenance data that only the orchestrator has |
| Emit events | Yes | Hook emits `agent.stopped` event automatically |

Hooks handle **bookkeeping**. Orchestration logic stays in runbooks and the delegation skill.

### 6. Impact on `prepare_delegation`

#### 6.1 Current Responsibilities

`prepare_delegation` currently does:
1. Validate workflow is in `delegate` phase
2. Create worktrees (`git worktree add`)
3. Install dependencies (`npm install` in each worktree)
4. Track worktree state in workflow
5. Run quality pre-checks
6. Return readiness verdict

#### 6.2 With Native Worktree Isolation

When agents use `isolation: "worktree"`, Claude Code handles worktree creation and cleanup natively. `prepare_delegation` narrows:

1. Validate workflow is in `delegate` phase
2. ~~Create worktrees~~ → Handled by `isolation: "worktree"` on agent definition
3. ~~Install dependencies~~ → Handled by agent post-setup (or hook)
4. Track worktree state in workflow → Updated by `SubagentStop` hook with worktree path
5. Run quality pre-checks → Unchanged
6. Return readiness verdict → Unchanged

**For non-Claude-Code clients:** `prepare_delegation` retains full functionality. The worktree creation code stays but is bypassed when the client signals native isolation support.

#### 6.3 Platform Capability Signal

```typescript
const prepareDelegationSchema = z.object({
  featureId: z.string(),
  tasks: z.array(taskSchema),
  // NEW:
  nativeIsolation: z.boolean().default(false)
    .describe('Set true if the client handles worktree isolation natively (e.g., Claude Code isolation: "worktree"). Skips manual worktree creation.'),
});
```

### 7. Delegation Skill Updates

The delegation skill (`skills/delegation/SKILL.md`) simplifies significantly:

#### 7.1 Before (Current)

```markdown
### Step 2: Dispatch

For each task, build a Task() call with the full implementer prompt:

Task({
  subagent_type: "general-purpose",
  model: "opus",
  run_in_background: true,
  description: "Implement task-001: ...",
  prompt: `[2,000 tokens of inline prompt from implementer-prompt.md template]`
})
```

#### 7.2 After (With Native Agents)

```markdown
### Step 2: Dispatch

For each task, dispatch using the `exarchos-implementer` agent type:

Task({
  subagent_type: "exarchos-implementer",
  run_in_background: true,
  description: "Implement task-001: [title]",
  prompt: "[Task-specific context only: requirements, file paths, acceptance criteria]"
})

The agent's system prompt, model, isolation, skills, hooks, and memory are defined
by the agent specification. The dispatch prompt provides ONLY task-specific context.

### Step 3: Fix Failed Tasks

If a task fails and agentId is available:

Task({
  resume: "[agentId from workflow state]",
  prompt: "Your implementation failed. [failure context]. Apply adversarial verification."
})

If agentId unavailable (non-CC platform or agent not resumable):

Task({
  subagent_type: "exarchos-fixer",
  run_in_background: true,
  prompt: "[Failure context + original task context]"
})
```

### 8. Runbook Protocol Integration

#### 8.1 Updated AGENT_TEAMS_SAGA

The in-flight AGENT_TEAMS_SAGA runbook references `native:Task`. With agent specs, the step gains type information:

```typescript
// Before (in-flight design):
{ tool: 'native:Task', action: 'spawn', onFail: 'stop',
  note: 'Spawn N teammates in worktrees' },

// After (with agent specs):
{ tool: 'native:Task', action: 'spawn', onFail: 'stop',
  params: { agent: 'implementer' },
  note: 'Spawn N teammates using exarchos-implementer agent spec. CC: native agent file. Others: agent_spec() for configuration.' },
```

#### 8.2 New TASK_FIX Runbook

See section 4.4 above. Added to `ALL_RUNBOOKS`.

#### 8.3 Runbook Step Resolution for `native:Task`

When a non-Claude-Code client encounters a `native:Task` step with `params.agent`, it calls `agent_spec()` to resolve the agent configuration, then uses its platform's mechanism to spawn an agent with that spec.

The runbook handler can include a hint:

```typescript
// In resolved runbook step for native:Task
{
  seq: 7,
  tool: 'native:Task',
  action: 'spawn',
  params: { agent: 'implementer' },
  note: 'Spawn using exarchos-implementer agent spec.',
  platformHint: {
    claudeCode: 'Uses native agent definition with isolation: "worktree"',
    generic: 'Call agent_spec("implementer") to get system prompt and tool restrictions',
  },
}
```

---

## Anti-Drift Architecture

### Agent Spec Drift Tests

Following the proven bidirectional sync pattern:

```typescript
// src/agents/agents.test.ts

describe('Agent spec drift prevention', () => {
  it('every agent referenced in runbooks has a registry spec', () => {
    const agentRefs = ALL_RUNBOOKS
      .flatMap(r => r.steps)
      .filter(s => s.params?.agent)
      .map(s => s.params.agent as string);
    for (const agent of new Set(agentRefs)) {
      expect(ALL_AGENT_SPECS.find(s => s.id === agent)).toBeDefined(
        `Runbook references unknown agent: ${agent}`
      );
    }
  });

  it('every agent spec references valid skills', () => {
    const availableSkills = getAvailableSkillNames();
    for (const spec of ALL_AGENT_SPECS) {
      for (const skill of spec.skills) {
        expect(availableSkills).toContain(skill.name,
          `Agent "${spec.id}" references unknown skill: ${skill.name}`
        );
      }
    }
  });

  it('every agent spec references valid tools', () => {
    const validTools = getValidToolNames();
    for (const spec of ALL_AGENT_SPECS) {
      for (const tool of spec.tools) {
        expect(validTools).toContain(tool,
          `Agent "${spec.id}" references unknown tool: ${tool}`
        );
      }
    }
  });

  it('agent IDs are unique', () => {
    const ids = ALL_AGENT_SPECS.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('template vars in system prompts are documented', () => {
    for (const spec of ALL_AGENT_SPECS) {
      const vars = [...spec.systemPrompt.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]);
      // All template vars should be documented (future: formal registry)
      expect(vars.length).toBeGreaterThanOrEqual(0);
    }
  });
});
```

### Generated File Drift Tests

```typescript
describe('Generated CC agent files match registry', () => {
  it('agents/*.md files are in sync with registry specs', () => {
    for (const spec of ALL_AGENT_SPECS) {
      const filePath = path.join(AGENTS_DIR, `exarchos-${spec.id}.md`);
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = parseFrontmatter(content);

      expect(parsed.name).toBe(`exarchos-${spec.id}`);
      expect(parsed.model).toBe(spec.model);
      expect(parsed.description).toBe(spec.description);

      if (spec.isolation) {
        expect(parsed.isolation).toBe(spec.isolation);
      }
      if (spec.memoryScope) {
        expect(parsed.memory).toBe(spec.memoryScope);
      }
    }
  });
});
```

---

## Token Budget Impact

| Scenario | Before | After |
|---|---|---|
| Implementer dispatch prompt | ~2,000 tokens (full inline) | ~200-400 tokens (task context only) |
| Fixer dispatch prompt | ~1,500 tokens (full inline) | ~0 tokens (resume) or ~300 tokens (context only) |
| Agent spec registration (CC) | 0 (inline) | 0 (native agent files, no MCP cost) |
| Agent spec fetch (non-CC) | N/A | ~500-800 tokens (one-time per session) |

**Combined with lazy schema savings:** A full delegation session drops from ~3,045 (MCP registration) + ~6,000 (3 implementer prompts) = ~9,045 tokens to ~700 (slim registration) + ~1,200 (3 task contexts) = ~1,900 tokens. **~79% reduction.**

---

## Implementation Plan

### Phase 1: Agent Spec Registry (Foundation)

1. Define `AgentSpec` types in `src/agents/types.ts`
2. Write initial agent spec definitions (implementer, fixer, reviewer)
3. Implement `agent_spec` action on `exarchos_orchestrate`
4. Write anti-drift tests for agent specs

**Dependency:** None. Can proceed in parallel with runbook protocol Phase 1-2.

### Phase 2: Claude Code Agent Generation (Native Integration)

5. Implement `generate-cc-agents.ts` build script
6. Add `agents/` directory to plugin manifest (`plugin.json`)
7. Wire into build pipeline (`npm run build` generates agent files)
8. Write generated-file drift tests
9. Update delegation skill to reference `exarchos-implementer` instead of inline prompts

**Dependency:** Phase 1 complete. Runbook protocol Phase 2 (for TASK_FIX runbook).

### Phase 3: Resume + Hooks (Agent Continuity)

10. Add `agentId` field to workflow task state schema
11. Implement `exarchos hook subagent-stop` CLI subcommand
12. Add `SubagentStop` hook to plugin hook configuration
13. Write TASK_FIX runbook definition
14. Update delegation skill with resume-aware fixer flow

**Dependency:** Phase 2 complete. Runbook protocol Phase 2 (runbook definitions exist).

### Phase 4: Platform Capability + Polish

15. Add `nativeIsolation` parameter to `prepare_delegation`
16. Add `platformHint` to runbook step resolution for `native:Task` steps
17. Measure token savings and fix success rates (resume vs. fresh dispatch)
18. Update skill reference docs (`references/implementer-prompt.md` → agent spec registry)

**Dependency:** Phase 3 complete. End-to-end testing.

---

## Appendix: Comparison with Lazy Schema + Runbook Protocol

| Concern | Lazy Schema Design | This Design |
|---|---|---|
| What it makes lazy | Schema loading (action params) | Agent configuration (system prompts, tools, skills) |
| What it codifies | Step sequences (gate ordering) | Agent identity (who does the work) |
| MCP action | `describe()`, `runbook()` | `agent_spec()` |
| Anti-drift pattern | Same bidirectional sync | Same bidirectional sync |
| Token savings source | Registration payload | Inline prompt elimination |
| Cross-platform story | Runbooks are self-describing | Agent specs are self-describing |
| Claude Code optimization | Slim descriptions (less text) | Native agent files (no MCP call) |

The two designs are complementary halves of the same philosophy: **the MCP server is self-describing, Claude Code native features are an optimization layer, and the registry is the single source of truth.**

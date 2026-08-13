// GENERATED FILE — DO NOT EDIT. Regenerate via `npm run codegen:runtimes`.
// Source: runtimes/*.yaml (validated against RuntimeMapSchema).
// Drift is enforced by `npm run runtimes:guard` (CI).
import type { RuntimeMap } from './types.js';

const RAW_RUNTIMES = [
  {
    "name": "generic",
    "capabilities": {
      "hasSubagents": false,
      "hasSlashCommands": false,
      "hooks": {
        "profile": "none",
        "canInjectContext": false,
        "sessionStartEvent": null,
        "sessionEndEvent": null
      },
      "hasSkillChaining": false,
      "mcpPrefix": "mcp__exarchos__"
    },
    "preferredFacade": "cli",
    "skillsInstallPath": "~/.agents/skills",
    "detection": {
      "binaries": [],
      "envVars": []
    },
    "placeholders": {
      "MCP_PREFIX": "mcp__exarchos__",
      "COMMAND_PREFIX": "",
      "TASK_TOOL": "[sequential execution]",
      "CHAIN": "[Invoke the exarchos:{{next}} skill with args: {{args}}]",
      "SPAWN_AGENT_CALL": "Execute each task sequentially in the current session, one at a time, against the prepared worktrees.",
      "SUBAGENT_COMPLETION_HOOK": "in-session checkpoint (no subagent channel)",
      "SUBAGENT_RESULT_API": "[task output is the assistant's next message]"
    }
  },
  {
    "name": "claude",
    "capabilities": {
      "hasSubagents": true,
      "hasSlashCommands": true,
      "hooks": {
        "profile": "claude-json",
        "canInjectContext": true,
        "sessionStartEvent": "SessionStart",
        "sessionEndEvent": "SessionEnd",
        "subagentStopEvent": "SubagentStop"
      },
      "hasSkillChaining": true,
      "mcpPrefix": "mcp__plugin_exarchos_exarchos__"
    },
    "preferredFacade": "mcp",
    "skillsInstallPath": "~/.claude/skills",
    "detection": {
      "binaries": [
        "claude"
      ],
      "envVars": [
        "CLAUDECODE",
        "CLAUDE_CODE_ENTRYPOINT"
      ]
    },
    "placeholders": {
      "MCP_PREFIX": "mcp__plugin_exarchos_exarchos__",
      "COMMAND_PREFIX": "/exarchos:",
      "TASK_TOOL": "Task",
      "CHAIN": "Skill({ skill: \"exarchos:{{next}}\", args: \"{{args}}\" })",
      "SPAWN_AGENT_CALL": "Task({\n  subagent_type: \"exarchos-{{agent}}\",\n  run_in_background: true,\n  description: \"{{description}}\",\n  prompt: \"{{prompt}}\"\n})\n",
      "SUBAGENT_COMPLETION_HOOK": "TeammateIdle hook",
      "SUBAGENT_RESULT_API": "TaskOutput({ task_id, block: true })"
    },
    "supportedCapabilities": {
      "fs:read": "native",
      "fs:write": "native",
      "shell:exec": "native",
      "subagent:spawn": "native",
      "subagent:completion-signal": "native",
      "subagent:start-signal": "native",
      "mcp:exarchos": "native",
      "mcp:exarchos:readonly": "native",
      "isolation:worktree": "native",
      "team:agent-teams": "native",
      "session:resume": "native"
    }
  },
  {
    "name": "codex",
    "capabilities": {
      "hasSubagents": true,
      "hasSlashCommands": true,
      "hooks": {
        "profile": "claude-json",
        "canInjectContext": true,
        "sessionStartEvent": "SessionStart",
        "sessionEndEvent": "Stop"
      },
      "hasSkillChaining": false,
      "mcpPrefix": "mcp__exarchos__"
    },
    "preferredFacade": "mcp",
    "skillsInstallPath": "$HOME/.agents/skills",
    "detection": {
      "binaries": [
        "codex"
      ],
      "envVars": []
    },
    "placeholders": {
      "MCP_PREFIX": "mcp__exarchos__",
      "COMMAND_PREFIX": "",
      "TASK_TOOL": "spawn_agent",
      "CHAIN": "[Invoke the exarchos:{{next}} skill with args: {{args}}]",
      "SPAWN_AGENT_CALL": "spawn_agent({\n  agent_type: \"default\",\n  message: \"{{description}}\\n\\n{{prompt}}\"\n})\n",
      "SUBAGENT_COMPLETION_HOOK": "subagent completion signal (poll-based)",
      "SUBAGENT_RESULT_API": "wait_agent({ task_id })"
    },
    "supportedCapabilities": {
      "fs:read": "native",
      "fs:write": "native",
      "shell:exec": "native",
      "subagent:spawn": "native",
      "mcp:exarchos": "native",
      "mcp:exarchos:readonly": "native",
      "isolation:worktree": "advisory",
      "session:resume": "advisory"
    }
  },
  {
    "name": "opencode",
    "capabilities": {
      "hasSubagents": true,
      "hasSlashCommands": true,
      "hooks": {
        "profile": "opencode-plugin",
        "canInjectContext": false,
        "sessionStartEvent": "session.created",
        "sessionEndEvent": "session.idle"
      },
      "hasSkillChaining": false,
      "mcpPrefix": "mcp__exarchos__",
      "canonicalCommandAliases": true
    },
    "preferredFacade": "cli",
    "skillsInstallPath": "~/.config/opencode/skills",
    "commandsInstallPath": "~/.config/opencode/commands",
    "detection": {
      "binaries": [
        "opencode"
      ],
      "envVars": []
    },
    "placeholders": {
      "MCP_PREFIX": "mcp__exarchos__",
      "COMMAND_PREFIX": "/",
      "TASK_TOOL": "Task",
      "CHAIN": "[Invoke the exarchos:{{next}} skill with args: {{args}}]",
      "SPAWN_AGENT_CALL": "Task({\n  subagent_type: \"{{agent}}\",\n  prompt: \"{{prompt}}\"\n})\n",
      "SUBAGENT_COMPLETION_HOOK": "inline (no completion hook — Task() reply returns synchronously)",
      "SUBAGENT_RESULT_API": "Task() reply (inline, no poll)"
    },
    "supportedCapabilities": {
      "fs:read": "native",
      "fs:write": "native",
      "shell:exec": "native",
      "subagent:spawn": "native",
      "mcp:exarchos": "native",
      "mcp:exarchos:readonly": "native",
      "isolation:worktree": "advisory",
      "session:resume": "advisory"
    }
  },
  {
    "name": "copilot",
    "capabilities": {
      "hasSubagents": true,
      "hasSlashCommands": true,
      "hooks": {
        "profile": "copilot-json",
        "canInjectContext": false,
        "sessionStartEvent": "sessionStart",
        "sessionEndEvent": "sessionEnd"
      },
      "hasSkillChaining": false,
      "mcpPrefix": "mcp__exarchos__"
    },
    "preferredFacade": "cli",
    "skillsInstallPath": "~/.copilot/skills",
    "detection": {
      "binaries": [
        "copilot"
      ],
      "envVars": []
    },
    "placeholders": {
      "MCP_PREFIX": "mcp__exarchos__",
      "COMMAND_PREFIX": "/",
      "TASK_TOOL": "task",
      "CHAIN": "[Invoke the exarchos:{{next}} skill with args: {{args}}]",
      "SPAWN_AGENT_CALL": "task --agent {{agent}} '{{description}}: {{prompt}}'",
      "SUBAGENT_COMPLETION_HOOK": "subagent completion signal (poll-based)",
      "SUBAGENT_RESULT_API": "inline reply from task --agent (no separate collection API)"
    },
    "supportedCapabilities": {
      "fs:read": "native",
      "fs:write": "native",
      "shell:exec": "native",
      "subagent:spawn": "native",
      "mcp:exarchos": "native",
      "mcp:exarchos:readonly": "native",
      "isolation:worktree": "advisory",
      "session:resume": "advisory"
    }
  },
  {
    "name": "cursor",
    "capabilities": {
      "hasSubagents": true,
      "hasSlashCommands": false,
      "hooks": {
        "profile": "cursor-json",
        "canInjectContext": true,
        "sessionStartEvent": "sessionStart",
        "sessionEndEvent": "sessionEnd"
      },
      "hasSkillChaining": false,
      "mcpPrefix": "mcp__exarchos__"
    },
    "preferredFacade": "mcp",
    "skillsInstallPath": "~/.cursor/skills",
    "detection": {
      "binaries": [
        "cursor-agent",
        "cursor"
      ],
      "envVars": []
    },
    "placeholders": {
      "MCP_PREFIX": "mcp__exarchos__",
      "COMMAND_PREFIX": "",
      "TASK_TOOL": "Task",
      "CHAIN": "[Invoke the exarchos:{{next}} skill with args: {{args}}]",
      "SPAWN_AGENT_CALL": "Task({\n  subagent_type: \"{{agent}}\",\n  description: \"{{description}}\",\n  prompt: \"{{prompt}}\"\n})\n",
      "SUBAGENT_COMPLETION_HOOK": "subagent completion signal (poll-based)",
      "SUBAGENT_RESULT_API": "Task() reply (inline)"
    },
    "supportedCapabilities": {
      "fs:read": "native",
      "fs:write": "native",
      "shell:exec": "native",
      "subagent:spawn": "native",
      "mcp:exarchos": "native",
      "mcp:exarchos:readonly": "native",
      "isolation:worktree": "advisory",
      "session:resume": "advisory"
    }
  }
] as const;

/**
 * Deep-freeze a runtime map and any nested objects so the consumer
 * cannot mutate the embedded copy. `Object.freeze` is shallow, but the
 * shape is JSON-flat (objects + arrays + primitives), so a recursive
 * walk is sufficient.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

/**
 * Frozen array of validated `RuntimeMap` entries embedded into the
 * compiled binary. The bridge in
 * `src/lifecycle/install-skills-bridge.js`
 * prefers this array over reading `runtimes/*.yaml` from disk so
 * `install-skills` works inside the single-file binary, where the
 * YAML directory does not ship.
 *
 * Sorted by canonical `REQUIRED_RUNTIME_NAMES` order, then any extras
 * alphabetically — see `scripts/codegen-runtimes.ts` for the contract.
 */
export const EMBEDDED_RUNTIMES: readonly RuntimeMap[] = Object.freeze(
  RAW_RUNTIMES.map((r) => deepFreeze(r as unknown as RuntimeMap)),
) as readonly RuntimeMap[];

/**
 * Convenience lookup for a single embedded runtime by name. Returns
 * `undefined` when no embedded runtime matches — callers decide
 * whether to throw or fall back. Mirrors the `findRuntime()` helper
 * in `src/install/install-skills.ts` so call-site behavior is identical
 * regardless of whether the runtimes came from FS or the embedded
 * module.
 */
export function getEmbeddedRuntime(name: string): RuntimeMap | undefined {
  return EMBEDDED_RUNTIMES.find((r) => r.name === name);
}

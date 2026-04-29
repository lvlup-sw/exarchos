/**
 * AUTO-GENERATED — do not edit by hand.
 *
 * Source: runtimes/*.yaml at repo root.
 * Regenerate: `npm run generate:runtimes`.
 *
 * Bundled into the compiled `exarchos` binary so the
 * `exarchos install-skills` subcommand can resolve the target runtime
 * without any on-disk YAML at user-install time.
 */

import type { RuntimeMap } from './types.js';

export const EMBEDDED_RUNTIMES: Readonly<Record<string, RuntimeMap>> = Object.freeze({
  "generic": {
    "name": "generic",
    "capabilities": {
      "hasSubagents": false,
      "hasSlashCommands": false,
      "hasHooks": false,
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
  "claude": {
    "name": "claude",
    "capabilities": {
      "hasSubagents": true,
      "hasSlashCommands": true,
      "hasHooks": true,
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
  "codex": {
    "name": "codex",
    "capabilities": {
      "hasSubagents": true,
      "hasSlashCommands": true,
      "hasHooks": false,
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
  "opencode": {
    "name": "opencode",
    "capabilities": {
      "hasSubagents": true,
      "hasSlashCommands": true,
      "hasHooks": false,
      "hasSkillChaining": false,
      "mcpPrefix": "mcp__exarchos__"
    },
    "preferredFacade": "cli",
    "skillsInstallPath": "~/.config/opencode/skills",
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
  "copilot": {
    "name": "copilot",
    "capabilities": {
      "hasSubagents": true,
      "hasSlashCommands": true,
      "hasHooks": false,
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
  "cursor": {
    "name": "cursor",
    "capabilities": {
      "hasSubagents": true,
      "hasSlashCommands": false,
      "hasHooks": false,
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
  },
});

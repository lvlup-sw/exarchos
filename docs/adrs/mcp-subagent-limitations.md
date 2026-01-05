# MCP Tools & Subagent Limitations in Claude Code

**Date:** 2026-01-05
**Status:** Partially Resolved (Base URL fixed; Claude Code bugs remain open)
**References:**
- https://github.com/anthropics/claude-code/issues/13605
- https://github.com/anthropics/claude-code/issues/15810
- https://github.com/anthropics/claude-code/issues/5465

---

## Problem Summary

When using Claude Code with MCP servers (like Jules) and subagents spawned via the Task tool, several issues prevent proper tool inheritance and permission propagation.

### Symptoms

1. **MCP tools not available to subagents**: Subagents spawned via `Task` tool cannot access MCP tools even when the parent agent has access
2. **Permission errors for file operations**: Subagents fail to write/edit files due to permission restrictions not being inherited
3. **Custom plugin agents cannot access MCP**: Agents defined in plugins don't receive MCP tool access

---

## Root Causes

### 1. MCP Tool Inheritance Bug

**GitHub Issue:** [#13605](https://github.com/anthropics/claude-code/issues/13605)

Custom subagents defined in plugins cannot access MCP tools. This is a known bug where:
- Built-in agents (`general-purpose`, `Explore`, `Plan`) receive MCP tools
- Custom plugin-defined agents do NOT receive MCP tools
- The `tools` field in agent definitions doesn't properly inherit MCP tools

### 2. Permission Inheritance in MCP Server Mode

**GitHub Issue:** [#5465](https://github.com/anthropics/claude-code/issues/5465)

When using Task tool to spawn subagents in MCP server mode:
- Subagents fail to inherit file system permissions
- Results in permission prompts that cannot be answered through MCP interface
- Causes subagents to be unable to write/edit files

### 3. Plugin-Defined Subagent MCP Access

**GitHub Issue:** [#15810](https://github.com/anthropics/claude-code/issues/15810)

- Plugin-defined agents cannot access MCP tools
- This affects any custom agents defined in `.claude-plugin/` directories
- Only built-in agent types receive proper MCP tool access

### 4. Jules API Base URL (RESOLVED)

**Status:** Fixed locally on 2026-01-05

The Jules MCP server had an incorrect base URL:
- **Wrong**: `https://jules.google/v1alpha` (returns 404 HTML page)
- **Correct**: `https://jules.googleapis.com/v1alpha`

This caused MCP tool calls to fail with JSON parse errors (`Unexpected token '<'`).

**Fix applied in:** `plugins/jules/servers/jules-mcp/src/jules-client.ts:13`

---

## Workarounds

### Workaround 1: Use Built-in Agent Types (Recommended)

From [Issue #13605](https://github.com/anthropics/claude-code/issues/13605):

> **Use the built-in `general-purpose` agent type instead of custom plugin agents**

When spawning subagents via the Task tool, use:
```typescript
Task({
  subagent_type: "general-purpose",  // Built-in type, NOT custom
  model: "opus",
  prompt: "Your task description..."
})
```

Built-in agent types that should inherit MCP tools:
- `general-purpose`
- `Explore`
- `Plan`
- `claude-code-guide`

### Workaround 2: Main Agent Calls MCP Directly

Instead of delegating MCP tool calls to subagents, have the main agent:
1. Call MCP tools directly
2. Pass the results to subagents as context
3. Use subagents only for non-MCP operations

Example flow:
```
Main Agent:
  1. Call jules_create_task() directly
  2. Get session ID back
  3. Pass session ID to subagent for monitoring

Subagent:
  1. Receives session ID as context
  2. Can only do non-MCP work (file operations with proper permissions)
```

### Workaround 3: Broader Permission Configuration

Add explicit permissions to `.claude/settings.local.json`:

```json
{
  "permissions": {
    "allow": [
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "mcp__*"
    ]
  }
}
```

This ensures:
- File operations are pre-approved for subagents
- MCP tools are whitelisted (though inheritance bugs may still apply)

---

## Configuration Applied

### `.claude/settings.local.json`
```json
{
  "permissions": {
    "allow": [
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "WebFetch(domain:aka.ms)",
      "WebFetch(domain:jules.google)",
      "Bash(find:*)",
      "Bash(mkdir:*)",
      "Bash(cat:*)",
      "Bash(git remote:*)",
      "Bash(git checkout:*)",
      "Bash(wc:*)",
      "Bash(chmod:*)",
      "Bash(ls:*)",
      "Bash(npx:*)",
      "Bash(npm:*)",
      "mcp__jules__*"
    ]
  }
}
```

### `.mcp.json` (Project Root)
```json
{
  "mcpServers": {
    "jules": {
      "command": "npx",
      "args": ["tsx", "./plugins/jules/servers/jules-mcp/src/index.ts"],
      "env": {
        "JULES_API_KEY": "${JULES_API_KEY}"
      }
    }
  }
}
```

---

## Best Practices

### For MCP Tool Usage

1. **Call MCP tools from main agent**, not subagents
2. **Use built-in agent types** (`general-purpose`) when subagent needs any tool access
3. **Pre-approve permissions** in settings to avoid interactive prompts in subagents

### For Subagent Delegation

1. **Specify `model: "opus"`** for coding tasks (subagents default to cheaper models)
2. **Use `subagent_type: "general-purpose"`** instead of custom agents
3. **Provide full context** in prompt since subagents don't have conversation history
4. **Run in background** for long tasks: `run_in_background: true`

### For Plugin Development

1. **Don't define custom agents** that need MCP access until bugs are fixed
2. **Use skills instead of agents** for MCP-dependent functionality
3. **Document MCP requirements** clearly for users

---

## Status Tracking

| Issue | Status | Workaround Available |
|-------|--------|---------------------|
| #13605 | Open | Yes - Use built-in agents |
| #15810 | Open | Yes - Use built-in agents |
| #5465 | Open | Yes - Pre-approve permissions |
| Base URL Bug | **Resolved** | Fixed in jules-client.ts |

---

## Changelog

- **2026-01-05**: Fixed Jules API base URL bug (`jules.google` → `jules.googleapis.com`)
- **2026-01-05**: Initial documentation created after investigation

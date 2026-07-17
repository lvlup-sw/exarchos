# Design: First-Class GitHub Copilot CLI Support

**Issue:** #966
**Date:** 2026-03-07
**Status:** Draft (revised after docs verification)
**Approach:** Validate-first with dual-format plugin artifacts for confirmed gaps

## Problem

Exarchos targets Claude Code as its sole runtime. GitHub Copilot CLI shares a partially compatible plugin architecture — it reads `.claude-plugin/plugin.json`, supports `SKILL.md` with YAML frontmatter, and has file-based `hooks.json` — but with significant format differences in MCP server registration, hook schemas, and event availability. Supporting both runtimes expands the user base without duplicating the core workflow engine.

## Verified Compatibility (from official GitHub docs)

Source: [docs.github.com/copilot/how-tos/copilot-cli](https://docs.github.com/copilot/how-tos/copilot-cli)

### What Works

| Feature | Evidence |
|---------|----------|
| Plugin discovery from `.claude-plugin/` | Copilot CLI reads `plugin.json` from `.claude-plugin/`, `.github/plugin/`, or repo root |
| Plugin install from GitHub | `copilot plugin install lvlup-sw/exarchos` |
| Skills (`SKILL.md` + YAML frontmatter) | Same file format; Copilot CLI reads from `.claude/skills/` and `~/.claude/skills/` |
| Slash commands from skills | `/skill-name` invocation — same model |
| MCP protocol (stdio) | Same `@modelcontextprotocol/sdk` transport |
| `AGENTS.md` | Copilot CLI loads project context files |

### Known Incompatibilities

| Feature | Claude Code | Copilot CLI | Gap |
|---------|------------|-------------|-----|
| **MCP in plugin.json** | Inline `mcpServers` object | String path to `.mcp.json` file | Must add `.mcp.json` |
| **hooks.json wrapper** | `{ "hooks": { ... } }` | `{ "version": 1, "hooks": { ... } }` | Different schema |
| **Hook event names** | PascalCase (`SessionStart`) | camelCase (`sessionStart`) | Name mapping |
| **Hook command field** | `"command": "node ..."` | `"bash": "node ..."` + `"powershell"` | Different fields |
| **Hook timeout** | `"timeout": 10` (seconds) | `"timeoutSec": 10` | Field rename |
| **Hook matchers** | `"matcher": "regex"` | Not supported | Must remove |
| **Hook statusMessage** | `"statusMessage": "..."` | Not supported | Must remove |
| **PreCompact event** | Yes | No | Hook compensation |
| **TaskCompleted event** | Yes | No | Hook compensation |
| **TeammateIdle event** | Yes | No (no agent teams) | N/A |
| **SubagentStart event** | Yes | No | Hook compensation |
| **postToolUse event** | No | Yes | New opportunity |
| **userPromptSubmitted** | No | Yes | New opportunity |
| **errorOccurred event** | No | Yes | New opportunity |
| **`${CLAUDE_PLUGIN_ROOT}`** | Documented, works | **Not documented** | Critical unknown |
| **Skill metadata fields** | `metadata.mcp-server`, `metadata.phase-affinity` | Not documented (likely ignored) | Validate |
| **Plugin installed to** | `~/.claude/plugins/` | `~/.copilot/state/installed-plugins/` | Different paths |

### Copilot CLI Hook Event Reference

From [hooks-configuration reference](https://docs.github.com/en/copilot/reference/hooks-configuration):

| Event | Input Schema | Output |
|-------|-------------|--------|
| `sessionStart` | `{ timestamp, cwd, source, initialPrompt }` | Ignored |
| `sessionEnd` | `{ timestamp, cwd, reason }` | Ignored |
| `preToolUse` | `{ timestamp, cwd, toolName, toolArgs }` | `{ permissionDecision, permissionDecisionReason }` |
| `postToolUse` | `{ timestamp, cwd, toolName, toolArgs, toolResult }` | Ignored |
| `userPromptSubmitted` | `{ timestamp, cwd, prompt }` | Ignored |
| `errorOccurred` | `{ timestamp, cwd, error: { message, name, stack } }` | Ignored |

## Constraints

- Single distribution artifact (one NPM package serves both runtimes)
- Full solo workflow parity: `ideate -> plan -> implement -> review -> synthesize`
- Agent teams remain Claude Code-only (Copilot CLI lacks `TeamCreate`/`SendMessage` APIs)
- Backward-compatible: zero regressions for existing Claude Code users

## Architecture

### 1. Validation Protocol

Before writing adaptation code, install Exarchos on Copilot CLI and test each integration surface. Many questions have been answered by docs research but some require empirical verification.

#### 1.1 Critical Path Tests

| Test | Method | Expected (from docs) | Still needs validation? |
|------|--------|---------------------|------------------------|
| Plugin discovery | `copilot plugin install lvlup-sw/exarchos` | `.claude-plugin/plugin.json` loaded | Yes — does inline `mcpServers` cause error or get ignored? |
| `${CLAUDE_PLUGIN_ROOT}` resolution | Check MCP server launch | **Unknown** — not documented for Copilot CLI | **Yes — critical** |
| MCP server startup | Invoke any `exarchos_*` tool | Works if plugin root resolves | Yes |
| Skill loading | Run `/exarchos:ideate` | Skills load from `.claude-plugin/skills/` | Yes — verify unknown frontmatter fields are ignored |
| Command loading | Check slash command list | **Unknown** — `commands/` dir not documented for Copilot CLI | **Yes** |
| Hook events | Start session, use tools | `sessionStart` and `preToolUse` fire | Yes — verify our hooks.json format is accepted or rejected |

#### 1.2 Questions Already Answered by Docs

| Question | Answer |
|----------|--------|
| Which hook events exist? | `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `userPromptSubmitted`, `errorOccurred` |
| Does Copilot CLI support hook matchers? | **No** |
| Does Copilot CLI support `PreCompact`? | **No** |
| Does Copilot CLI support `TaskCompleted`? | **No** |
| Hook format? | `{ "version": 1, "hooks": { ... } }` with `bash`/`powershell` fields |
| Where are skills loaded from? | `.claude/skills/`, `~/.claude/skills/`, `.github/skills/`, `~/.copilot/skills/` |

### 2. Dual-Format Plugin Artifacts

Rather than runtime detection at the code level, we produce **dual-format configuration files** that both runtimes can consume. The MCP server code stays identical — only the plugin packaging differs.

#### 2.1 MCP Server Configuration

Add a `.mcp.json` file alongside the existing inline `mcpServers` in `plugin.json`:

```json
// .claude-plugin/.mcp.json (NEW — for Copilot CLI)
{
  "mcpServers": {
    "exarchos": {
      "command": "node",
      "args": ["dist/exarchos.js", "mcp"],
      "env": {
        "WORKFLOW_STATE_DIR": "~/.claude/workflow-state",
        "EXARCHOS_PLUGIN_ROOT": "."
      }
    }
  }
}
```

Update `plugin.json` to add the `mcpServers` string reference (Copilot CLI reads this; Claude Code reads the inline object):

```json
{
  "name": "exarchos",
  "mcpServers": {
    "exarchos": {
      "type": "stdio",
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/exarchos.js", "mcp"],
      "env": {
        "WORKFLOW_STATE_DIR": "~/.claude/workflow-state",
        "EXARCHOS_PLUGIN_ROOT": "${CLAUDE_PLUGIN_ROOT}"
      }
    }
  }
}
```

**Open question:** Can `plugin.json` have both an inline `mcpServers` object AND a string reference? Or do we need to move to the `.mcp.json` approach for both? Validation will determine this.

**Fallback:** If Copilot CLI errors on the inline `mcpServers` object, we may need to restructure `plugin.json` to use the string reference form and keep the inline form in a Claude Code-specific override.

#### 2.2 Hooks Configuration

Generate a Copilot CLI-compatible hooks file. Two options:

**Option A: Single hooks.json with Copilot CLI format**
If Claude Code can also read the Copilot CLI format (`version`, camelCase events, `bash` field), use one file.

**Option B: Dual hooks files**
Keep `hooks/hooks.json` for Claude Code. Add `hooks/copilot-hooks.json` for Copilot CLI. Plugin.json points to the appropriate one.

Copilot CLI hooks.json:
```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{
      "type": "command",
      "bash": "node dist/exarchos.js session-start",
      "timeoutSec": 10
    }],
    "preToolUse": [{
      "type": "command",
      "bash": "node dist/exarchos.js guard",
      "timeoutSec": 5
    }],
    "sessionEnd": [{
      "type": "command",
      "bash": "node dist/exarchos.js session-end",
      "timeoutSec": 30
    }]
  }
}
```

**Key differences from Claude Code hooks:**
- No `PreCompact` (doesn't exist in Copilot CLI)
- No `TaskCompleted`, `TeammateIdle`, `SubagentStart` (don't exist)
- No `matcher` field (not supported)
- No `statusMessage` (not supported)
- `bash` instead of `command`
- `timeoutSec` instead of `timeout`
- camelCase event names
- Paths must resolve without `${CLAUDE_PLUGIN_ROOT}` (may not be available)

#### 2.3 Plugin Root Resolution

`${CLAUDE_PLUGIN_ROOT}` is not documented for Copilot CLI. Three resolution strategies:

1. **Validation first:** Test if Copilot CLI resolves `${CLAUDE_PLUGIN_ROOT}` — it may support it for Claude Code compatibility even though it's undocumented.

2. **Relative paths:** Copilot CLI hooks may execute with `cwd` set to the plugin root. If so, relative paths like `node dist/exarchos.js` work without env var substitution.

3. **`__dirname` fallback:** The MCP server can resolve its own location:
   ```typescript
   const pluginRoot = process.env.EXARCHOS_PLUGIN_ROOT
     || process.env.CLAUDE_PLUGIN_ROOT
     || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
   ```

### 3. Hook Compensation Strategy

For hooks that don't exist in Copilot CLI, the MCP server compensates to maintain workflow correctness.

| Missing Hook | Compensation | Implementation |
|-------------|-------------|----------------|
| `PreCompact` | Checkpoint on every phase transition | `exarchos_workflow` `set` already persists state; checkpoint files written eagerly on phase changes |
| `TaskCompleted` | Quality gates run on-demand via `/review` | No code change — path already exists |
| `SubagentStart` | Context provided via skill instructions | Skills already contain full workflow context |
| `TeammateIdle` | N/A — agent teams are Claude Code-only | Already gated |

**Key principle:** The MCP server must never require a hook to have fired for correct operation.

### 4. Runtime Detection

Lightweight module to detect which runtime is hosting the MCP server. Used for logging and conditional behavior where needed (not for config generation — that's handled by dual-format artifacts).

```typescript
// servers/exarchos-mcp/src/runtime.ts
export type Runtime = 'claude-code' | 'copilot-cli' | 'unknown';

export function detectRuntime(): Runtime {
  if (process.env.EXARCHOS_RUNTIME) {
    return process.env.EXARCHOS_RUNTIME as Runtime;
  }
  // Claude Code sets CLAUDE_PLUGIN_ROOT in plugin.json env
  if (process.env.CLAUDE_PLUGIN_ROOT) return 'claude-code';
  // Copilot CLI detection — validate which env vars it sets
  if (process.env.COPILOT_CLI_VERSION) return 'copilot-cli';
  return 'unknown';
}
```

### 5. Skill Compatibility

Skills are highly compatible. Copilot CLI:
- Reads `SKILL.md` with YAML frontmatter (same format)
- Loads from `.claude/skills/` (explicit Claude Code path support)
- Uses `/skill-name` invocation (same)

**Frontmatter:** Copilot CLI documents `name`, `description`, `license`. Our skills include additional `metadata.*` fields. Expected behavior: unknown fields are ignored (standard YAML frontmatter practice). Validation will confirm.

### 6. Distribution Strategy

Single NPM package, single `.claude-plugin/` directory. Both runtimes read from this path.

- **Claude Code:** `claude plugin install lvlup-sw/exarchos` or marketplace
- **Copilot CLI:** `copilot plugin install lvlup-sw/exarchos`
- **Marketplace:** Keep `marketplace.json` for Claude Code marketplace. Register on `awesome-copilot` or `copilot-plugins` marketplace separately (future work).
- Plugin includes both Claude Code and Copilot CLI config files; each runtime reads what it understands.

### 7. CI Test Matrix

Add Copilot CLI validation after compatibility is confirmed.

```yaml
strategy:
  matrix:
    runtime: [claude-code, copilot-cli]

steps:
  - name: Install plugin
    run: |
      if [ "${{ matrix.runtime }}" = "copilot-cli" ]; then
        copilot plugin install .
      else
        claude plugin install .
      fi

  - name: Validate plugin loads
    run: |
      ${{ matrix.runtime == 'copilot-cli' && 'copilot' || 'claude' }} plugin list | grep exarchos
```

### 8. Documentation Updates

- `README.md` — Add Copilot CLI installation section
- `docs/compatibility.md` — Runtime-specific behavior matrix and known limitations

## Implementation Phases

### Phase 1: Validation (1 session)
1. Install Exarchos on Copilot CLI as-is
2. Test: Does `plugin.json` with inline `mcpServers` work or error?
3. Test: Does `${CLAUDE_PLUGIN_ROOT}` resolve?
4. Test: Do hooks fire? Does the current hooks.json format cause errors?
5. Test: Do skills load? Are unknown frontmatter fields ignored?
6. Test: Do commands load?
7. Document results, update this design

### Phase 2: Plugin Packaging (1 session)
1. Add `.mcp.json` for Copilot CLI MCP server discovery
2. Generate Copilot CLI-compatible `hooks.json` (camelCase, bash field, version 1)
3. Resolve plugin root path issue (relative paths or __dirname fallback)
4. Implement runtime detection module
5. Test on both runtimes

### Phase 3: Hook Compensation + Polish (1 session)
1. Make MCP server self-sufficient without PreCompact hook
2. Update documentation
3. Add CI smoke test
4. Update issue #966 with supported/unsupported matrix

## Success Criteria

- Exarchos installs on Copilot CLI without errors
- MCP server starts and responds to tool calls on both runtimes
- Full solo workflow completes on Copilot CLI
- All hooks degrade gracefully (no errors, workflow still correct)
- Zero regressions on Claude Code
- README documents both installation paths

## Non-Goals

- Agent team support on Copilot CLI
- Copilot CLI marketplace registration (future work)
- Supporting runtimes beyond Claude Code and Copilot CLI
- Abstracting the `Skill()` / `Task()` APIs (runtime-provided)

## Open Questions (Resolved by Validation)

1. ~~Which hook events does Copilot CLI fire?~~ **Answered:** `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `userPromptSubmitted`, `errorOccurred`
2. ~~Does Copilot CLI support hook matchers?~~ **Answered:** No
3. Does `${CLAUDE_PLUGIN_ROOT}` resolve on Copilot CLI?
4. Does inline `mcpServers` in `plugin.json` work on Copilot CLI or does it require `.mcp.json`?
5. What prefix does Copilot CLI use for MCP tool names?
6. Does Copilot CLI error on unknown `settings.json` fields?
7. What `cwd` do hook scripts execute with? (plugin root? project root?)
8. Are Copilot CLI's `commands/` equivalent to Claude Code's? (undocumented)
9. Does Copilot CLI support the `"hooks": "hooks.json"` field in `plugin.json`?

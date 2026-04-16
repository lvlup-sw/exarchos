---
outline: deep
---

# Facade and Deployment Choices

Exarchos exposes its workflow engine through two invocation facades -- MCP tool calls and CLI commands -- backed by a single execution core. A third axis, hosted MCP deployment, is planned as a future deployment option. These three axes are orthogonal: the facade an agent uses to invoke an operation is independent of where workflow state lives.

This page explains the three axes, how each runtime selects its facade, and how to choose the right configuration for your environment.

## Three orthogonal axes

### Local CLI invocation

```bash
exarchos workflow set --feature-id my-feature --phase plan --json
```

The CLI adapter (`adapters/cli.ts`) builds a Commander program from the tool registry. Composite tools become top-level commands, actions become subcommands, and Zod schema fields become `--kebab-case` flags. Append `--json` for structured output that matches the MCP `ToolResult` shape exactly.

**When to use:** Runtimes without first-class MCP support, scripting, debugging, CI pipelines, or any environment where a shell is available but MCP is not. Zero upfront token cost -- no tool schemas loaded into the context window.

**Trade-offs:** Each invocation starts a new process (~50-200ms cold start for SQLite initialization). No schema-guided call semantics unless the agent runs `exarchos schema` first.

### Local MCP invocation

```
mcp__plugin_exarchos_exarchos__exarchos_workflow({ action: "set", featureId: "my-feature", phase: "plan" })
```

The MCP adapter (`adapters/mcp.ts`) runs a persistent stdio server using `@modelcontextprotocol/sdk`. Tool schemas are registered at session start and available for schema-guided invocation throughout the session. Four composite tools cover the full surface:

| Tool | Purpose |
|------|---------|
| `exarchos_workflow` | Workflow lifecycle: init, get, set, cancel, cleanup, reconcile |
| `exarchos_event` | Append-only event store: append, query, batch |
| `exarchos_orchestrate` | Task coordination, convergence gates, runbooks, agent specs |
| `exarchos_view` | CQRS projections: pipeline status, task boards, stack health |

**When to use:** MCP-native runtimes where the host maintains a persistent MCP server process. Schema cost is amortized across the session, and the warm process avoids repeated startup overhead.

**Trade-offs:** Upfront token cost for tool schema registration in the context window. Requires MCP client support in the host runtime.

### Hosted MCP deployment (future)

A remote MCP server deployment where workflow state lives on a hosted service rather than the local filesystem. This axis is orthogonal to facade selection -- a hosted backend could serve both MCP and CLI clients.

**Status:** Aspirational. Tracked in [#1081](https://github.com/lvlup-sw/exarchos/issues/1081). Not implemented today. Placeholder interfaces exist at `adapters/remote-mcp.ts` for future work.

**Potential use cases:** Cross-machine workflow continuity, team-wide visibility dashboards, centralized audit trails, CI/CD integration without local state.

## Decision matrix

The table below maps host capability against invocation axis. Use it to determine the recommended configuration for your environment.

| Host capability | Local CLI | Local MCP | Hosted MCP |
|:----------------|:---------:|:---------:|:----------:|
| **MCP-native runtime** (Claude Code, Cursor, Codex) | Available | **Preferred** | Future |
| **CLI-only runtime** (OpenCode, Copilot, generic) | **Preferred** | Available | Future |
| **Unknown runtime** | **Preferred** | n/a | Future |

**Reading the matrix:**

- **Preferred** -- the default facade for this runtime class. Skills render invocations in this style automatically.
- **Available** -- works but is not the default. You can override by changing `preferredFacade` in the runtime YAML.
- **Future** -- not implemented; tracked in [#1081](https://github.com/lvlup-sw/exarchos/issues/1081).
- **n/a** -- the host lacks the capability to use this facade without additional tooling.

Both facades call the same `dispatch()` function and produce identical `ToolResult` payloads. Choosing one over the other is a deployment decision, not a functionality decision.

## Runtime facade assignments

Each runtime declares its preferred facade in `runtimes/<name>.yaml` via the `preferredFacade` field. The skills renderer reads this field and expands invocation macros into the corresponding syntax.

### MCP-preferred runtimes

| Runtime | File | Rationale |
|:--------|:-----|:----------|
| **Claude Code** | `runtimes/claude.yaml` | Native MCP client via plugin system; tools namespaced as `mcp__plugin_exarchos_exarchos__*` |
| **Cursor** | `runtimes/cursor.yaml` | First-class MCP support via `~/.cursor/mcp.json` |
| **Codex** | `runtimes/codex.yaml` | MCP servers registered in `~/.codex/config.toml`; tools exposed as OpenAI function calls |

### CLI-preferred runtimes

| Runtime | File | Rationale |
|:--------|:-----|:----------|
| **OpenCode** | `runtimes/opencode.yaml` | MCP client surface is still thin; CLI is more reliable |
| **Copilot** | `runtimes/copilot.yaml` | MCP integration is nascent; slash-command/CLI invocations are the canonical path |
| **Generic** | `runtimes/generic.yaml` | Lowest-common-denominator; no guaranteed MCP client, so CLI is the safest default |

## How `preferredFacade` drives rendering

The skills renderer (`src/build-skills.ts`) reads each runtime's `preferredFacade` value and uses it to control how invocation placeholders are expanded in rendered skill output.

The `preferredFacade` field accepts two values:

- `mcp` -- rendered skills emit MCP tool_use invocations using the runtime's `mcpPrefix` (e.g., `mcp__plugin_exarchos_exarchos__` for Claude Code, `mcp__exarchos__` for others).
- `cli` -- rendered skills emit CLI `Bash` invocations of the form `exarchos <tool> <action> --flags --json`.

Both rendering paths produce functionally equivalent output. The underlying `dispatch()` function, handler logic, and `ToolResult` response shape are identical regardless of which facade is used. This is enforced by parity contract tests that run in CI.

### Changing the facade for a runtime

To override the default facade for a runtime, edit its YAML file:

```yaml
# runtimes/opencode.yaml
preferredFacade: mcp  # Switch from CLI to MCP
```

Then rebuild skills:

```bash
npm run build:skills
```

The renderer will re-expand all invocation placeholders using the new facade. Commit both the YAML change and the regenerated `skills/` tree.

## Parity guarantees

Both facades share a single execution path:

1. Input arrives (MCP JSON-RPC or CLI flags).
2. The adapter normalizes input into a typed `DispatchInput`.
3. `dispatch()` routes to the appropriate handler.
4. The handler executes against the event store and state store.
5. The adapter formats the `ToolResult` for its transport.

Because steps 2-4 are shared, the facades are equal by construction. CI enforces this with:

- **Per-action parity tests** -- each composite tool has a `*.parity.test.ts` file asserting that MCP and CLI produce deep-equal JSON payloads.
- **End-to-end parity harness** -- a canonical workflow runs through both facades and produces byte-equivalent event-store state.

## Further reading

- [Platform Portability](/architecture/platform-portability) -- adapter layer details and path resolution
- [Architecture Overview](/architecture/) -- system components and transport layers
- [Design document](https://github.com/lvlup-sw/exarchos/blob/main/docs/designs/2026-04-14-cli-vs-mcp-facade-analysis.md) -- full analysis of the three options considered
- [#1081](https://github.com/lvlup-sw/exarchos/issues/1081) -- remote MCP deployment tracking issue

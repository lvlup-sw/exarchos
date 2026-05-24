# INV-5a: Tool Input Ergonomics

Generic agent-friendly tool input design — what *every* well-designed MCP server should do. This is the "table stakes" sub-discipline of the INV-5 Agent-First Interface Design family (see the [invariants catalog](../../invariants.md)).

## Acceptance questions

1. Does the tool description state when **NOT** to use the tool, with a pointer to the alternative?
2. Are parameters constrained at the schema level — enum, regex, format — rather than via prose hints?
3. Does each parameter have a description with constraints AND examples?
4. Is read-only context exposed as MCP **Resources**, not tools?
5. Does the visible tool count stay ≤15? (Exarchos achieves this via the action-discriminator pattern — see [INV-5d](INV-5d-action-discriminator.md).)

## Repo-grounded checks

- Tool descriptions are ≥3–4 sentences for non-trivial tools, with explicit "Do NOT use for X — use Y instead" guidance.
- Schemas use Zod's discriminated unions, enums, and format/regex constraints. Avoid permissive `Record<string, unknown>` at boundary.
- Per-parameter `.describe()` calls include constraints + at least one example.
- Tool descriptions enumerate the action set briefly; per-action detail goes through the `describe` action (see [INV-5d](INV-5d-action-discriminator.md)).
- Static reference content (docs, playbooks) is exposed as MCP Resources via [#1275](https://github.com/lvlup-sw/exarchos/issues/1275) when available — not as tools that return strings.

## External grounding

- Anthropic, [*Define tools*](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use) — "Provide extremely detailed descriptions. This is by far the most important factor in tool performance. Aim for at least 3-4 sentences per tool description, more if the tool is complex." Use `input_examples` for complex schemas; `strict: true` for schema validation.
- AgentPatterns [*MCP Server Design*](https://agentpatterns.ai/tool-engineering/mcp-server-design/) — `verb_noun` snake_case naming; per-parameter description with constraints + examples; "Tool descriptions state when NOT to use the tool"; tool list under 15.
- AgentPatterns [*MCP Client/Server Architecture*](https://agentpatterns.ai/tool-engineering/mcp-client-server-architecture/) — poka-yoke parameters: "Design parameters so misuse is structurally impossible. Absolute paths over relative eliminated path errors entirely. Prefer enums over free-text."
- WebMCP [*Tool Design*](https://docs.mcp-b.ai/explanation/design/tool-design) — "The input schema is the tool's type signature. A well-designed schema reduces hallucination, prevents misuse, and makes error recovery straightforward."
- modelcontextprotocol.info, [*Mastering MCP Tool Development*](https://modelcontextprotocol.info/blog/writing-effective-mcp-tools/) — five core principles: right abstraction level, smart namespacing, meaningful context, token efficiency, precise descriptions.

## Severity guide

- **HIGH:** tool description is one sentence ("Queries the database") with no when-not-to-use guidance and no examples.
- **MEDIUM:** free-text where an enum would do (e.g., `severity: string` instead of `severity: 'low' | 'medium' | 'high'`); missing pagination / filter on a list-shaped endpoint; description ≥3 sentences but missing "Do NOT use for" guidance.
- **LOW:** description under 3 sentences for a complex tool; relative path accepted where absolute would be clearer.

## Worked example

**Violation (HIGH):**

```ts
// registry.ts — DON'T
server.tool('search_logs', 'Search logs', {
  query: z.string(),
});
```

The agent has no idea what to put in `query`, what format the response takes, or when this tool applies vs another logging tool.

**Fix:** Per Anthropic's tool-design guidance:

```ts
// registry.ts — DO
server.tool(
  'search_logs',
  `Search application logs by time range and severity. Returns up to 100 entries
   sorted newest-first. Use list_services first to get valid service names. Do NOT
   use for metrics — use query_metrics instead. Do NOT use for log streaming —
   use subscribe_logs.`,
  {
    service: z.string().describe('Service name from list_services. Example: "auth-api"'),
    severity: z.enum(['debug', 'info', 'warn', 'error', 'fatal']).default('warn'),
    since: z
      .string()
      .datetime()
      .describe('ISO 8601 timestamp. Must be within last 30 days. Example: "2026-01-15T10:00:00Z"'),
  },
);
```

Enums for closed sets, ISO 8601 format constraint for timestamps, descriptions paired with examples, and an explicit "do NOT use for" pointer.

## See also

- [INV-5b](INV-5b-output-contract.md) — input ergonomics for *parameters*; INV-5b is for *responses*.
- [INV-5d](INV-5d-action-discriminator.md) — how Exarchos collapses 30+ logical operations into 4 visible tools.
- [deterministic-checks.md](deterministic-checks.md) — no INV-5a deterministic checks (reasoning-driven).

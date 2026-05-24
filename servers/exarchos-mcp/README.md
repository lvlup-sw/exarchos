# @lvlup-sw/exarchos-mcp

The Exarchos MCP server — 4 visible composite tools (`exarchos_workflow`,
`exarchos_event`, `exarchos_orchestrate`, `exarchos_view`) plus 1 hidden sync
tool (`exarchos_sync`), built on `@modelcontextprotocol/sdk` + `zod` over
stdio.

## Dependencies

### MCP SDK pin policy

`@modelcontextprotocol/sdk` is **exact-pinned** (e.g. `1.29.0`) — no caret
(`^`) or tilde (`~`) range. The pin is reviewed per minor release rather than
floated automatically by `npm install`. The Tasks / SEP-1686 surface we depend
on is marked `@experimental` in the SDK, so any minor bump can carry behavioral
or contract changes; moving the pin is therefore an explicit, reviewed
decision, not an implicit one.

This policy is enforced by `src/__tests__/sdk-pin-policy.test.ts`
(`McpSdkPin_PackageJson_IsExactNotCaretRange`), which fails CI if a
caret/tilde range is reintroduced.

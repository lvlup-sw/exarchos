# PR-A — formatResult + register*Tools cleanup (#1367)

**Stack position:** PR-A of the Wave 0 follow-up stack
**Base branch:** `feature/v2-10-wave-0-carrier-swap` (PR #1369)
**Head branch:** `refactor/wave-0-followups/1367-formatresult-cleanup`
**Closes:** #1367
**Source of this brief:** `docs/followups/2026-05-13-pr-a-1367-formatresult-cleanup.md`

## Why

Wave 0 (#1369) cutover the production MCP adapter from `formatResult` to `toMcpResult + toEnvelope`. The function `formatResult` is no longer called from `createMcpServer`, but it survives in `format.ts` because ~14 legacy call sites still reference it. Investigation during Wave 0 surfaced that the call sites all live inside three `register*Tools` functions (`registerWorkflowTools`, `registerViewTools`, `registerStackTools`) that **are not invoked from production code** — only from test files. They're a pre-composite-tool registration path superseded by `dispatch()`'s composite handler at `createMcpServer` (adapters/mcp.ts).

Removing the legacy paths and `formatResult` itself is the cleanest hygiene move:
- DIM-5 (Hygiene) — no dead code carried forward
- DIM-1 (Topology) — single carrier surface (`toMcpResult + toEnvelope`), single CLI surface
- Smaller surface for #1366 (Zod v4 migration) to traverse downstream

## Scope

### Files to delete (legacy registration wrappers)

| Function | File | Lines |
|---|---|---|
| `registerWorkflowTools` | `servers/exarchos-mcp/src/workflow/tools.ts` | ~lines 1658–1719 |
| `registerViewTools` | `servers/exarchos-mcp/src/views/tools.ts` | ~lines 1154–1196 |
| `registerStackTools` | `servers/exarchos-mcp/src/stack/tools.ts` | ~lines 127–157 |

The `handleInit` / `handleGet` / `handleSet` / `handleSummary` / `handleReconcile` / `handleTransitions` / `handleCancel` / `handleViewPipeline` / `handleStackPlace` / `handleStackStatus` business-logic functions in those files are **consumed by the composite-tool dispatch path** (workflow/composite.ts, views/composite.ts, stack/composite.ts) — keep them. Only delete the `server.tool(...)` registration wrappers.

### Test files to delete (caller-of-the-dead)

| File | Purpose |
|---|---|
| `servers/exarchos-mcp/src/views/tools.test.ts` | Tests legacy `registerViewTools` registration |
| `servers/exarchos-mcp/src/__tests__/views/tools.test.ts` | Same surface, separate harness |
| `servers/exarchos-mcp/src/__tests__/stack/tools.test.ts` | Tests legacy `registerStackTools` |

Before deletion, audit each for unique behavioral coverage — anything that isn't already exercised by composite-tool integration tests should be ported into the equivalent composite test surface (e.g., `__tests__/integration/tools-call.test.ts`).

### `formatResult` removal

After the three wrappers are deleted, `grep -rn formatResult servers/exarchos-mcp/src --include="*.ts" | grep -v ".test.ts"` should return zero hits in production source. Remaining test-file references can be migrated case-by-case or removed if they test the wrapper paths.

Once production references are gone, delete `formatResult` from `servers/exarchos-mcp/src/format.ts` (~lines 408–414) and the `ToolResult` import sites that consumed it.

### Tests to keep but possibly update

Per Wave 0 discovery, the following files reference `formatResult` outside the legacy wrapper paths — they likely consume the function indirectly via test fixtures or imports. Audit:

- `servers/exarchos-mcp/src/__tests__/mcp-tools.integration.test.ts`
- `servers/exarchos-mcp/src/__tests__/integration/oneshot-workflow.test.ts`
- `servers/exarchos-mcp/src/__tests__/workflow/integration.test.ts`
- `servers/exarchos-mcp/src/__tests__/workflow/cancel.test.ts`
- `servers/exarchos-mcp/src/parity/readonly-cap-parity.test.ts`

If they import `formatResult` to validate a result shape, migrate to `toEnvelope + toMcpResult` equivalents. If they re-implement a dispatch path inline, refactor to go through `createMcpServer` directly.

## Implementation plan

The cleanup is mechanical but has audit-first phases. **Iron Law: no production code change without a failing test first.** For removal work, the failing test is "registry composes without these symbols and the suite stays green."

### Phase 1 — Audit (single agent, ≤1 hour)

| Task | Action |
|---|---|
| A1.1 | `grep -rn "registerWorkflowTools\|registerViewTools\|registerStackTools" servers/exarchos-mcp --include="*.ts"` — confirm zero production callers |
| A1.2 | Per legacy test file, list assertions that are NOT covered by an existing composite-tool integration test. Generate a port-or-discard manifest. |
| A1.3 | `grep -rn "formatResult\b" servers/exarchos-mcp/src --include="*.ts"` — categorize each hit as (a) inside doomed register*Tools, (b) inside a test fixture, or (c) other production usage. |
| A1.4 | Write A1's findings as `docs/followups/2026-05-13-pr-a-audit.md`. Commit as `docs(pr-a): audit findings`. |

### Phase 2 — Port any unique test coverage

| Task | Action |
|---|---|
| A2.1 | For each "port" manifest entry: write the equivalent assertion in the corresponding composite-tool integration test. Confirm RED, then GREEN (existing impl satisfies). |
| A2.2 | Verify port coverage by running the new tests against a clean checkout. |
| A2.3 | Commit each port as `test(pr-a): port <name> coverage to composite integration` to keep audit trail granular. |

### Phase 3 — Delete legacy registration wrappers

| Task | Action |
|---|---|
| A3.1 | Delete `registerWorkflowTools` function body + export in `workflow/tools.ts`. Update the file's import block to remove unused `formatResult` / `McpServer` if no other reference remains. Run `npm run test:run`; expect failures only in test files that called it. |
| A3.2 | Delete the corresponding tests (or migrated stubs if A2 already replaced them). |
| A3.3 | Repeat A3.1 + A3.2 for `registerViewTools` (views/tools.ts) and `registerStackTools` (stack/tools.ts). |
| A3.4 | Commit each delete + test cleanup as a single atomic commit per tool. |

### Phase 4 — Remove residual formatResult production sites

| Task | Action |
|---|---|
| A4.1 | For each production hit from A1.3 category (c) — migrate the call site to `toMcpResult(toEnvelope(result))` or remove if unreachable. |
| A4.2 | Update any imports that bring `formatResult` into a test file: either remove the import (if the call site was deleted) or replace with `toEnvelope` (if the test still needs envelope-bound output for assertions). |
| A4.3 | Verify `grep -rn "formatResult\b" servers/exarchos-mcp/src --include="*.ts" | grep -v "node_modules"` returns zero hits. |

### Phase 5 — Delete formatResult itself

| Task | Action |
|---|---|
| A5.1 | Remove `formatResult` function definition and its JSDoc from `servers/exarchos-mcp/src/format.ts` (~lines 406–414). |
| A5.2 | Verify `npx tsc --noEmit` clean. |
| A5.3 | Verify `npm run test:run` green. |
| A5.4 | Commit as `refactor: remove formatResult and unused ToolResult import surface (#1367)`. |

## Acceptance

- [ ] `grep -rn "registerWorkflowTools\|registerViewTools\|registerStackTools" servers/exarchos-mcp/src --include="*.ts"` returns zero hits (definers gone, tests gone)
- [ ] `grep -rn "formatResult\b" servers/exarchos-mcp/src --include="*.ts" | grep -v ".test.ts"` returns zero hits in production source
- [ ] `formatResult` symbol no longer exported from `format.ts`
- [ ] `npm run test:run` green (MCP server + root)
- [ ] `npx tsc --noEmit` clean
- [ ] Composite-tool integration tests cover the dispatched-action surface that the deleted register-tool tests previously exercised
- [ ] PR description enumerates the deleted symbols + test files + ports

## Risks

- **Lost coverage** — a legacy test may be the only assertion against some edge case that composite-tool tests don't exercise. Mitigation: Phase 1 audit catalogs every assertion; Phase 2 ports unique coverage before deletion.
- **Lingering external import** — if a downstream consumer (basileus, another plugin) imports `formatResult` from `@lvlup-sw/exarchos`, the deletion is breaking. Mitigation: `formatResult` was never part of the package's documented surface; check `package.json`'s `exports` field to confirm it's not exported.
- **register*Tools resurrection** — a developer could re-add a legacy registration path. Mitigation: leave an inline comment in the now-empty file region pointing future contributors at `createMcpServer` and `composite.ts`.

## Out of scope (deferred to PR-B / PR-C)

- Wiring `toCliResult` into `adapters/cli.ts:emitResult` (PR-B #1368)
- Updating the 61 parity tests for the new CLI envelope shape (PR-B #1368)
- Any Zod v3 → v4 migration (PR-C #1366)
- Refactoring the `handle*` business-logic functions — they stay as-is; only their legacy registration wrappers go away

## Estimated effort

~3–5 hours via subagent dispatch:
- Phase 1 audit: 1 agent, ≤1 hour
- Phase 2 ports: 1 agent, 1–2 hours (depends on audit findings)
- Phase 3 deletes: 1 agent, ≤1 hour (mechanical)
- Phase 4 + 5: 1 agent, ≤1 hour

Single integration branch; each phase commits sequentially. PR-A targets `feature/v2-10-wave-0-carrier-swap`.

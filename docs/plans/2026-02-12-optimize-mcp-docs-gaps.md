# Documentation Gaps: optimize-mcp Refactor

**Context:** The `refactor-optimize-mcp` workflow added pagination, field projection, summary mode, claim guards, and other optimizations to the Exarchos MCP server. PRs #121 (merged) and #122-#127 (in Graphite merge pipeline) deliver these capabilities, but agent-facing documentation was not updated. Without these updates, agents will not use the new capabilities, negating the token economy benefits.

**Audit method:** Cross-referenced actual Zod schemas and handler signatures against all instruction files (rules, skills, CLAUDE.md) to identify gaps.

## 1. Wrong Parameter Names — `skills/workflow-state/SKILL.md`

**File:** `skills/workflow-state/SKILL.md`
**Lines:** 33-46

**Problem:** The skill documents incorrect parameter names for `workflow_get` and `workflow_set`. Agents following this skill will pass parameters that don't match the actual Zod schemas.

**Current (wrong):**
```text
- Full state: Call with just the `file` parameter
- Specific field: Call with `file` and `path` parameters (e.g., `path: ".phase"`)
- Update phase: `filter: '.phase = "delegate"'`
```

**Actual API:**
```text
- workflow_get: { featureId: string, query?: string, fields?: string[] }
- workflow_set: { featureId: string, updates?: Record<string, unknown>, phase?: string }
```

**Fix:** Replace all `file`/`path`/jq filter references with correct `featureId`/`query`/`fields`/`updates`/`phase` parameters.

**Severity:** Critical — agents using this skill will fail silently or get unexpected results.

## 2. Phantom `repair: true` — `rules/mcp-tool-guidance.md`

**File:** `rules/mcp-tool-guidance.md`
**Line:** 18

**Problem:** The `workflow_reconcile` entry claims `repair: true` auto-fixes corruption. No `repair` parameter exists in the Zod schema — only `featureId` is accepted. Agents will pass an invalid parameter.

**Fix:** Remove the `repair: true` claim. Document reconcile as verification-only.

**Severity:** High — agents will pass invalid parameters expecting auto-repair.

## 3. Missing 16 Tools — `rules/mcp-tool-guidance.md`

**File:** `rules/mcp-tool-guidance.md`
**Section:** Exarchos tool table (lines 11-22)

**Problem:** The Exarchos table lists only 10 workflow tools. The server exposes 26 tools total. Missing tools:

| Category | Missing Tools |
|----------|--------------|
| Event Store | `event_append`, `event_query` |
| Views | `view_pipeline`, `view_tasks`, `view_workflow_status`, `view_team_status` |
| Team | `team_spawn`, `team_message`, `team_broadcast`, `team_shutdown`, `team_status` |
| Tasks | `task_claim`, `task_complete`, `task_fail` |
| Stack | `stack_status`, `stack_place` |

**Fix:** Add all missing tools with usage guidance including new parameters (pagination, fields, summary).

**Severity:** High — agents can only use tools they know about from the guidance table.

## 4. Undocumented Optimizations — `rules/mcp-tool-guidance.md`

**File:** `rules/mcp-tool-guidance.md`

**Problem:** Existing and incoming optimization parameters are not documented anywhere in the guidance:

| Tool | Parameter | Status | Purpose |
|------|-----------|--------|---------|
| `workflow_get` | `fields` | On main (#121) | Field projection to reduce response size |
| `view_pipeline` | `limit`, `offset` | On main (#121) | Pagination for large workflow sets |
| `view_tasks` | `fields`, `limit`, `offset`, `filter` | On main (#121) | Field projection + pagination + filtering |
| `event_query` | `limit`, `offset` | On main (#103) | Pagination for event streams |
| `event_query` | `fields` | Incoming (#123) | Field projection for events |
| `team_status` | `summary` | Incoming (#122) | Counts-only mode for token savings |
| `task_claim` | Claim guard | Incoming (#125) | Returns `ALREADY_CLAIMED` error |

**Fix:** Document all parameters in the tool guidance table with usage examples.

**Severity:** High — the whole point of the optimization work is lost without agent-facing documentation.

## 5. Broken Zod Schema — `team_status` tool

**File:** `plugins/exarchos/servers/exarchos-mcp/src/team/tools.ts`
**Line:** 350 (registration schema)

**Problem:** PR #122 adds summary mode to the handler, but the Zod registration schema remains `{}` (empty). MCP tool introspection exposes the schema to Claude Code — an empty schema means the `summary` parameter is invisible.

**Fix:** Change the registration schema from `{}` to:
```typescript
{ summary: z.boolean().optional().describe('If true, return counts only (activeCount, staleCount) instead of full teammate details') }
```

**Severity:** Critical — summary mode was built specifically to reduce token cost. Without schema exposure, no agent will ever send `summary: true`.

**Note:** This is a code change that should go as a new PR on top of the current Graphite stack (#127).

## 6. Quality Review — field projection examples

**File:** `skills/quality-review/SKILL.md`
**Line:** 434

**Problem:** The review skill references `exarchos_view_tasks` for combined task + gate view but uses the default all-fields call pattern. It should demonstrate efficient querying.

**Fix:** Update the Exarchos Integration section to show field projection:
```text
Use exarchos_view_tasks with fields: ['taskId', 'status', 'title'] and limit: 20
```

**Severity:** Medium — missed optimization opportunity in a token-intensive phase.

## 7. Delegation Skill — claim guard and efficient queries

**File:** `skills/delegation/SKILL.md`

**Problem A:** With the incoming claim guard (#125), concurrent agents claiming the same task will get `ALREADY_CLAIMED`. The skill doesn't document this error.

**Problem B:** The skill uses `workflow_get` with `query: "tasks"` but doesn't mention `fields` projection for efficient status checks.

**Fix:** Add a claim guard error handling note and efficient query examples.

**Severity:** Medium — error handling gap for concurrent agents.

## 8. CLAUDE.md — tool and view counts

**File:** `CLAUDE.md`
**Line:** 54, 68

**Problem:** States "27 MCP tools" — actual count is 26. States "5 view types" — StackView (#121) brings this to 6.

**Fix:** Update counts to match reality.

**Severity:** Low — minor inaccuracy.

## Priority Order

| # | Item | Severity | Effort |
|---|------|----------|--------|
| 1 | Fix `workflow-state/SKILL.md` parameter names | Critical | 10 min |
| 2 | Fix `team_status` Zod schema (code change, new PR) | Critical | 5 min |
| 3 | Remove phantom `repair: true` from guidance | High | 2 min |
| 4 | Add 16 missing tools to guidance table | High | 15 min |
| 5 | Document optimization parameters in guidance | High | 10 min |
| 6 | Update `quality-review/SKILL.md` field projection | Medium | 5 min |
| 7 | Update `delegation/SKILL.md` claim guard + queries | Medium | 5 min |
| 8 | Fix `CLAUDE.md` counts | Low | 2 min |

## Implementation Strategy

Items 1, 3-8 are documentation fixes that can be applied directly to main.
Item 2 is a code change that needs a new Graphite PR on top of the #122-#127 stack.

All documentation fixes should land before the optimization PRs merge, so agents have guidance ready when the features arrive.

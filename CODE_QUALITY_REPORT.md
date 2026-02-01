# Code Quality Analysis Report

## 1. TODO/FIXME/HACK Comments
**Priority:** Low
**File Path:** N/A
**Description:** No `TODO`, `FIXME`, or `HACK` comments were found in the active codebase (excluding `.git` samples).
**Suggested Improvement:** None required. Continue maintaining a clean codebase.

## 2. Duplicate Code Patterns (DRY Violations)

### Schema Duplication
**Priority:** High
**File Path:** `plugins/jules/servers/jules-mcp/src/index.ts` (lines 30+) vs `plugins/jules/servers/jules-mcp/src/tools.ts` (lines 7+)
**Description:** Zod schemas for tool inputs (e.g., `createTaskSchema`) are defined in `tools.ts` but then manually re-defined in `index.ts` when registering tools with the MCP server. This leads to maintenance drift where validation logic in `tools.ts` might differ from the schema advertised by the server in `index.ts`.
**Suggested Improvement:** Export the Zod schemas from `tools.ts` and use `zod-to-json-schema` or direct Zod usage in `index.ts` to ensure the server definition matches the implementation validation.

### Repeated Error Handling
**Priority:** Medium
**File Path:** `plugins/jules/servers/jules-mcp/src/tools.ts` (multiple occurrences)
**Description:** Every tool function in `createJulesTools` repeats the exact same `try-catch` block pattern:
```typescript
try {
  // ...
} catch (error) {
  if (error instanceof z.ZodError) {
    return errorResult(error.errors[0].message);
  }
  return errorResult((error as Error).message);
}
```
**Suggested Improvement:** Implement a higher-order function or wrapper (e.g., `withErrorHandling(fn)`) that wraps tool implementations and handles `ZodError` and generic `Error` uniformly.

## 3. Dead Code or Unused Exports

### Unused Schema Exports
**Priority:** Low
**File Path:** `plugins/jules/servers/jules-mcp/src/tools.ts` (line 54)
**Description:** `toolSchemas` is exported but not used in the production code (`index.ts`). It is only used in tests. While useful for testing, its non-usage in `index.ts` confirms the duplication issue mentioned above.
**Suggested Improvement:** Refactor `index.ts` to consume `toolSchemas`, effectively resolving the dead code and duplication issues simultaneously.

## 4. Functions Exceeding 50 Lines (Complexity)

### Giant Factory Function
**Priority:** High
**File Path:** `plugins/jules/servers/jules-mcp/src/tools.ts` (lines 160-350+)
**Description:** The `createJulesTools` function is approximately 200 lines long. It violates the Single Responsibility Principle by containing the implementation details of all 8 tools. This makes the file hard to navigate and test in isolation.
**Suggested Improvement:** Extract each tool's implementation into separate functions or a class structure. `createJulesTools` should only return the map of these functions, or use a command pattern.

### Long Bash Functions
**Priority:** Medium
**File Path:** `scripts/workflow-state.sh` (lines 150-240, 280-380)
**Description:** `cmd_summary` (~90 lines) and `cmd_next_action` (~100 lines) are quite long and contain complex nested logic (conditionals, `jq` parsing).
**Suggested Improvement:** Break down these functions. For `cmd_next_action`, separate the debug workflow logic and feature workflow logic into distinct functions (e.g., `get_debug_next_action`, `get_feature_next_action`).

## 5. Missing Error Handling

### Top-Level Await Crash Risk
**Priority:** Medium
**File Path:** `plugins/jules/servers/jules-mcp/src/index.ts` (last line)
**Description:** The server connection `await server.connect(transport);` is at the top level without a `try-catch`. If the connection fails (e.g., stdio issues), the process will crash with an unhandled rejection, potentially without logging a useful error message to stderr.
**Suggested Improvement:** Wrap the startup logic in an async `main()` function with a `try-catch` block that logs errors to `console.error` and exits with a non-zero code.

### Temporary File Cleanup
**Priority:** Low
**File Path:** `scripts/workflow-state.sh` (line 138)
**Description:** `local tmp=$(mktemp)` creates a temporary file. If the script exits early (e.g., via `set -e` failure in `jq`), the temporary file is left in `/tmp`.
**Suggested Improvement:** Use `trap` to ensure temporary files are deleted on script exit: `trap 'rm -f "$tmp"' EXIT`.

## 6. Outdated Patterns

### None Critical
**Priority:** Low
**File Path:** N/A
**Description:** The codebase generally follows modern practices (TypeScript `zod`, `fetch`, Bash `set -euo pipefail`).
**Suggested Improvement:** N/A

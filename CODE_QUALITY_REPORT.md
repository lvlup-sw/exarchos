# Code Quality Analysis Report

## 1. TODO/FIXME/HACK Comments
*No significant TODO/FIXME/HACK comments found in tracked source files.*

## 2. Duplicate Code Patterns (DRY Violations)

### Finding 2.1: Repeated Error Handling in Tool Implementations
- **Priority:** Medium
- **File Path:** `plugins/jules/servers/jules-mcp/src/tools.ts` (multiple locations)
- **Description:** Each of the 8 tool functions (e.g., `jules_list_sources`, `jules_create_task`, etc.) implements the exact same try-catch block structure. It calls the client method, wraps the result in `jsonResult`, and catches errors to return `errorResult` (checking for Zod errors explicitly).
- **Suggested Improvement:** Create a higher-order function or a wrapper helper (e.g., `createToolHandler`) that accepts the schema and the implementation function. This wrapper can handle the `try-catch`, Zod parsing, and standard response formatting centrally.

## 3. Dead Code or Unused Exports

### Finding 3.1: Reference to Non-Existent Configuration File
- **Priority:** High
- **File Path:** `scripts/validate-templates.sh` (Line 147, and loop at Line 66)
- **Description:** The script checks for `coderabbit-config/config.yaml` to exist and validates files in that directory. However, the repository uses `.coderabbit.yaml` in the root, and the `coderabbit-config` directory does not exist. This causes the validation script to potentially fail or miss the actual config file.
- **Suggested Improvement:** Update the script to check for `.coderabbit.yaml` instead of `coderabbit-config/config.yaml`.

### Finding 3.2: Broken Link to Missing Skill
- **Priority:** Medium
- **File Path:** `commands/sync-schemas.md` (Line 7)
- **Description:** The documentation references `@skills/sync-schemas/SKILL.md`, but the `skills/sync-schemas` directory does not exist in the repository.
- **Suggested Improvement:** Create the missing skill documentation or update the link to point to the correct location if it was moved/renamed.

## 4. Functions Exceeding 50 Lines (Complexity)

### Finding 4.1: Excessive Length of `createJulesTools`
- **Priority:** Low
- **File Path:** `plugins/jules/servers/jules-mcp/src/tools.ts` (Line 133 - ~380)
- **Description:** The `createJulesTools` function is approximately 250 lines long because it defines all tool implementations inline. This makes the file hard to read and maintain.
- **Suggested Improvement:** Extract each tool's implementation into a separate function or file. `createJulesTools` should only be responsible for aggregating them into the return object.

### Finding 4.2: Complex Conditional Logic in `getActivityContent`
- **Priority:** Medium
- **File Path:** `plugins/jules/servers/jules-mcp/src/tools.ts` (Line 68 - 108)
- **Description:** The function uses a long chain of `if/return` statements to determine content based on activity type. It also contains nested logic for `planGenerated`.
- **Suggested Improvement:** Use a strategy pattern or a map of handlers keyed by activity type to simplify the logic.

## 5. Missing Error Handling

### Finding 5.1: Generic Fetch Error Handling
- **Priority:** Medium
- **File Path:** `plugins/jules/servers/jules-mcp/src/jules-client.ts` (Line 23)
- **Description:** The `request` method uses `fetch` but only checks `!response.ok`. Network errors (like DNS failure, timeout) will throw raw errors that are not explicitly handled or wrapped with context until they reach the top-level tool handler.
- **Suggested Improvement:** Wrap the `fetch` call in a try-catch block to handle network-level errors specifically (e.g., distinguishing between "server error" and "network unreachable").

## 6. Outdated Patterns

### Finding 6.1: Manual Environment Variable Validation
- **Priority:** Low
- **File Path:** `plugins/jules/servers/jules-mcp/src/index.ts` (Line 9)
- **Description:** The code manually checks `process.env.JULES_API_KEY` and logs to console/exits.
- **Suggested Improvement:** Use a configuration library (like `dotenv` combined with `zod` or `envalid`) to ensure type-safe and centralized environment variable validation at startup.

### Finding 6.2: Use of Loose Types
- **Priority:** Low
- **File Path:** `plugins/jules/servers/jules-mcp/src/tools.ts` (Line 89)
- **Description:** The code uses `(s: unknown)` and type assertions in `getActivityContent`.
- **Suggested Improvement:** Define proper Zod schemas or TypeScript interfaces for the plan steps structure and use a type guard function.

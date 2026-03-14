# Dead Code Patterns

Reference guide for identifying, classifying, and triaging dead code in backend systems.

## Dead Code Categories

### 1. Unreachable Code

Code that can never execute because control flow prevents reaching it.

**Examples:**
- Statements after unconditional `return`, `throw`, `break`, or `continue`
- Branches guarded by conditions that are always false (e.g., `if (false)`, constant expressions)
- `catch` blocks for exceptions that are never thrown by the `try` body
- `switch` cases for enum values that no longer exist

**Detection heuristics:**
- Static analysis tools (TypeScript `--noUnusedLocals`, ESLint `no-unreachable`)
- Grep for code after `return`/`throw` at the same indentation level
- Analyze control flow graphs for unreachable nodes
- Look for `if` conditions comparing against removed enum values or deleted constants

### 2. Unused Exports

Symbols that are exported from a module but never imported by any other module.

**Examples:**
- Functions exported from a utility module that no consumer calls
- Types/interfaces exported but never referenced externally
- Re-exports from barrel files (`index.ts`) where the re-exported symbol has no importers
- Constants exported "just in case" during initial development

**Detection heuristics:**
- Grep for the export name across all importing files; zero hits means unused
- Use `ts-prune`, `knip`, or similar tools to detect unused exports
- Analyze barrel file re-exports: if the barrel is imported but only a subset of its exports are used, the rest are dead
- Check test files separately — an export used only in tests may still be dead from a production perspective

### 3. Commented-Out Code

Code that has been commented out rather than deleted. Version control exists for history.

**Examples:**
- Block comments containing syntactically valid code
- Lines prefixed with `//` that contain function calls, variable assignments, or imports
- `/* ... */` blocks wrapping entire functions or class methods
- TODO comments referencing code that should be "re-enabled" but never was

**Detection heuristics:**
- Grep for multi-line comments containing keywords like `function`, `const`, `import`, `export`, `class`, `return`
- Look for `// ` followed by valid statement syntax (assignments, function calls)
- Identify comments with version control references ("removed in v2", "old implementation")
- Check git blame — if commented-out code has been that way for more than 2 sprints, it is dead

### 4. Feature-Flagged-Off Code

Code behind feature flags that have been permanently disabled or the flag has shipped long ago.

**Examples:**
- `if (featureFlags.enableNewParser)` where the flag has been `false` in all environments for months
- A/B test branches where the experiment concluded and only one path is active
- Migration code behind a flag that completed its rollout
- Fallback paths for flags that have been `true` in production for multiple releases

**Detection heuristics:**
- Cross-reference feature flag names with the flag configuration store
- Analyze flag usage: if a flag is always `true` or always `false` across all environments, the guarded code (or its inverse) is dead
- Check flag creation dates — flags older than 90 days without recent changes are candidates
- Look for TODO comments referencing flag cleanup

## False Positive Guidance

Not all apparently unused code is dead. Be cautious with:

- **Intentional stubs:** Interface methods with empty bodies that exist to satisfy a contract, or template methods meant for subclass override
- **Forward declarations:** Types or constants declared for planned but not-yet-implemented features (check the roadmap/backlog before flagging)
- **Public API surface:** Libraries and packages intentionally export symbols for external consumers; check if the module is consumed outside the repository
- **Plugin entry points:** Functions registered via reflection, dependency injection, or naming convention (e.g., `handle_*`, `on_*`) that are invoked dynamically
- **Test helpers and fixtures:** Utility functions in test support files that may be imported conditionally or by test files not in the current scope
- **Event handlers and callbacks:** Functions registered as listeners that are invoked indirectly through event dispatch

**Verification steps before reporting:**
1. Search the entire repository, not just the immediate module
2. Check for dynamic invocation patterns (reflection, `eval`, dynamic imports)
3. Look for references in configuration files, scripts, and documentation
4. Verify whether the module is published as a package with external consumers

## Severity Guide

### HIGH Severity — Misleading Dead Code

Dead code that actively misleads developers or creates risk:

- Commented-out code that appears to be an alternative implementation, confusing future readers about which path is correct
- Unreachable error handling that gives false confidence about fault tolerance
- Unused exports that appear in IDE autocomplete, leading developers to use dead APIs
- Feature-flagged code where the flag check masks a bug in the "live" path

### MEDIUM Severity — Noise

Dead code that adds cognitive load without active harm:

- Unused utility functions that clutter the module
- Old commented-out code that has been superseded by a different approach
- Barrel file re-exports of symbols no one imports
- Test helpers that are no longer called by any test

### LOW Severity — Minor

Dead code with minimal impact:

- Single unused constants or type aliases
- Commented-out log/debug statements
- Unused function parameters (often enforced by interface contracts)
- Empty catch blocks that were once meaningful but the try body changed

## Examples

### HIGH: Misleading unreachable error handler

```typescript
async function processOrder(order: Order): Promise<Result> {
  const validated = validateOrder(order);
  return submitOrder(validated);

  // This catch-all never executes — gives false sense of error handling
  try {
    return submitOrder(validated);
  } catch (error) {
    await notifyOps(error);
    return { status: 'failed', error };
  }
}
```

### MEDIUM: Unused export cluttering module

```typescript
// utils.ts
export function formatDate(d: Date): string { /* ... */ }
export function parseDate(s: string): Date { /* ... */ }
export function dateToEpoch(d: Date): number { /* ... */ } // zero importers
```

### LOW: Commented-out debug logging

```typescript
function handleRequest(req: Request) {
  // console.log('incoming request:', req.headers);
  return processRequest(req);
}
```

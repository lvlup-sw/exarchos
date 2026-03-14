# Deterministic Check Catalog

Grep patterns and structural checks organized by dimension. The `scan` skill executes these checks mechanically. Other skills invoke `scan` for their dimensions, then layer qualitative assessment.

Each check has: ID, pattern, what it detects, severity, and false-positive guidance.

## DIM-1: Topology

### T-1.1: Module-global mutable state
- **Pattern:** `^(let|var)\s+\w+\s*[:=]` at file scope (not inside function/class body)
- **Severity:** MEDIUM
- **Detects:** Ambient state that can diverge across module boundaries
- **False positives:** Intentional singletons with documented rationale; module-scoped constants that happen to use `let`

### T-1.2: Lazy fallback constructors
- **Pattern:** `if\s*\(\s*!\w+\s*\)\s*\{?\s*\w+\s*=\s*new\s`
- **Severity:** HIGH
- **Detects:** Degraded-mode instances created silently when wiring is missing
- **False positives:** Intentional lazy initialization with logging/telemetry

### T-1.3: Manual wiring functions
- **Pattern:** `^export\s+(async\s+)?function\s+(configure|register|setup|init)\w+\s*\(`
- **Severity:** MEDIUM
- **Detects:** Manual dependency wiring that requires correct call order
- **False positives:** Framework-required setup functions (e.g., Express middleware registration)

## DIM-2: Observability

### T-2.1: Empty catch blocks
- **Pattern:** `catch\s*(\(\w*\))?\s*\{\s*\}`
- **Severity:** HIGH
- **Detects:** Errors swallowed silently with no handling
- **False positives:** Intentional swallow with comment explaining rationale (rare, should be flagged for review)

### T-2.2: Catch with only console.log
- **Pattern:** `catch\s*\(\w+\)\s*\{\s*console\.(log|warn)\(`
- **Severity:** MEDIUM
- **Detects:** Error "handling" that only logs without context or recovery
- **False positives:** Development-only logging in test helpers

### T-2.3: Swallowed promise rejections
- **Pattern:** `\.catch\(\s*\(\)\s*=>\s*\{?\s*\}?\s*\)`
- **Severity:** HIGH
- **Detects:** Promise rejections silently ignored
- **False positives:** Intentional fire-and-forget with documented rationale

## DIM-3: Contracts

### T-3.1: Unsafe type assertions
- **Pattern:** `\bas\s+\w+` (excluding `as const`)
- **Severity:** MEDIUM
- **Detects:** Type assertions that bypass TypeScript's type checking
- **False positives:** Assertions after validated guards (e.g., `as Foo` after `instanceof Foo` check)

### T-3.2: Non-null assertions
- **Pattern:** `\w+!\.` or `\w+!\[`
- **Severity:** MEDIUM
- **Detects:** Non-null assertions that assume a value exists without checking
- **False positives:** Assertions after explicit null checks in the same scope

### T-3.3: Schema-type divergence (manual check)
- **Pattern:** Compare Zod schemas against TypeScript interfaces for missing/extra fields
- **Severity:** HIGH
- **Detects:** Runtime schema doesn't match compile-time types
- **False positives:** Intentional partial schemas (e.g., input validation that accepts a subset)

## DIM-4: Test Fidelity

### T-4.1: Skipped tests
- **Pattern:** `(describe|it|test)\.(skip|todo)\(`
- **Severity:** MEDIUM
- **Detects:** Tests that are disabled without tracked resolution
- **False positives:** Tests with linked issue references (`// TODO(#123)`)

### T-4.2: Mock-heavy tests
- **Pattern:** Count `vi\.mock|jest\.mock|sinon\.stub` per test file; flag if >3
- **Severity:** MEDIUM
- **Detects:** Over-isolation that hides integration behavior
- **False positives:** Tests for modules with many infrastructure boundaries

### T-4.3: Test setup divergence (manual check)
- **Pattern:** Compare test factory/setup functions against production initialization code
- **Severity:** HIGH
- **Detects:** Test wiring that doesn't match production wiring
- **False positives:** Intentional test-only configuration (e.g., in-memory DB for speed)

## DIM-5: Hygiene

### T-5.1: Commented-out code blocks
- **Pattern:** `^\s*\/\/\s*(function|class|const|let|var|if|for|while|return|export)\s` (3+ consecutive lines)
- **Severity:** MEDIUM
- **Detects:** Code preserved in comments instead of version control
- **False positives:** Documentation examples that happen to look like commented code

### T-5.2: Unused exports
- **Pattern:** Cross-reference `export` declarations against `import` statements project-wide
- **Severity:** LOW
- **Detects:** Exported symbols with no consumers
- **False positives:** Public API surface intentionally exported for external consumers

### T-5.3: Unreachable code
- **Pattern:** Code after unconditional `return`, `throw`, `break`, or `continue`
- **Severity:** MEDIUM
- **Detects:** Dead code that can never execute
- **False positives:** Generated code with defensive returns

## DIM-6: Architecture

### T-6.1: Circular imports
- **Pattern:** Build import graph; detect cycles
- **Severity:** HIGH
- **Detects:** Circular dependencies between modules
- **False positives:** Type-only imports that don't create runtime cycles

### T-6.2: God objects
- **Pattern:** Files with >500 lines or classes/objects with >10 exported members
- **Severity:** MEDIUM
- **Detects:** Modules with too many responsibilities
- **False positives:** Intentional facades or barrel files

### T-6.3: Dependency direction violations
- **Pattern:** Core/domain modules importing from infrastructure/CLI/UI modules
- **Severity:** MEDIUM
- **Detects:** Inverted dependency direction (core depends on periphery)
- **False positives:** Requires project-specific layer definitions to assess accurately

## DIM-7: Resilience

### T-7.1: Unbounded collections
- **Pattern:** `new\s+(Map|Set|Array)\s*\(` without nearby `.delete`, `.clear`, or size check
- **Severity:** HIGH
- **Detects:** Collections that grow without bound
- **False positives:** Collections with short, bounded lifetimes (e.g., within a request handler)

### T-7.2: Missing timeouts
- **Pattern:** `fetch\(` or `http\.(get|post|put)` without `signal`, `timeout`, or `AbortController`
- **Severity:** MEDIUM
- **Detects:** External calls that could hang indefinitely
- **False positives:** Calls to localhost services with guaranteed fast response

### T-7.3: Unbounded retry loops
- **Pattern:** `while\s*\(.*retry` or `for\s*\(.*attempt` without max limit
- **Severity:** HIGH
- **Detects:** Retry logic that could loop forever
- **False positives:** Loops with break conditions that aren't pattern-matched

## Extensibility

Projects can add custom checks via `.assay/checks.md` at the repo root. Format matches this file — one section per dimension, each check with pattern, severity, description, and false-positive guidance. Custom checks are loaded alongside the built-in catalog by the `scan` skill.

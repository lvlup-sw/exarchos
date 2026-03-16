// ─── Quality Check Catalog ────────────────────────────────────────────────────
//
// Structured catalog of quality checks that any LLM agent can execute to assess
// code quality. Each check provides grep patterns, structural heuristics, or
// threshold-based rules with actionable remediation guidance.
// ──────────────────────────────────────────────────────────────────────────────

export type CheckExecution = 'grep' | 'structural' | 'heuristic';
export type CheckSeverity = 'HIGH' | 'MEDIUM' | 'LOW';

export interface Check {
  readonly id: string;
  readonly execution: CheckExecution;
  readonly severity: CheckSeverity;
  readonly description: string;
  readonly pattern?: string;
  readonly fileGlob?: string;
  readonly multiline?: boolean;
  readonly threshold?: number;
  readonly remediation: string;
  readonly falsePositives: string;
}

export interface CatalogDimension {
  readonly id: string;
  readonly name: string;
  readonly checks: readonly Check[];
}

export interface CheckCatalog {
  readonly version: string;
  readonly dimensions: readonly CatalogDimension[];
}

export interface PluginFinding {
  readonly source: string;
  readonly severity: CheckSeverity;
  readonly dimension?: string;
  readonly file?: string;
  readonly line?: number;
  readonly message: string;
}

export const QUALITY_CHECK_CATALOG: CheckCatalog = {
  version: '1.0.0',
  dimensions: [
    // ── Error Handling (EH) ─────────────────────────────────────────────────
    {
      id: 'error-handling',
      name: 'Error Handling',
      checks: [
        {
          id: 'EH-1',
          execution: 'grep',
          severity: 'HIGH',
          description: 'Empty catch blocks swallow errors silently',
          pattern: String.raw`catch\s*(\(\w*\))?\s*\{\s*\}`,
          fileGlob: '*.ts',
          remediation: 'Log the error, rethrow, or add a comment explaining why the catch is intentionally empty.',
          falsePositives: 'Intentionally empty catches with a justifying comment (e.g., fire-and-forget event emission).',
        },
        {
          id: 'EH-2',
          execution: 'grep',
          severity: 'MEDIUM',
          description: 'Console-only error handling loses structured error context',
          pattern: String.raw`catch\s*\(\w+\)\s*\{\s*console\.(log|warn|error)\(`,
          fileGlob: '*.ts',
          remediation: 'Use a structured logger or rethrow with context. Console methods are insufficient for production error tracking.',
          falsePositives: 'CLI tools or scripts where console output is the intended error channel.',
        },
        {
          id: 'EH-3',
          execution: 'grep',
          severity: 'HIGH',
          description: 'Swallowed promise rejections hide async failures',
          pattern: String.raw`\.catch\(\s*\(\)\s*=>\s*\{?\s*\}?\s*\)`,
          fileGlob: '*.ts',
          remediation: 'Handle the rejection explicitly or log it. Swallowed rejections make debugging async issues extremely difficult.',
          falsePositives: 'Cleanup operations where failure is acceptable and documented.',
        },
      ],
    },

    // ── Type Safety (TS) ────────────────────────────────────────────────────
    {
      id: 'type-safety',
      name: 'Type Safety',
      checks: [
        {
          id: 'TS-1',
          execution: 'grep',
          severity: 'MEDIUM',
          description: 'Unsafe type assertions bypass compile-time type checking',
          pattern: String.raw`\bas\s+(?!const\b)\w+`,
          fileGlob: '*.ts',
          remediation: 'Use type guards, discriminated unions, or schema validation (e.g., Zod) instead of type assertions.',
          falsePositives: 'Assertions to `as const` are safe. Test files may legitimately assert to narrow mock types.',
        },
        {
          id: 'TS-2',
          execution: 'grep',
          severity: 'MEDIUM',
          description: 'Non-null assertions (!) bypass strict null checks',
          pattern: String.raw`\w+!\.\w+`,
          fileGlob: '*.ts',
          remediation: 'Add a null check or use optional chaining (?.) with a fallback value.',
          falsePositives: 'Cases where a preceding guard guarantees non-null, but the compiler cannot infer it.',
        },
      ],
    },

    // ── Test Quality (TQ) ───────────────────────────────────────────────────
    {
      id: 'test-quality',
      name: 'Test Quality',
      checks: [
        {
          id: 'TQ-1',
          execution: 'grep',
          severity: 'MEDIUM',
          description: 'Skipped or todo tests reduce coverage and indicate incomplete work',
          pattern: String.raw`(describe|it|test)\.(skip|todo)\(`,
          fileGlob: '*.test.ts',
          remediation: 'Either fix the test so it can run, or remove it and track the gap in a backlog item.',
          falsePositives: 'Tests temporarily skipped during active TDD with a linked tracking issue.',
        },
        {
          id: 'TQ-2',
          execution: 'structural',
          severity: 'MEDIUM',
          description: 'Mock-heavy tests (>3 mocks per file) may not test real behavior',
          pattern: String.raw`(vi|jest)\.mock\(`,
          fileGlob: '*.test.ts',
          threshold: 3,
          remediation: 'Reduce mocking by using dependency injection or testing against real implementations where feasible.',
          falsePositives: 'Integration-style test files that legitimately mock external boundaries (HTTP, DB).',
        },
        {
          id: 'TQ-3',
          execution: 'grep',
          severity: 'HIGH',
          description: '.only left in tests restricts the test suite to a single test/suite',
          pattern: String.raw`(describe|it|test)\.only\(`,
          fileGlob: '*.test.ts',
          remediation: 'Remove .only before committing. Use a pre-commit hook or CI check to prevent this.',
          falsePositives: 'None — .only should never be committed.',
        },
      ],
    },

    // ── Code Hygiene (CH) ───────────────────────────────────────────────────
    {
      id: 'code-hygiene',
      name: 'Code Hygiene',
      checks: [
        {
          id: 'CH-1',
          execution: 'grep',
          severity: 'MEDIUM',
          description: 'Commented-out code blocks add noise and indicate incomplete cleanup',
          pattern: String.raw`^\s*\/\/\s*(function|class|const|let|var|if|for|while|return|export)\s`,
          fileGlob: '*.ts',
          remediation: 'Delete commented-out code. Use version control history to recover old code if needed.',
          falsePositives: 'Documentation comments that happen to reference keywords (e.g., "// function signature: ...").',
        },
        {
          id: 'CH-2',
          execution: 'grep',
          severity: 'LOW',
          description: 'TODO/FIXME/HACK/XXX markers indicate unfinished work',
          pattern: String.raw`(TODO|FIXME|HACK|XXX)\b`,
          fileGlob: '*.ts',
          remediation: 'Resolve the issue or create a backlog item and reference it in the comment.',
          falsePositives: 'Intentional TODOs with linked issue numbers that are actively tracked.',
        },
        {
          id: 'CH-3',
          execution: 'heuristic',
          severity: 'MEDIUM',
          description: 'Code after unconditional return/throw is unreachable',
          fileGlob: '*.ts',
          remediation: 'Remove the unreachable code or restructure the control flow.',
          falsePositives: 'Code after a conditional return that the heuristic cannot distinguish from an unconditional one.',
        },
      ],
    },

    // ── Structural Complexity (SC) ──────────────────────────────────────────
    {
      id: 'structural-complexity',
      name: 'Structural Complexity',
      checks: [
        {
          id: 'SC-1',
          execution: 'structural',
          severity: 'MEDIUM',
          description: 'Functions with >3 levels of nesting are hard to follow and test',
          fileGlob: '*.ts',
          threshold: 3,
          remediation: 'Extract nested logic into helper functions or use early returns to flatten nesting.',
          falsePositives: 'AST visitors or recursive descent parsers where deep nesting reflects the grammar structure.',
        },
        {
          id: 'SC-2',
          execution: 'structural',
          severity: 'MEDIUM',
          description: 'Functions exceeding 50 lines are difficult to understand and maintain',
          fileGlob: '*.ts',
          threshold: 50,
          remediation: 'Break the function into smaller, focused functions with descriptive names.',
          falsePositives: 'Data definition functions (e.g., large switch/case mappings, configuration objects).',
        },
        {
          id: 'SC-3',
          execution: 'structural',
          severity: 'MEDIUM',
          description: 'Files with >500 lines suggest the module has too many responsibilities',
          fileGlob: '*.ts',
          threshold: 500,
          remediation: 'Split the file along cohesive boundaries — group related exports into separate modules.',
          falsePositives: 'Generated files, schema definitions, or test suites with many cases.',
        },
        {
          id: 'SC-4',
          execution: 'grep',
          severity: 'MEDIUM',
          description: 'Long parameter lists (5+) suggest a function does too much or needs an options object',
          pattern: String.raw`\([^)]*,\s*[^)]*,\s*[^)]*,\s*[^)]*,\s*[^)]*\)`,
          fileGlob: '*.ts',
          remediation: 'Group related parameters into an options/config object.',
          falsePositives: 'Destructured parameters that are visually long but logically a single options object.',
        },
      ],
    },

    // ── Resilience (RS) ─────────────────────────────────────────────────────
    {
      id: 'resilience',
      name: 'Resilience',
      checks: [
        {
          id: 'RS-1',
          execution: 'grep',
          severity: 'MEDIUM',
          description: 'Unbounded collections (Map/Set/Array) can cause memory leaks without cleanup',
          pattern: String.raw`new\s+(Map|Set|Array)\s*\(`,
          fileGlob: '*.ts',
          remediation: 'Add size bounds, TTL-based eviction, or ensure .delete/.clear is called on a lifecycle boundary.',
          falsePositives: 'Short-lived collections scoped to a single function call or request handler.',
        },
        {
          id: 'RS-2',
          execution: 'grep',
          severity: 'MEDIUM',
          description: 'fetch() calls without timeout can hang indefinitely',
          pattern: String.raw`fetch\(`,
          fileGlob: '*.ts',
          remediation: 'Use AbortController with a timeout signal, or pass a timeout option to the fetch wrapper.',
          falsePositives: 'Test stubs or mock fetch calls that do not make real network requests.',
        },
        {
          id: 'RS-3',
          execution: 'grep',
          severity: 'HIGH',
          description: 'Unbounded retry loops can cause infinite retries on persistent failures',
          pattern: String.raw`while\s*\(.*retr`,
          fileGlob: '*.ts',
          remediation: 'Add a maximum retry count, exponential backoff, and a circuit breaker or timeout.',
          falsePositives: 'Retry loops that already include a bounded counter checked in the while condition.',
        },
      ],
    },
  ],
} as const satisfies CheckCatalog;

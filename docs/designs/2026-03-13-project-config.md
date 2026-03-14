# Design: Per-Project Configuration via `.exarchos.yml`

**Date:** 2026-03-13
**Feature ID:** `extension-points`
**Related:** Issue #1024 (VCS provider abstraction), `2026-03-05-ga-extensibility.md` (config-driven custom workflows)

## Problem Statement

Exarchos ships opinionated defaults for review criteria, workflow behavior, VCS operations, and tool settings. These defaults work well for the common case but are not customizable without modifying core code. Users cannot:

- Adjust which quality gates are blocking vs advisory
- Change risk scoring thresholds for review routing
- Skip or reorder workflow phases for their team's process
- Select a VCS provider other than GitHub
- Configure commit conventions, auto-merge, or PR templates
- Hook into workflow events for external notifications

The GA extensibility design (`2026-03-05`) introduced `exarchos.config.ts` for programmatic custom workflow definitions. This design adds a complementary **declarative YAML layer** for end-user configuration of built-in behavior — no TypeScript required.

## Design Constraints

- **Per-project** — config lives in the repo, version-controlled, no per-user state
- **YAML** — declarative, supports comments, low barrier to entry
- **Sparse overlay** — unspecified fields use built-in defaults; empty/missing file = today's behavior
- **No presets** — presets can be added later as a non-breaking enhancement
- **No breaking changes** — the `exarchos.config.ts` path continues to work for programmatic extensions; `.exarchos.yml` handles declarative overrides

## Relationship to `exarchos.config.ts`

Two config surfaces, complementary scopes:

| Surface | Format | Scope | Users |
|---------|--------|-------|-------|
| `.exarchos.yml` | YAML | Override built-in defaults (review, VCS, workflow behavior, tools, hooks) | End users tweaking behavior |
| `exarchos.config.ts` | TypeScript | Define new workflow types, custom events, custom views, custom tools | Power users extending the system |

Both are loaded at MCP server startup. `.exarchos.yml` overrides are applied to the base defaults before `exarchos.config.ts` extensions are registered. This means custom workflows defined in TypeScript inherit the project's YAML overrides (e.g., a custom workflow gets the project's VCS provider and review settings).

```
Built-in defaults
       │
       ▼
.exarchos.yml overrides (deep merge)
       │
       ▼
Effective base config
       │
       ▼
exarchos.config.ts extensions (additive registration)
       │
       ▼
Runtime config
```

## Config Schema

### Full Example

```yaml
# .exarchos.yml
# All sections are optional. Unspecified = built-in defaults.

# --- Priority 1: Review Criteria ---
review:
  # Dimension-level defaults (D1-D5)
  # Values: "blocking" (default), "warning", "disabled"
  dimensions:
    D1: blocking        # Security & compliance — keep strict
    D2: blocking        # Static quality
    D3: warning         # Context economy — downgrade to advisory
    D4: blocking        # Operational resilience
    D5: disabled        # Workflow determinism — skip entirely

  # Gate-level overrides (take precedence over dimension severity)
  gates:
    security-scan:
      enabled: true
      blocking: true     # Always block on security
    tdd-compliance:
      blocking: false    # Advisory only
      params:
        coverage-threshold: 80
    complexity-threshold:
      params:
        max-cyclomatic: 15   # Default is 10
    error-handling-audit:
      enabled: false     # Skip for this project

  # Review routing
  routing:
    # Risk score threshold for CodeRabbit routing (0.0-1.0, default 0.4)
    coderabbit-threshold: 0.6
    # Risk factor weights (must sum to 1.0)
    risk-weights:
      security-path: 0.30
      api-surface: 0.20
      diff-complexity: 0.15
      new-files: 0.10
      infra-config: 0.15
      cross-module: 0.10

# --- Priority 2: VCS Provider ---
vcs:
  # github (default) | gitlab | azure-devops
  provider: github
  # Provider-specific settings
  settings:
    # GitHub
    auto-merge-strategy: squash   # squash | merge | rebase
    # GitLab: merge-method: merge-commit | squash | fast-forward
    # Azure DevOps: completion-type: squash | merge | rebase

# --- Priority 3: Workflow Behavior ---
workflow:
  # Phases to skip (applied to all built-in workflow types)
  skip-phases: []
  # Example: skip-phases: [plan-review]

  # Max fix cycles before circuit breaker (default: 3)
  max-fix-cycles: 3

  # Phase-specific overrides
  phases:
    plan-review:
      # Require human checkpoint (default: true)
      human-checkpoint: true
    synthesize:
      human-checkpoint: true

# --- Priority 4: Tool Behavior ---
tools:
  # Default branch for PRs (default: auto-detect from git)
  default-branch: main

  # Commit message style
  # conventional: "feat: ...", "fix: ...", etc.
  # freeform: no enforced format
  commit-style: conventional

  # PR template path (relative to repo root)
  pr-template: .github/pull_request_template.md

  # Auto-merge after CI passes (default: true)
  auto-merge: true

  # Stacked PR strategy
  # github-native: use --base targeting (default)
  # single: no stacking, one PR per feature
  pr-strategy: github-native

# --- Priority 5: Event Hooks ---
hooks:
  # Hook format: event-name → list of shell commands
  # Commands receive event data as JSON via stdin
  # Environment variables: $EXARCHOS_FEATURE_ID, $EXARCHOS_PHASE,
  #   $EXARCHOS_EVENT_TYPE, $EXARCHOS_WORKFLOW_TYPE
  on:
    workflow.transition:
      - command: 'echo "Phase changed to $EXARCHOS_PHASE" | slack-notify'
        timeout: 10000   # ms, default 30000
    gate.executed:
      - command: './scripts/report-gate-result.sh'
    synthesis.complete:
      - command: 'curl -X POST "$JIRA_WEBHOOK" -d @-'
```

### Section Schemas

#### `review`

```yaml
review:
  dimensions:
    # Key: D1 | D2 | D3 | D4 | D5
    # Value: "blocking" | "warning" | "disabled"
    #   OR object: { severity: blocking|warning, enabled: true|false }
    D1: blocking                          # shorthand
    D3: { severity: warning }             # longform (equivalent to "warning")

  gates:
    # Key: gate action name (from exarchos_orchestrate registry)
    # Value: object with optional fields
    <gate-name>:
      enabled: true          # default: true
      blocking: true         # default: inherits from dimension
      params:                # gate-specific parameters
        <key>: <value>

  routing:
    coderabbit-threshold: 0.4    # 0.0-1.0
    risk-weights:                # all 6 must sum to 1.0
      security-path: 0.30
      api-surface: 0.20
      diff-complexity: 0.15
      new-files: 0.10
      infra-config: 0.15
      cross-module: 0.10
```

#### `vcs`

```yaml
vcs:
  provider: github    # github | gitlab | azure-devops
  settings:
    # Provider-specific, validated per provider
    auto-merge-strategy: squash   # GitHub: squash | merge | rebase
    merge-method: squash          # GitLab: merge-commit | squash | fast-forward
    completion-type: squash       # Azure DevOps: squash | merge | rebase
```

#### `workflow`

```yaml
workflow:
  skip-phases:           # string[], phase names to skip
    - plan-review
  max-fix-cycles: 3      # 1-10, integer
  phases:
    <phase-name>:
      human-checkpoint: true|false
```

#### `tools`

```yaml
tools:
  default-branch: main
  commit-style: conventional | freeform
  pr-template: <relative-path>
  auto-merge: true|false
  pr-strategy: github-native | single
```

#### `hooks.on`

```yaml
hooks:
  on:
    <event-type>:           # any valid event type from event store
      - command: <string>   # shell command, receives event JSON on stdin
        timeout: 30000      # ms, optional
```

## Technical Design

### 1. Config Loading

The MCP server loads `.exarchos.yml` from the project root at startup, before processing `exarchos.config.ts`.

```typescript
// config/yaml-loader.ts
import { parse as parseYaml } from 'yaml';  // or built-in YAML parser
import { readFileSync, existsSync } from 'fs';

export interface ProjectConfig {
  readonly review?: ReviewConfig;
  readonly vcs?: VcsConfig;
  readonly workflow?: WorkflowConfig;
  readonly tools?: ToolsConfig;
  readonly hooks?: HooksConfig;
}

export function loadProjectConfig(projectRoot: string): ProjectConfig {
  const configPath = resolve(projectRoot, '.exarchos.yml');
  if (!existsSync(configPath)) return {};

  const raw = readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(raw);
  return validateProjectConfig(parsed);
}
```

### 2. Validation

Zod schemas validate the parsed YAML. Invalid sections fall back to defaults with warnings; valid sections are preserved (partial failure model).

```typescript
// config/yaml-schema.ts
import { z } from 'zod';

const DimensionSeverity = z.enum(['blocking', 'warning', 'disabled']);

const DimensionConfig = z.union([
  DimensionSeverity,  // shorthand: "blocking"
  z.object({          // longform: { severity: "warning", enabled: true }
    severity: DimensionSeverity.optional(),
    enabled: z.boolean().optional(),
  }),
]);

const GateConfig = z.object({
  enabled: z.boolean().optional(),
  blocking: z.boolean().optional(),
  params: z.record(z.unknown()).optional(),
}).strict();

const RiskWeights = z.object({
  'security-path': z.number().min(0).max(1),
  'api-surface': z.number().min(0).max(1),
  'diff-complexity': z.number().min(0).max(1),
  'new-files': z.number().min(0).max(1),
  'infra-config': z.number().min(0).max(1),
  'cross-module': z.number().min(0).max(1),
}).refine(
  (w) => Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1.0) < 0.01,
  { message: 'risk-weights must sum to 1.0' },
).optional();

const ReviewConfig = z.object({
  dimensions: z.record(
    z.enum(['D1', 'D2', 'D3', 'D4', 'D5']),
    DimensionConfig,
  ).optional(),
  gates: z.record(z.string(), GateConfig).optional(),
  routing: z.object({
    'coderabbit-threshold': z.number().min(0).max(1).optional(),
    'risk-weights': RiskWeights,
  }).optional(),
}).optional();

const VcsProvider = z.enum(['github', 'gitlab', 'azure-devops']);

const VcsConfig = z.object({
  provider: VcsProvider.optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
}).optional();

const PhaseOverride = z.object({
  'human-checkpoint': z.boolean().optional(),
});

const WorkflowConfig = z.object({
  'skip-phases': z.array(z.string()).optional(),
  'max-fix-cycles': z.number().int().min(1).max(10).optional(),
  phases: z.record(z.string(), PhaseOverride).optional(),
}).optional();

const ToolsConfig = z.object({
  'default-branch': z.string().optional(),
  'commit-style': z.enum(['conventional', 'freeform']).optional(),
  'pr-template': z.string().optional(),
  'auto-merge': z.boolean().optional(),
  'pr-strategy': z.enum(['github-native', 'single']).optional(),
}).optional();

const HookAction = z.object({
  command: z.string(),
  timeout: z.number().int().min(1000).max(300000).optional(),
});

const HooksConfig = z.object({
  on: z.record(z.string(), z.array(HookAction)).optional(),
}).optional();

export const ProjectConfigSchema = z.object({
  review: ReviewConfig,
  vcs: VcsConfig,
  workflow: WorkflowConfig,
  tools: ToolsConfig,
  hooks: HooksConfig,
}).strict();
```

### 3. Config Resolution

The config resolver deep-merges `.exarchos.yml` overrides onto built-in defaults to produce an effective config. This resolved config is then passed through the dispatch context.

```typescript
// config/resolve.ts

const DEFAULTS: ResolvedConfig = {
  review: {
    dimensions: {
      D1: 'blocking', D2: 'blocking', D3: 'blocking',
      D4: 'blocking', D5: 'blocking',
    },
    gates: {},  // no overrides — all gates use dimension defaults
    routing: {
      coderabbitThreshold: 0.4,
      riskWeights: {
        securityPath: 0.30, apiSurface: 0.20, diffComplexity: 0.15,
        newFiles: 0.10, infraConfig: 0.15, crossModule: 0.10,
      },
    },
  },
  vcs: { provider: 'github', settings: {} },
  workflow: {
    skipPhases: [],
    maxFixCycles: 3,
    phases: {},
  },
  tools: {
    defaultBranch: undefined,  // auto-detect
    commitStyle: 'conventional',
    prTemplate: undefined,
    autoMerge: true,
    prStrategy: 'github-native',
  },
  hooks: { on: {} },
};

export function resolveConfig(project: ProjectConfig): ResolvedConfig {
  return deepMerge(DEFAULTS, normalize(project));
}
```

### 4. Integration with Dispatch Context

The resolved config is added to `DispatchContext` and flows through to all handlers:

```typescript
// core/dispatch.ts
export interface DispatchContext {
  readonly stateDir: string;
  readonly eventStore: EventStore;
  readonly enableTelemetry: boolean;
  readonly config?: ExarchosConfig;       // existing: programmatic extensions
  readonly projectConfig?: ResolvedConfig; // new: YAML overrides
}
```

### 5. Gate Severity Resolution

When a gate executes, it checks the resolved config to determine if it should block:

```typescript
// orchestrate/gate-severity.ts
export function resolveGateSeverity(
  gateName: string,
  dimension: string,
  config: ResolvedConfig,
): 'blocking' | 'warning' | 'disabled' {
  // Gate-level override takes precedence
  const gateOverride = config.review.gates[gateName];
  if (gateOverride) {
    if (gateOverride.enabled === false) return 'disabled';
    if (gateOverride.blocking === true) return 'blocking';
    if (gateOverride.blocking === false) return 'warning';
  }

  // Fall back to dimension-level setting
  const dimConfig = config.review.dimensions[dimension as DimensionKey];
  if (dimConfig === 'disabled') return 'disabled';
  if (dimConfig === 'warning') return 'warning';
  return 'blocking';
}
```

Gate handlers use this resolution to determine their behavior:

```typescript
// In a gate handler (e.g., orchestrate/check-tdd-compliance.ts)
const severity = resolveGateSeverity('tdd-compliance', 'D5', ctx.projectConfig);

if (severity === 'disabled') {
  return { success: true, data: { skipped: true, reason: 'disabled by project config' } };
}

// ... run the actual check ...

const result = { passed, findings, severity };

// If severity is 'warning', the gate emits the event but doesn't block phase transition
return {
  success: true,
  data: result,
  warnings: severity === 'warning' && !passed
    ? [`Gate ${gateName} failed but is configured as warning-only`]
    : undefined,
};
```

### 6. VCS Provider Abstraction

The VCS provider config feeds into a provider interface used by synthesis, shepherd, and PR-fixes:

```typescript
// vcs/provider.ts
export interface VcsProvider {
  readonly name: 'github' | 'gitlab' | 'azure-devops';
  createPr(opts: CreatePrOpts): Promise<PrResult>;
  checkCi(prId: string): Promise<CiStatus>;
  mergePr(prId: string, strategy: string): Promise<MergeResult>;
  addComment(prId: string, body: string): Promise<void>;
  getReviewStatus(prId: string): Promise<ReviewStatus>;
}

// vcs/github.ts — wraps `gh` CLI
// vcs/gitlab.ts — wraps `glab` CLI
// vcs/azure-devops.ts — wraps `az repos` CLI

export function createVcsProvider(config: ResolvedConfig): VcsProvider {
  switch (config.vcs.provider) {
    case 'github': return new GitHubProvider(config.vcs.settings);
    case 'gitlab': return new GitLabProvider(config.vcs.settings);
    case 'azure-devops': return new AzureDevOpsProvider(config.vcs.settings);
  }
}
```

### 7. Workflow Phase Skipping

Skip-phases modifies the HSM at initialization time by marking transitions that bypass skipped phases:

```typescript
// workflow/phase-skip.ts
export function applyPhaseSkips(
  hsm: HSMDefinition,
  skipPhases: readonly string[],
): HSMDefinition {
  if (skipPhases.length === 0) return hsm;

  let transitions = hsm.transitions.map(t => ({ ...t }));

  for (const skip of skipPhases) {
    // Collect ALL outgoing transitions (handles multi-branch phases)
    const outgoings = transitions.filter(t => t.from === skip);
    if (outgoings.length === 0) continue;

    // For each incoming, create replacement transitions to all outgoing targets
    // Guard, effects, and isFixCycle are inherited from outgoing transitions
    const newTransitions = [];
    for (const t of transitions) {
      if (t.to === skip) {
        for (const outgoing of outgoings) {
          newTransitions.push({
            ...t, to: outgoing.to,
            guard: outgoing.guard ?? t.guard,
            effects: outgoing.effects ?? t.effects,
            isFixCycle: outgoing.isFixCycle ?? t.isFixCycle,
          });
        }
      } else if (t.from !== skip) {
        newTransitions.push(t);
      }
    }
    transitions = newTransitions;
  }

  return { ...hsm, transitions };
}
```

### 8. Event Hooks

When events are appended to the store, the hook system checks for matching config hooks and executes them:

```typescript
// hooks/config-hooks.ts
export function createConfigHookRunner(
  config: ResolvedConfig,
): (event: WorkflowEvent) => Promise<void> {
  return async (event) => {
    const handlers = config.hooks.on[event.type];
    if (!handlers?.length) return;

    const env = {
      EXARCHOS_FEATURE_ID: event.featureId,
      EXARCHOS_PHASE: event.data?.phase ?? '',
      EXARCHOS_EVENT_TYPE: event.type,
      EXARCHOS_WORKFLOW_TYPE: event.data?.workflowType ?? '',
    };

    for (const handler of handlers) {
      const proc = spawn('sh', ['-c', handler.command], {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: handler.timeout ?? 30000,
      });

      // Pipe event data as JSON to stdin
      proc.stdin.write(JSON.stringify(event));
      proc.stdin.end();

      // Fire-and-forget — hooks don't block the event pipeline
      proc.on('error', (err) => {
        console.error(`Config hook failed for ${event.type}: ${err.message}`);
      });
    }
  };
}
```

### 9. Discoverability: `exarchos_workflow describe` Extension

Users can inspect the effective config (defaults + overrides) via the describe action:

```typescript
// New describe option: config
// exarchos_workflow describe with config: true
// Returns the resolved project config with annotations showing
// which values are defaults vs overrides

{
  "action": "describe",
  "config": true
}

// Response:
{
  "review": {
    "dimensions": {
      "D1": { "value": "blocking", "source": "default" },
      "D3": { "value": "warning", "source": ".exarchos.yml" }
    },
    "gates": {
      "tdd-compliance": {
        "blocking": { "value": false, "source": ".exarchos.yml" },
        "params": {
          "coverage-threshold": { "value": 80, "source": ".exarchos.yml" }
        }
      }
    }
  },
  "vcs": {
    "provider": { "value": "github", "source": "default" }
  }
  // ...
}
```

## Project Root Discovery

The MCP server needs to find the project root to locate `.exarchos.yml`. Strategy:

1. Check `$EXARCHOS_PROJECT_ROOT` environment variable (explicit override)
2. Walk up from the current working directory looking for `.exarchos.yml`
3. Fall back to git root (`git rev-parse --show-toplevel`)
4. If none found, use CWD and assume no project config

This aligns with how other tools (ESLint, Prettier, TypeScript) discover their config files.

## Validation Error Reporting

Config validation errors are reported clearly with path and suggestion:

```
Error loading .exarchos.yml:

  review.dimensions.D6: Invalid dimension key
    Valid keys: D1, D2, D3, D4, D5

  review.routing.risk-weights: Values must sum to 1.0
    Current sum: 0.85

  hooks.on.invalid-event: Unknown event type
    Did you mean: workflow.transition?
```

The MCP server logs these errors and falls back to defaults for invalid sections (partial failure, not total failure).

## Implementation Requirements

### R1: YAML Config Loader
Load and validate `.exarchos.yml` from project root. Zod schema validation with clear error messages. Partial failure: invalid sections fall back to defaults.
**Acceptance criteria:**
- Missing file returns empty config (today's behavior preserved)
- Valid file parses all 5 sections
- Invalid sections produce actionable error messages
- Unknown keys are rejected (`strict()` mode)

### R2: Config Resolution
Deep-merge YAML overrides onto built-in defaults. Produce `ResolvedConfig` available via `DispatchContext`.
**Acceptance criteria:**
- Unspecified fields use built-in defaults
- Gate-level overrides take precedence over dimension-level
- Dimension shorthand (`D3: warning`) normalizes to full object
- Resolved config is immutable (frozen)

### R3: Gate Severity Resolution
Orchestrate gate handlers check resolved config for severity (blocking/warning/disabled).
**Acceptance criteria:**
- Disabled gates skip execution and return `{ skipped: true }`
- Warning gates execute but don't block phase transitions
- Gate-level `blocking` overrides dimension-level severity
- Existing gate handler tests pass without modification when config is absent

### R4: VCS Provider Interface
Abstract VCS operations behind a provider interface. Implement GitHub provider (extract from current hardcoded `gh` calls). Stub GitLab and Azure DevOps providers.
**Acceptance criteria:**
- GitHub provider passes existing synthesis/shepherd tests
- Provider is selected from resolved config
- GitLab/Azure DevOps providers return clear "not yet implemented" errors
- All `gh` CLI calls in orchestrate handlers route through the provider

### R5: Workflow Phase Skipping
Apply `skip-phases` to HSM at initialization by rerouting transitions.
**Acceptance criteria:**
- Skipped phases are bypassed during workflow transitions
- Guard on the skip target is preserved (transition inherits the outgoing guard)
- `workflow.started` event still includes the original phase list for audit
- Cannot skip initial or final phases (validation error)

### R6: Tools Config
Expose tool settings via resolved config. Synthesis and shepherd handlers read from config instead of hardcoded values.
**Acceptance criteria:**
- `default-branch`, `commit-style`, `auto-merge`, `pr-strategy` are configurable
- Missing values fall back to current hardcoded behavior
- `pr-template` path is validated to exist at config load time (warning if missing)

### R7: Event Hooks
Fire shell commands on matching event types. Fire-and-forget, non-blocking.
**Acceptance criteria:**
- Hooks receive event data as JSON on stdin
- Environment variables are set correctly
- Hook timeout kills the process after the configured duration
- Hook failures are logged but don't block event processing
- Hooks are not triggered during test runs (env guard)

### R8: Config Describe
Extend `exarchos_workflow describe` to return effective config with source annotations.
**Acceptance criteria:**
- Each config value annotated with `"default"` or `".exarchos.yml"`
- Response includes all sections (review, vcs, workflow, tools, hooks)
- Works when no `.exarchos.yml` exists (all values show `"default"`)

## Testing Strategy

### Unit Tests
- YAML parsing: valid configs, edge cases, malformed YAML
- Zod validation: each section, shorthand normalization, error messages
- Config resolution: deep merge, precedence rules, frozen output
- Gate severity resolution: all precedence combinations
- Phase skipping: rerouting logic, validation of un-skippable phases
- VCS provider factory: correct provider for each config value

### Integration Tests
- Full config load → resolve → dispatch flow
- Gate handlers with various severity configs
- Workflow transitions with skipped phases
- Event hook execution with mock commands
- Describe action with config overlay

### Backwards Compatibility
- All existing tests pass with no `.exarchos.yml` present
- Explicit test: remove config file mid-test, verify defaults are restored

## Open Questions

1. **YAML parser dependency** — Use the `yaml` npm package (well-maintained, YAML 1.2 compliant) or a lighter alternative? The `yaml` package is ~150KB, which is acceptable for the MCP server but adds a runtime dependency.

2. **Config file name** — `.exarchos.yml` vs `exarchos.yml` (no dot). Dotfile convention hides it from casual `ls` but is standard for config files. Leaning toward `.exarchos.yml`.

3. **Hot reload** — Should the MCP server watch `.exarchos.yml` for changes? For v1, reload on server restart is sufficient. Hot reload can be added later.

4. **Config in monorepos** — ~~Should config walk up directories (like ESLint) or only check project root? For v1, project root only.~~ **Resolved:** Implementation uses directory walk-up (matching ESLint/Prettier convention) with env var override and git root fallback. See Project Root Discovery section.

5. **VCS provider implementation order** — Issue #1024 asks for GitLab and Azure DevOps. Should we implement all three providers in this feature, or ship the interface + GitHub provider first and add the others as follow-ups?

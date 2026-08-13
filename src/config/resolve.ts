import type { ProjectConfig, VerificationPolicyOverlay } from './yaml-schema.js';
import { DEFAULT_ARTIFACT_DIRS, resolveArtifactDirs, type ArtifactDirs } from './artifacts.js';
import { DEFAULT_MAX_ITERATIONS } from '../verbs/review/escalation-policy.js';
import type { RiskTier } from '../workflow/verification-policy.js';

/** The model-identity vocabulary shared by every model-selection surface. */
export type ModelId = 'opus' | 'sonnet' | 'haiku';

// ─── Resolved Types ─────────────────────────────────────────────────────────

export interface ResolvedDimensionConfig {
  readonly severity: 'blocking' | 'warning' | 'disabled';
  readonly enabled: boolean;
}

export interface ResolvedGateConfig {
  readonly enabled: boolean;
  readonly blocking: boolean;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface ResolvedPluginConfig {
  readonly enabled: boolean;
}

export interface ResolvedProjectConfig {
  readonly agents: {
    readonly defaultModel: 'opus' | 'sonnet' | 'haiku';
    readonly models: Readonly<Record<string, 'opus' | 'sonnet' | 'haiku'>>;
    /**
     * DR-1 (#1672): tier-keyed model policy — the model floor applied to a
     * task by its verification-ladder `riskTier`, INDEPENDENT of the
     * scaffolder/implementer agent split. This is the surface that drives
     * task-classification model choice (see `resolveModelForTask`); the
     * per-agent `models` map above governs only the non-dispatch surfaces
     * (reviewer/fixer dispatch, agent generation).
     *
     * Documented defaults: `low → haiku`, `medium → sonnet`, `high → opus`.
     * Overridable via `.exarchos.yml agents.tier-models`. Validated at
     * config-resolution time (see {@link validateTierModels}): model strength
     * (haiku < sonnet < opus) must be monotone non-decreasing across
     * `low → medium → high`, and `high → haiku` is rejected (the high-tier
     * floor is `sonnet`; `high → sonnet` is an allowed operator opt-in).
     */
    readonly tierModels: Readonly<Record<RiskTier, ModelId>>;
  };
  readonly review: {
    readonly dimensions: Readonly<Record<'D1' | 'D2' | 'D3' | 'D4' | 'D5', ResolvedDimensionConfig>>;
    readonly gates: Readonly<Record<string, ResolvedGateConfig>>;
    // DR-3: mutation score enforcement at `review → synthesize`. `advisory`
    // (default) never blocks; `block` fails the guard when a HIGH-tier run is
    // sub-threshold. A dedicated key (not the gate's `blocking:false`) so the
    // default is unambiguous — no default-vs-explicit-false confusion.
    readonly mutationEnforcement: 'block' | 'advisory';
    readonly routing: {
      readonly coderabbitThreshold: number;
      readonly riskWeights: Readonly<Record<string, number>>;
    };
  };
  readonly vcs: {
    readonly provider: 'github' | 'gitlab' | 'azure-devops';
    readonly settings: Readonly<Record<string, unknown>>;
  };
  readonly workflow: {
    readonly skipPhases: readonly string[];
    readonly maxFixCycles: number;
    readonly maxPlanRevisions: number;
    readonly requiredReviews: readonly string[];
    readonly phases: Readonly<Record<string, { readonly humanCheckpoint: boolean }>>;
  };
  readonly tools: {
    readonly defaultBranch: string | undefined;
    readonly commitStyle: 'conventional' | 'freeform';
    readonly prTemplate: string | undefined;
    readonly autoMerge: boolean;
    readonly prStrategy: 'github-native' | 'single';
  };
  readonly hooks: {
    readonly on: Readonly<Record<string, readonly { readonly command: string; readonly timeout: number }[]>>;
  };
  readonly plugins: {
    readonly impeccable: ResolvedPluginConfig;
  };
  readonly prune: {
    readonly maxBatchSize: number;
    readonly phaseExclusions: readonly string[];
    readonly malformedHandling: 'report' | 'include' | 'skip';
    readonly requireDryRun: boolean;
  };
  readonly checkpoint: {
    readonly operationThreshold: number;
    readonly enforceOnPhaseTransition: boolean;
    readonly enforceOnWaveDispatch: boolean;
  };
  /**
   * The verification policy-overlay (R2 / task 001) — the per-cell gate-sequence
   * overrides from `.exarchos.yml`. A config without a `verification:` block
   * resolves to an empty overlay (`policy: {}`), meaning "override nothing" — the
   * later resolver layers this over the frozen base policy table. Shares the
   * `VerificationPolicyOverlay` shape with the YAML schema (single overlay type).
   */
  readonly verification: {
    readonly policy: VerificationPolicyOverlay;
  };
  /**
   * Storage substrate tuning (DR-4). `synchronous` is the SQLite
   * `PRAGMA synchronous` durability posture threaded through the EventStore
   * to the lazily-created append substrate. Defaults to `'normal'`.
   */
  readonly storage: {
    readonly synchronous: 'normal' | 'full';
  };
  /**
   * SYNTHESIZE-kind `document` readiness leg config (DR-2, #1594). `severity`
   * gates whether an uncovered doc-bearing change blocks synthesis; `surfaceGlobs`
   * declares the doc-bearing paths (empty ⇒ auto-waive); `docGlobs` declares what
   * counts as a doc change. Always fully resolved (defaults applied).
   */
  readonly synthesis: {
    readonly documentLeg: {
      readonly severity: 'advisory' | 'blocking';
      readonly surfaceGlobs: readonly string[];
      readonly docGlobs: readonly string[];
    };
  };
  /**
   * Shared escalation policy (DR-3, #1595). `maxIterations` is the per-loop
   * auto-fix bound threaded to the review and shepherd
   * fix-loops; consumers pass it as `configMaxIterations` to
   * `resolveEscalationPolicy`. Always fully resolved (default applied).
   */
  readonly escalation: {
    readonly maxIterations: number;
  };
  /**
   * Where authored workflow artifacts live (DR-6). Prefixes, already
   * POSIX-normalized and trailing-slashed by `resolveArtifactDirs`, matched
   * against the repo-relative paths in a workflow's artifact map. Always fully
   * resolved (defaults applied).
   */
  readonly artifacts: ArtifactDirs;
}

// ─── Default Values ─────────────────────────────────────────────────────────

const DEFAULT_DIMENSION: ResolvedDimensionConfig = { severity: 'blocking', enabled: true };

const DEFAULT_RISK_WEIGHTS: Readonly<Record<string, number>> = {
  'security-path': 0.30,
  'api-surface': 0.20,
  'diff-complexity': 0.15,
  'new-files': 0.10,
  'infra-config': 0.15,
  'cross-module': 0.10,
};

const DEFAULT_HOOK_TIMEOUT = 30000;

export const DEFAULTS: ResolvedProjectConfig = deepFreeze({
  agents: {
    defaultModel: 'opus',
    models: {
      scaffolder: 'haiku',
      reviewer: 'sonnet',
    },
    // DR-1 (#1672): documented tier→model floor. Model strength is monotone
    // non-decreasing across low → medium → high, and high ≥ sonnet.
    tierModels: {
      low: 'haiku',
      medium: 'sonnet',
      high: 'opus',
    },
  },
  review: {
    dimensions: {
      D1: { ...DEFAULT_DIMENSION },
      D2: { ...DEFAULT_DIMENSION },
      D3: { ...DEFAULT_DIMENSION },
      D4: { ...DEFAULT_DIMENSION },
      D5: { ...DEFAULT_DIMENSION },
    },
    // Verification-ladder slice 1: `tdd-compliance` is demoted to ADVISORY by
    // default. The kill-probe gate `check_test_adequacy` is now the load-bearing
    // per-task verification; commit-order TDD is corroborating advice, so its
    // resolved default severity is `warning` (blocking:false), not blocking. A
    // project can still re-block it with an explicit gate override.
    gates: {
      'tdd-compliance': { enabled: true, blocking: false, params: {} },
      // Verification-ladder slice 1, SIV-4 (#1530): the mock-boundary gate is
      // ADVISORY by default. It surfaces unowned-dependency mocks (the high-risk
      // pattern coding agents over-produce) and steers toward hermetic fixtures,
      // but does not block a task by default — an unowned mock can be the right
      // call (acknowledged via the `reason` escape hatch). A project can re-block
      // it with an explicit `review.gates['mock-boundary']` override.
      'mock-boundary': { enabled: true, blocking: false, params: {} },
      // Verification-ladder slice 3, R5 (#1520): the mutation-adequacy review
      // dimension is ADVISORY by default. A sub-threshold mutation score
      // surfaces survivor "kill this mutant" next_actions but does not block a
      // merge — a sub-100% score is expected (equivalent mutants, research §6
      // Q2). The soft default threshold lives in `params.threshold` (~0.40) so
      // it can be calibrated from the INV-1 score trend without a code change.
      // A project re-blocks with an explicit `review.gates['mutation-adequacy']`
      // override (blocking: true).
      'mutation-adequacy': { enabled: true, blocking: false, params: { threshold: 0.4 } },
    },
    // DR-3 (#1520/R5): advisory by default — a sub-threshold mutation score
    // surfaces survivor follow-ups but does not block review→synthesize.
    mutationEnforcement: 'advisory',
    routing: {
      coderabbitThreshold: 0.4,
      riskWeights: { ...DEFAULT_RISK_WEIGHTS },
    },
  },
  vcs: {
    provider: 'github',
    settings: {},
  },
  workflow: {
    skipPhases: [],
    maxFixCycles: 3,
    maxPlanRevisions: 1,
    requiredReviews: [],
    phases: {},
  },
  tools: {
    defaultBranch: undefined,
    commitStyle: 'conventional',
    prTemplate: undefined,
    autoMerge: true,
    prStrategy: 'github-native',
  },
  hooks: {
    on: {},
  },
  plugins: {
    impeccable: { enabled: true },
  },
  prune: {
    maxBatchSize: 25,
    phaseExclusions: ['delegate', 'review', 'synthesize'],
    malformedHandling: 'report' as const,
    requireDryRun: true,
  },
  checkpoint: {
    operationThreshold: 20,
    enforceOnPhaseTransition: true,
    enforceOnWaveDispatch: true,
  },
  // Empty override layer: a config without a `verification:` block overrides no
  // cell, so the resolver later falls through to the frozen base policy table.
  verification: {
    policy: {},
  },
  storage: {
    synchronous: 'normal',
  },
  synthesis: {
    documentLeg: {
      severity: 'advisory',
      surfaceGlobs: [],
      docGlobs: ['docs/**', '**/*.md'],
    },
  },
  escalation: {
    maxIterations: DEFAULT_MAX_ITERATIONS,
  },
  artifacts: DEFAULT_ARTIFACT_DIRS,
});

// ─── Tier→Model Policy Validation (DR-1, #1672) ─────────────────────────────

/**
 * Total order over model strength. `haiku < sonnet < opus`. Load-bearing for
 * the monotonicity guard below: a stronger model must never sit at a lower tier
 * than a weaker one.
 */
const MODEL_STRENGTH: Readonly<Record<ModelId, number>> = { haiku: 0, sonnet: 1, opus: 2 };

/** Tier order, weakest→strongest, used for the monotonicity sweep. */
const TIER_ORDER: readonly RiskTier[] = ['low', 'medium', 'high'];

/**
 * Validate a fully-resolved tier→model table (DR-1, settled OQ2). Two rules,
 * checked in this order so the error names the most specific offending cell:
 *
 *   1. `high → haiku` is REJECTED — the high-tier model floor is `sonnet`.
 *      (`high → sonnet` is an allowed operator opt-in; `high → opus` is the
 *      default.) Checked first so an all-`haiku` table — which is technically
 *      monotone — still fails with the specific high-floor diagnostic.
 *   2. Model strength must be MONOTONE NON-DECREASING across low → medium →
 *      high: a lower tier may never carry a stronger model than a higher tier.
 *
 * Throws a structured config error naming the offending cell, matching the
 * `.exarchos.yml`-field-scoped envelope used elsewhere in the config layer
 * (see `load-exarchos-config.ts`).
 */
function validateTierModels(tierModels: Record<RiskTier, ModelId>): void {
  // Rule 1 — high-tier floor. `high → haiku` is never permitted.
  if (tierModels.high === 'haiku') {
    throw new Error(
      "Invalid .exarchos.yml agents.tier-models.high: 'haiku' is not permitted for the " +
        "high tier — the high-tier model floor is 'sonnet' (haiku < sonnet < opus)",
    );
  }

  // Rule 2 — monotone non-decreasing model strength across the tier order.
  for (let i = 1; i < TIER_ORDER.length; i++) {
    const prevTier = TIER_ORDER[i - 1];
    const tier = TIER_ORDER[i];
    if (prevTier === undefined || tier === undefined) continue;
    if (MODEL_STRENGTH[tierModels[tier]] < MODEL_STRENGTH[tierModels[prevTier]]) {
      throw new Error(
        `Invalid .exarchos.yml agents.tier-models: model strength must be monotone ` +
          `non-decreasing across tiers (haiku < sonnet < opus), but '${tier}' → ` +
          `${tierModels[tier]} is weaker than '${prevTier}' → ${tierModels[prevTier]}`,
      );
    }
  }
}

// ─── Normalization ──────────────────────────────────────────────────────────

/**
 * Normalizes a dimension config value (shorthand string or longform object)
 * into a canonical `ResolvedDimensionConfig`.
 */
function normalizeDimension(
  value: string | { severity?: string | undefined; enabled?: boolean | undefined },
): ResolvedDimensionConfig {
  if (typeof value === 'string') {
    return { severity: value as ResolvedDimensionConfig['severity'], enabled: true };
  }
  return {
    severity: (value.severity as ResolvedDimensionConfig['severity']) ?? 'blocking',
    enabled: value.enabled ?? true,
  };
}

/**
 * Normalizes a gate config into a canonical `ResolvedGateConfig`.
 */
function normalizeGate(
  value: { enabled?: boolean | undefined; blocking?: boolean | undefined; params?: Record<string, unknown> | undefined },
): ResolvedGateConfig {
  return {
    enabled: value.enabled ?? true,
    blocking: value.blocking ?? false,
    params: { ...(value.params ?? {}) },
  };
}

/**
 * Normalizes a hook action, applying default timeout.
 */
function normalizeHookAction(
  action: { command: string; timeout?: number | undefined },
): { readonly command: string; readonly timeout: number } {
  return {
    command: action.command,
    timeout: action.timeout ?? DEFAULT_HOOK_TIMEOUT,
  };
}

// ─── Deep Freeze ────────────────────────────────────────────────────────────

/**
 * Recursively freezes an object and all nested objects/arrays.
 */
function deepFreeze<T>(obj: T): T {
  if (obj === null || obj === undefined || typeof obj !== 'object') return obj;

  Object.freeze(obj);

  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }

  return obj;
}

// ─── Resolve Config ─────────────────────────────────────────────────────────

type DimensionKey = 'D1' | 'D2' | 'D3' | 'D4' | 'D5';
const DIMENSION_KEYS: readonly DimensionKey[] = ['D1', 'D2', 'D3', 'D4', 'D5'];

/**
 * Resolves a partial `ProjectConfig` (from YAML) against defaults,
 * producing a fully-populated, deeply-frozen `ResolvedProjectConfig`.
 */
export function resolveConfig(project: ProjectConfig): ResolvedProjectConfig {
  // ── Agents ──
  const agentDefaultModel = (project.agents?.['default-model'] as 'opus' | 'sonnet' | 'haiku') ?? DEFAULTS.agents.defaultModel;
  const agentModels: Record<string, 'opus' | 'sonnet' | 'haiku'> = {
    ...DEFAULTS.agents.models,
    ...(project.agents?.models as Record<string, 'opus' | 'sonnet' | 'haiku'> ?? {}),
  };
  // DR-1 (#1672): tier→model policy. Layer any `.exarchos.yml agents.tier-models`
  // partial override over the documented defaults, then validate the FULL merged
  // table (monotonicity + high-tier floor). The override is partial — an operator
  // may re-map a single tier and inherit the rest.
  const tierModels: Record<RiskTier, ModelId> = {
    ...DEFAULTS.agents.tierModels,
    ...(project.agents?.['tier-models'] as Partial<Record<RiskTier, ModelId>> ?? {}),
  };
  validateTierModels(tierModels);

  // ── Review ──
  const dimensions = {} as Record<DimensionKey, ResolvedDimensionConfig>;
  for (const key of DIMENSION_KEYS) {
    const override = project.review?.dimensions?.[key];
    dimensions[key] = override !== undefined
      ? normalizeDimension(override)
      : { ...DEFAULT_DIMENSION };
  }

  // Seed the per-gate DEFAULTS (e.g. the verification-ladder advisory
  // demotions for tdd-compliance / mock-boundary), then overlay project
  // entries. Without the seed, ANY project that ships a `.exarchos.yml` lost
  // the per-gate defaults entirely and fell through to the (often blocking)
  // dimension setting — silently re-blocking demoted gates (FIX-2 fallout).
  const gates: Record<string, ResolvedGateConfig> = Object.fromEntries(
    Object.entries(DEFAULTS.review.gates).map(([name, gate]) => [name, { ...gate }]),
  );
  if (project.review?.gates) {
    for (const [name, gateConfig] of Object.entries(project.review.gates)) {
      gates[name] = normalizeGate(gateConfig);
    }
  }

  const coderabbitThreshold = project.review?.routing?.['coderabbit-threshold']
    ?? DEFAULTS.review.routing.coderabbitThreshold;

  const riskWeights = project.review?.routing?.['risk-weights']
    ? { ...project.review.routing['risk-weights'] }
    : { ...DEFAULT_RISK_WEIGHTS };

  const mutationEnforcement =
    project.review?.['mutation-enforcement'] ?? DEFAULTS.review.mutationEnforcement;

  // ── VCS ──
  const vcsProvider = project.vcs?.provider ?? DEFAULTS.vcs.provider;
  const vcsSettings = project.vcs?.settings
    ? { ...project.vcs.settings }
    : {};

  // ── Workflow ──
  const skipPhases = [...(project.workflow?.['skip-phases'] ?? DEFAULTS.workflow.skipPhases)];
  const maxFixCycles = project.workflow?.['max-fix-cycles'] ?? DEFAULTS.workflow.maxFixCycles;
  const maxPlanRevisions = project.workflow?.['max-plan-revisions'] ?? DEFAULTS.workflow.maxPlanRevisions;
  const requiredReviews = [...(project.workflow?.['required-reviews'] ?? DEFAULTS.workflow.requiredReviews)];
  const phases: Record<string, { readonly humanCheckpoint: boolean }> = {};
  if (project.workflow?.phases) {
    for (const [name, phaseConfig] of Object.entries(project.workflow.phases)) {
      phases[name] = {
        humanCheckpoint: phaseConfig['human-checkpoint'] ?? true,
      };
    }
  }

  // ── Tools ──
  const defaultBranch = project.tools?.['default-branch'] ?? DEFAULTS.tools.defaultBranch;
  const commitStyle = project.tools?.['commit-style'] ?? DEFAULTS.tools.commitStyle;
  const prTemplate = project.tools?.['pr-template'] ?? DEFAULTS.tools.prTemplate;
  const autoMerge = project.tools?.['auto-merge'] ?? DEFAULTS.tools.autoMerge;
  const prStrategy = project.tools?.['pr-strategy'] ?? DEFAULTS.tools.prStrategy;

  // ── Hooks ──
  const hooksOn: Record<string, { readonly command: string; readonly timeout: number }[]> = {};
  if (project.hooks?.on) {
    for (const [event, actions] of Object.entries(project.hooks.on)) {
      hooksOn[event] = actions.map(normalizeHookAction);
    }
  }

  // ── Plugins ──
  const impeccableEnabled = project.plugins?.impeccable?.enabled ?? DEFAULTS.plugins.impeccable.enabled;

  // ── Prune ──
  // `stale-after-days` was removed (DR-9): per-phase staleness lives in
  // `topology.yaml` `staleness` blocks, so the knob was accepted-but-ignored.
  const maxBatchSize = project.prune?.['max-batch-size'] ?? DEFAULTS.prune.maxBatchSize;
  const phaseExclusions = [...(project.prune?.['phase-exclusions'] ?? DEFAULTS.prune.phaseExclusions)];
  const malformedHandling = project.prune?.['malformed-handling'] ?? DEFAULTS.prune.malformedHandling;
  const requireDryRun = project.prune?.['require-dry-run'] ?? DEFAULTS.prune.requireDryRun;

  // ── Checkpoint ──
  const operationThreshold = project.checkpoint?.['operation-threshold'] ?? DEFAULTS.checkpoint.operationThreshold;
  const enforceOnPhaseTransition = project.checkpoint?.['enforce-on-phase-transition'] ?? DEFAULTS.checkpoint.enforceOnPhaseTransition;
  const enforceOnWaveDispatch = project.checkpoint?.['enforce-on-wave-dispatch'] ?? DEFAULTS.checkpoint.enforceOnWaveDispatch;

  // ── Verification ──
  // Thread the parsed policy-overlay through as-is. A missing block (or missing
  // `policy`) resolves to the empty overlay (`{}`) — "override nothing" — so
  // the later resolver falls through to the base policy table. The overlay
  // nests (per-cell arrays + a `boundary` sub-policy), so we DEEP-clone before
  // freezing — `deepFreeze` would otherwise reach through a shallow copy and
  // freeze the caller's nested arrays/objects (matching the codebase's
  // don't-freeze-caller-input discipline).
  const verificationPolicy: VerificationPolicyOverlay = project.verification?.policy
    ? structuredClone(project.verification.policy)
    : structuredClone(DEFAULTS.verification.policy);

  const resolved: ResolvedProjectConfig = {
    agents: { defaultModel: agentDefaultModel, models: agentModels, tierModels },
    review: {
      dimensions,
      gates,
      mutationEnforcement,
      routing: { coderabbitThreshold, riskWeights },
    },
    vcs: { provider: vcsProvider, settings: vcsSettings },
    workflow: { skipPhases, maxFixCycles, maxPlanRevisions, requiredReviews, phases },
    tools: { defaultBranch, commitStyle, prTemplate, autoMerge, prStrategy },
    hooks: { on: hooksOn },
    plugins: { impeccable: { enabled: impeccableEnabled } },
    prune: { maxBatchSize, phaseExclusions, malformedHandling, requireDryRun },
    checkpoint: { operationThreshold, enforceOnPhaseTransition, enforceOnWaveDispatch },
    verification: { policy: verificationPolicy },
    storage: {
      synchronous: project.storage?.synchronous ?? DEFAULTS.storage.synchronous,
    },
    synthesis: {
      documentLeg: {
        severity:
          project.synthesis?.documentLeg?.severity ?? DEFAULTS.synthesis.documentLeg.severity,
        // Spread-clone the arrays so the subsequent deepFreeze() freezes a fresh
        // copy, never the caller-owned `project.*` input nor the shared DEFAULTS
        // arrays (both would be a no-freeze-caller-input violation).
        surfaceGlobs: [
          ...(project.synthesis?.documentLeg?.surfaceGlobs ?? DEFAULTS.synthesis.documentLeg.surfaceGlobs),
        ],
        docGlobs: [
          ...(project.synthesis?.documentLeg?.docGlobs ?? DEFAULTS.synthesis.documentLeg.docGlobs),
        ],
      },
    },
    escalation: {
      maxIterations: project.escalation?.maxIterations ?? DEFAULTS.escalation.maxIterations,
    },
    artifacts: resolveArtifactDirs(project.artifacts),
  };

  return deepFreeze(resolved);
}

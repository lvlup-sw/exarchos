import type { ProjectConfig, VerificationPolicyOverlay } from './yaml-schema.js';
import { EMISSION_ENFORCEMENT_MODES } from './yaml-schema.js';
import { DEFAULT_ARTIFACT_DIRS, resolveArtifactDirs, type ArtifactDirs } from './artifacts.js';
import { DEFAULT_MAX_ITERATIONS } from '../verbs/review/escalation-policy.js';
import type { RiskTier } from '../workflow/verification-policy.js';

/** The model-identity vocabulary shared by every model-selection surface. */
export type ModelId = 'opus' | 'sonnet' | 'haiku';

/** `'block' | 'advisory'` — derived from the schema vocabulary, never restated. */
export type EmissionEnforcementMode = (typeof EMISSION_ENFORCEMENT_MODES)[number];

/**
 * The enforcement mode when no project config is resolved. Without a `projectRoot`,
 * `initializeContext` returns no `projectConfig`, as in a CLI cold start and most
 * tests. This value matches the schema default, because a missing config file is
 * not an opt-out of enforcement.
 */
export const EMISSION_ENFORCEMENT_FALLBACK: EmissionEnforcementMode = 'block';

/**
 * The enforcement mode for a possibly-absent config. Total: every input,
 * including `undefined`, yields a mode.
 */
export function resolveEmissionEnforcement(
  config: Pick<ResolvedProjectConfig, 'events'> | undefined,
): EmissionEnforcementMode {
  return config?.events.emissionEnforcement ?? EMISSION_ENFORCEMENT_FALLBACK;
}

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
     * Model for a task by its verification-ladder `riskTier`, independent of the
     * per-agent `models` map. `resolveModelForTask` reads it.
     *
     * Defaults: `low → haiku`, `medium → sonnet`, `high → opus`. The
     * `agents.tier-models` key overrides them. {@link validateTierModels} rejects a
     * table whose model strength decreases from low to high, and `high → haiku`.
     */
    readonly tierModels: Readonly<Record<RiskTier, ModelId>>;
  };
  readonly review: {
    readonly dimensions: Readonly<Record<'D1' | 'D2' | 'D3' | 'D4' | 'D5', ResolvedDimensionConfig>>;
    readonly gates: Readonly<Record<string, ResolvedGateConfig>>;
    /**
     * Mutation-score enforcement at `review → synthesize`. `advisory`, the default,
     * never blocks. `block` fails the guard when a HIGH-tier run is under the
     * threshold. A dedicated key, not the gate `blocking` flag, keeps the default clear.
     */
    readonly mutationEnforcement: 'block' | 'advisory';
    readonly routing: {
      readonly coderabbitThreshold: number;
      readonly riskWeights: Readonly<Record<string, number>>;
    };
  };
  readonly events: {
    /**
     * How the post-dispatch emission verifier reports a violation. `block`, the
     * default, fails the run. `advisory` records the finding and does not fail. One
     * value applies in every environment.
     */
    readonly emissionEnforcement: EmissionEnforcementMode;
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
   * The per-cell gate-sequence overrides from `.exarchos.yml`. A config with no
   * `verification:` block resolves to `policy: {}`, which overrides nothing. A later
   * resolver lays this overlay over the frozen base policy table.
   */
  readonly verification: {
    readonly policy: VerificationPolicyOverlay;
  };
  /**
   * Storage tuning. `synchronous` is the SQLite `PRAGMA synchronous` setting that
   * the event store passes to the append substrate. Defaults to `normal`.
   */
  readonly storage: {
    readonly synchronous: 'normal' | 'full';
  };
  /**
   * Config of the `document` readiness leg of synthesis. `severity` sets whether an
   * uncovered doc-bearing change blocks synthesis. `surfaceGlobs` declares the
   * doc-bearing paths, and an empty list waives the leg. `docGlobs` declares what
   * counts as a doc change.
   */
  readonly synthesis: {
    readonly documentLeg: {
      readonly severity: 'advisory' | 'blocking';
      readonly surfaceGlobs: readonly string[];
      readonly docGlobs: readonly string[];
    };
  };
  /**
   * Shared escalation policy. `maxIterations` is the auto-fix bound of each review
   * and shepherd fix loop. Consumers pass it to `resolveEscalationPolicy` as
   * `configMaxIterations`.
   */
  readonly escalation: {
    readonly maxIterations: number;
  };
  /**
   * Directory prefixes of the authored workflow artifacts, normalized by
   * `resolveArtifactDirs`. They match the repo-relative paths in the artifact map
   * of a workflow.
   */
  readonly artifacts: ArtifactDirs;
}

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
    /** Model strength does not decrease from low to high, and high is at least `sonnet`. */
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
    /** Per-gate defaults. A project can make a gate blocking again with a `review.gates` entry. */
    gates: {
      /** Advisory, because the `check_test_adequacy` kill probe is the per-task verification. */
      'tdd-compliance': { enabled: true, blocking: false, params: {} },
      /** Advisory, because an unowned-dependency mock can be correct with a `reason`. */
      'mock-boundary': { enabled: true, blocking: false, params: {} },
      /**
       * Advisory, because equivalent mutants make a score under 100% normal. A project
       * can calibrate the soft `params.threshold` with no code change.
       */
      'mutation-adequacy': { enabled: true, blocking: false, params: { threshold: 0.4 } },
    },
    /** A score under the threshold adds survivor follow-ups but does not block `review → synthesize`. */
    mutationEnforcement: 'advisory',
    routing: {
      coderabbitThreshold: 0.4,
      riskWeights: { ...DEFAULT_RISK_WEIGHTS },
    },
  },
  /** The emission verifier blocks by default, in every environment. */
  events: {
    emissionEnforcement: EMISSION_ENFORCEMENT_FALLBACK,
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
  /** An empty overlay overrides no cell, so the resolver uses the frozen base policy table. */
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

/**
 * Total order over model strength. `haiku < sonnet < opus`. Load-bearing for
 * the monotonicity guard below: a stronger model must never sit at a lower tier
 * than a weaker one.
 */
const MODEL_STRENGTH: Readonly<Record<ModelId, number>> = { haiku: 0, sonnet: 1, opus: 2 };

/** Tier order, weakest→strongest, used for the monotonicity sweep. */
const TIER_ORDER: readonly RiskTier[] = ['low', 'medium', 'high'];

/**
 * Validates a full tier-to-model table. It checks two rules in this order:
 *   1. `high → haiku` fails, because the high-tier floor is `sonnet`. This rule runs
 *      first, so an all-`haiku` table fails with this specific error.
 *   2. Model strength must not decrease across `low → medium → high`.
 *
 * The error names the `.exarchos.yml` field and the offending cell.
 */
function validateTierModels(tierModels: Record<RiskTier, ModelId>): void {
  if (tierModels.high === 'haiku') {
    throw new Error(
      "Invalid .exarchos.yml agents.tier-models.high: 'haiku' is not permitted for the " +
        "high tier — the high-tier model floor is 'sonnet' (haiku < sonnet < opus)",
    );
  }

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

type DimensionKey = 'D1' | 'D2' | 'D3' | 'D4' | 'D5';
const DIMENSION_KEYS: readonly DimensionKey[] = ['D1', 'D2', 'D3', 'D4', 'D5'];

/**
 * Resolves a partial `ProjectConfig` from YAML against `DEFAULTS` into a full,
 * deeply frozen `ResolvedProjectConfig`.
 *
 * A partial `agents.tier-models` override merges over the defaults, and then the
 * merged table is validated. Project gate entries lay over the per-gate defaults, so
 * a gate that the project does not name keeps its default. The resolver copies nested
 * input before the freeze, so that `deepFreeze` does not freeze caller input.
 */
export function resolveConfig(project: ProjectConfig): ResolvedProjectConfig {
  const agentDefaultModel = (project.agents?.['default-model'] as 'opus' | 'sonnet' | 'haiku') ?? DEFAULTS.agents.defaultModel;
  const agentModels: Record<string, 'opus' | 'sonnet' | 'haiku'> = {
    ...DEFAULTS.agents.models,
    ...(project.agents?.models as Record<string, 'opus' | 'sonnet' | 'haiku'> ?? {}),
  };
  const tierModels: Record<RiskTier, ModelId> = {
    ...DEFAULTS.agents.tierModels,
    ...(project.agents?.['tier-models'] as Partial<Record<RiskTier, ModelId>> ?? {}),
  };
  validateTierModels(tierModels);

  const dimensions = {} as Record<DimensionKey, ResolvedDimensionConfig>;
  for (const key of DIMENSION_KEYS) {
    const override = project.review?.dimensions?.[key];
    dimensions[key] = override !== undefined
      ? normalizeDimension(override)
      : { ...DEFAULT_DIMENSION };
  }

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

  const vcsProvider = project.vcs?.provider ?? DEFAULTS.vcs.provider;
  const vcsSettings = project.vcs?.settings
    ? { ...project.vcs.settings }
    : {};

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

  const defaultBranch = project.tools?.['default-branch'] ?? DEFAULTS.tools.defaultBranch;
  const commitStyle = project.tools?.['commit-style'] ?? DEFAULTS.tools.commitStyle;
  const prTemplate = project.tools?.['pr-template'] ?? DEFAULTS.tools.prTemplate;
  const autoMerge = project.tools?.['auto-merge'] ?? DEFAULTS.tools.autoMerge;
  const prStrategy = project.tools?.['pr-strategy'] ?? DEFAULTS.tools.prStrategy;

  const hooksOn: Record<string, { readonly command: string; readonly timeout: number }[]> = {};
  if (project.hooks?.on) {
    for (const [event, actions] of Object.entries(project.hooks.on)) {
      hooksOn[event] = actions.map(normalizeHookAction);
    }
  }

  const impeccableEnabled = project.plugins?.impeccable?.enabled ?? DEFAULTS.plugins.impeccable.enabled;

  const maxBatchSize = project.prune?.['max-batch-size'] ?? DEFAULTS.prune.maxBatchSize;
  const phaseExclusions = [...(project.prune?.['phase-exclusions'] ?? DEFAULTS.prune.phaseExclusions)];
  const malformedHandling = project.prune?.['malformed-handling'] ?? DEFAULTS.prune.malformedHandling;
  const requireDryRun = project.prune?.['require-dry-run'] ?? DEFAULTS.prune.requireDryRun;

  const operationThreshold = project.checkpoint?.['operation-threshold'] ?? DEFAULTS.checkpoint.operationThreshold;
  const enforceOnPhaseTransition = project.checkpoint?.['enforce-on-phase-transition'] ?? DEFAULTS.checkpoint.enforceOnPhaseTransition;
  const enforceOnWaveDispatch = project.checkpoint?.['enforce-on-wave-dispatch'] ?? DEFAULTS.checkpoint.enforceOnWaveDispatch;

  const verificationPolicy: VerificationPolicyOverlay = project.verification?.policy
    ? structuredClone(project.verification.policy)
    : structuredClone(DEFAULTS.verification.policy);

  const emissionEnforcement: EmissionEnforcementMode =
    project.events?.['emission-enforcement'] ?? DEFAULTS.events.emissionEnforcement;

  const resolved: ResolvedProjectConfig = {
    agents: { defaultModel: agentDefaultModel, models: agentModels, tierModels },
    review: {
      dimensions,
      gates,
      mutationEnforcement,
      routing: { coderabbitThreshold, riskWeights },
    },
    events: { emissionEnforcement },
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

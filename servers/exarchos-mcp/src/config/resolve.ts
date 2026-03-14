import type { ProjectConfig } from './yaml-schema.js';

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

export interface ResolvedProjectConfig {
  readonly review: {
    readonly dimensions: Readonly<Record<'D1' | 'D2' | 'D3' | 'D4' | 'D5', ResolvedDimensionConfig>>;
    readonly gates: Readonly<Record<string, ResolvedGateConfig>>;
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
  review: {
    dimensions: {
      D1: { ...DEFAULT_DIMENSION },
      D2: { ...DEFAULT_DIMENSION },
      D3: { ...DEFAULT_DIMENSION },
      D4: { ...DEFAULT_DIMENSION },
      D5: { ...DEFAULT_DIMENSION },
    },
    gates: {},
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
});

// ─── Normalization ──────────────────────────────────────────────────────────

/**
 * Normalizes a dimension config value (shorthand string or longform object)
 * into a canonical `ResolvedDimensionConfig`.
 */
function normalizeDimension(
  value: string | { severity?: string; enabled?: boolean },
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
  value: { enabled?: boolean; blocking?: boolean; params?: Record<string, unknown> },
): ResolvedGateConfig {
  return {
    enabled: value.enabled ?? true,
    blocking: value.blocking ?? false,
    params: value.params ?? {},
  };
}

/**
 * Normalizes a hook action, applying default timeout.
 */
function normalizeHookAction(
  action: { command: string; timeout?: number },
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
  // ── Review ──
  const dimensions = {} as Record<DimensionKey, ResolvedDimensionConfig>;
  for (const key of DIMENSION_KEYS) {
    const override = project.review?.dimensions?.[key];
    dimensions[key] = override !== undefined
      ? normalizeDimension(override)
      : { ...DEFAULT_DIMENSION };
  }

  const gates: Record<string, ResolvedGateConfig> = {};
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

  // ── VCS ──
  const vcsProvider = project.vcs?.provider ?? DEFAULTS.vcs.provider;
  const vcsSettings = project.vcs?.settings
    ? { ...project.vcs.settings }
    : {};

  // ── Workflow ──
  const skipPhases = project.workflow?.['skip-phases'] ?? [...DEFAULTS.workflow.skipPhases];
  const maxFixCycles = project.workflow?.['max-fix-cycles'] ?? DEFAULTS.workflow.maxFixCycles;
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

  const resolved: ResolvedProjectConfig = {
    review: {
      dimensions,
      gates,
      routing: { coderabbitThreshold, riskWeights },
    },
    vcs: { provider: vcsProvider, settings: vcsSettings },
    workflow: { skipPhases, maxFixCycles, phases },
    tools: { defaultBranch, commitStyle, prTemplate, autoMerge, prStrategy },
    hooks: { on: hooksOn },
  };

  return deepFreeze(resolved);
}

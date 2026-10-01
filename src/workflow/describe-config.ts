import type { ResolvedProjectConfig } from '../config/resolve.js';
import { DEFAULTS } from '../config/resolve.js';

/** A resolved config value and where it came from. */
export interface AnnotatedValue<T> {
  readonly value: T;
  readonly source: 'default' | '.exarchos.yml';
}

/** A value that is JSON-equal to its default reports `default`, even when `.exarchos.yml` sets it. */
function annotate<T>(value: T, defaultValue: T): AnnotatedValue<T> {
  const isDefault = JSON.stringify(value) === JSON.stringify(defaultValue);
  return { value, source: isDefault ? 'default' : '.exarchos.yml' };
}

type DimensionKey = 'D1' | 'D2' | 'D3' | 'D4' | 'D5';
const DIMENSION_KEYS: readonly DimensionKey[] = ['D1', 'D2', 'D3', 'D4', 'D5'];

/** Build the resolved project config with each value annotated by its source. */
export function buildConfigDescription(config: ResolvedProjectConfig) {
  const dimensions = Object.fromEntries(
    DIMENSION_KEYS.map((dim) => [
      dim,
      annotate(
        config.review.dimensions[dim].severity,
        DEFAULTS.review.dimensions[dim].severity,
      ),
    ]),
  ) as Record<DimensionKey, AnnotatedValue<string>>;

  const gates = Object.fromEntries(
    Object.entries(config.review.gates).map(([name, gate]) => {
      const defaultGate = DEFAULTS.review.gates[name];
      return [
        name,
        {
          enabled: annotate(gate.enabled, defaultGate?.enabled ?? true),
          blocking: annotate(gate.blocking, defaultGate?.blocking ?? true),
          params: annotate(gate.params, defaultGate?.params ?? {}),
        },
      ];
    }),
  );

  return {
    review: {
      dimensions,
      gates,
      routing: {
        coderabbitThreshold: annotate(
          config.review.routing.coderabbitThreshold,
          DEFAULTS.review.routing.coderabbitThreshold,
        ),
      },
    },
    vcs: {
      provider: annotate(config.vcs.provider, DEFAULTS.vcs.provider),
      settings: annotate(config.vcs.settings, DEFAULTS.vcs.settings),
    },
    workflow: {
      skipPhases: annotate(config.workflow.skipPhases, DEFAULTS.workflow.skipPhases),
      maxFixCycles: annotate(config.workflow.maxFixCycles, DEFAULTS.workflow.maxFixCycles),
      maxPlanRevisions: annotate(config.workflow.maxPlanRevisions, DEFAULTS.workflow.maxPlanRevisions),
    },
    tools: {
      defaultBranch: annotate(config.tools.defaultBranch, DEFAULTS.tools.defaultBranch),
      commitStyle: annotate(config.tools.commitStyle, DEFAULTS.tools.commitStyle),
      autoMerge: annotate(config.tools.autoMerge, DEFAULTS.tools.autoMerge),
      prStrategy: annotate(config.tools.prStrategy, DEFAULTS.tools.prStrategy),
    },
    hooks: {
      on: annotate(config.hooks.on, DEFAULTS.hooks.on),
    },
    prune: {
      maxBatchSize: annotate(config.prune.maxBatchSize, DEFAULTS.prune.maxBatchSize),
      phaseExclusions: annotate(config.prune.phaseExclusions, DEFAULTS.prune.phaseExclusions),
      malformedHandling: annotate(config.prune.malformedHandling, DEFAULTS.prune.malformedHandling),
      requireDryRun: annotate(config.prune.requireDryRun, DEFAULTS.prune.requireDryRun),
    },
    checkpoint: {
      operationThreshold: annotate(
        config.checkpoint.operationThreshold,
        DEFAULTS.checkpoint.operationThreshold,
      ),
      enforceOnPhaseTransition: annotate(
        config.checkpoint.enforceOnPhaseTransition,
        DEFAULTS.checkpoint.enforceOnPhaseTransition,
      ),
      enforceOnWaveDispatch: annotate(
        config.checkpoint.enforceOnWaveDispatch,
        DEFAULTS.checkpoint.enforceOnWaveDispatch,
      ),
    },
    agents: {
      defaultModel: annotate(config.agents.defaultModel, DEFAULTS.agents.defaultModel),
      models: annotate(config.agents.models, DEFAULTS.agents.models),
    },
    plugins: {
      impeccable: {
        enabled: annotate(config.plugins.impeccable.enabled, DEFAULTS.plugins.impeccable.enabled),
      },
    },
    events: {
      emissionEnforcement: annotate(
        config.events.emissionEnforcement,
        DEFAULTS.events.emissionEnforcement,
      ),
    },
    verification: {
      policy: annotate(config.verification.policy, DEFAULTS.verification.policy),
    },
    storage: {
      synchronous: annotate(config.storage.synchronous, DEFAULTS.storage.synchronous),
    },
    synthesis: {
      documentLeg: {
        severity: annotate(
          config.synthesis.documentLeg.severity,
          DEFAULTS.synthesis.documentLeg.severity,
        ),
        surfaceGlobs: annotate(
          config.synthesis.documentLeg.surfaceGlobs,
          DEFAULTS.synthesis.documentLeg.surfaceGlobs,
        ),
        docGlobs: annotate(
          config.synthesis.documentLeg.docGlobs,
          DEFAULTS.synthesis.documentLeg.docGlobs,
        ),
      },
    },
    escalation: {
      maxIterations: annotate(config.escalation.maxIterations, DEFAULTS.escalation.maxIterations),
    },
    artifacts: {
      specDir: annotate(config.artifacts.specDir, DEFAULTS.artifacts.specDir),
      legacyDesignDir: annotate(
        config.artifacts.legacyDesignDir,
        DEFAULTS.artifacts.legacyDesignDir,
      ),
    },
  };
}

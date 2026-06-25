import type { ResolvedProjectConfig } from '../config/resolve.js';
import { DEFAULTS } from '../config/resolve.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AnnotatedValue<T> {
  readonly value: T;
  readonly source: 'default' | '.exarchos.yml';
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function annotate<T>(value: T, defaultValue: T): AnnotatedValue<T> {
  const isDefault = JSON.stringify(value) === JSON.stringify(defaultValue);
  return { value, source: isDefault ? 'default' : '.exarchos.yml' };
}

// ─── Builder ────────────────────────────────────────────────────────────────

type DimensionKey = 'D1' | 'D2' | 'D3' | 'D4' | 'D5';
const DIMENSION_KEYS: readonly DimensionKey[] = ['D1', 'D2', 'D3', 'D4', 'D5'];

export function buildConfigDescription(config: ResolvedProjectConfig) {
  // ── Review Dimensions ──
  const dimensions = Object.fromEntries(
    DIMENSION_KEYS.map((dim) => [
      dim,
      annotate(
        config.review.dimensions[dim].severity,
        DEFAULTS.review.dimensions[dim].severity,
      ),
    ]),
  ) as Record<DimensionKey, AnnotatedValue<string>>;

  // ── Review Gates ──
  // Any gate present was defined in config (defaults has empty gates)
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
      staleAfterDays: annotate(config.prune.staleAfterDays, DEFAULTS.prune.staleAfterDays),
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
    verification: {
      // The per-cell policy overlay (R2 / task 001). Default is the empty
      // overlay (`{}`) — "override nothing"; any cell present means the consumer
      // replaced that cell's gate sequence.
      policy: annotate(config.verification.policy, DEFAULTS.verification.policy),
    },
    storage: {
      // DR-4 — SQLite durability posture (`PRAGMA synchronous`). Default
      // `'normal'`; `'full'` fsyncs on every commit (power-loss durable).
      synchronous: annotate(config.storage.synchronous, DEFAULTS.storage.synchronous),
    },
    synthesis: {
      // DR-2 (#1594) — SYNTHESIZE-kind `document` readiness leg. `severity`
      // gates whether an uncovered doc-bearing change blocks synthesis;
      // `surfaceGlobs` declares doc-bearing paths (empty default ⇒ auto-waive);
      // `docGlobs` declares what counts as a documentation change.
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
      // DR-3 (#1595) — shared escalation policy. `maxIterations` is the per-loop
      // auto-fix bound for the review and shepherd
      // fix-loops; default `5` (DEFAULT_MAX_ITERATIONS).
      maxIterations: annotate(config.escalation.maxIterations, DEFAULTS.escalation.maxIterations),
    },
  };
}

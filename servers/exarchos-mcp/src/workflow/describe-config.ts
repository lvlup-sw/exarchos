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
  };
}

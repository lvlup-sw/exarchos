import {
  ProviderRefSchema,
  type ProviderRef,
} from '../../workflow/admission/types.js';

/**
 * The five mechanical gate classes. This module declares them because it resolves a provider for each one.
 * The taxonomy has one authority. The seeded-defect `corpus.ts` extends this union with its hidden-oracle class (`dropped-edge-case`).
 * This direction keeps the legacy guard modules out of the module set that the shared workflow IR reaches.
 */
export type MechanicalGateClass =
  | 'test-adequacy'
  | 'contract-drift'
  | 'mock-boundary'
  | 'static-analysis'
  | 'integration-suite';

/**
 * The phase outcome producers on the durable runner. The runner resolves a provider by class, so each gate that records durable gate evidence needs its class here.
 * A bare `gate.executed` row is not that evidence. The postcondition observer reads `admission.evidence-recorded`.
 * The hidden-oracle class of the seeded-defect corpus is ungated, so it is absent here. `corpus.ts` adds it.
 */
export type PhaseGateClass =
  | 'plan-coverage'
  | 'provenance-chain'
  | 'review-verdict'
  | 'prepare-synthesis'
  | 'security-scan'
  | 'convergence'
  | 'invariant-conformance'
  | 'task-decomposition'
  | 'spec-coverage'
  | 'context-economy'
  | 'coverage-thresholds'
  | 'debug-review'
  | 'exploration-depth'
  | 'operational-resilience'
  | 'post-delegation'
  | 'post-merge'
  | 'pr-stack'
  | 'pre-synthesis'
  | 'workflow-determinism';
export type SupportedGateClass = MechanicalGateClass | PhaseGateClass;

export interface GateProviderRegistration {
  readonly gateClass: string;
  readonly actionName: string;
}

/**
 * Workload-neutral provider identity. The action is the local implementation seam, and commands and execution policy stay behind it.
 * The action identity is also the proof-domain `providerRef`. No second provider namespace exists.
 */
export interface GateProvider {
  readonly gateClass: SupportedGateClass;
  readonly providerRef: ProviderRef;
  readonly actionName: string;
}

export interface UnknownGateClassDiagnostic {
  readonly code: 'UNKNOWN_GATE_CLASS';
  readonly message: string;
  readonly gateClass: string;
  readonly suggestions: readonly SupportedGateClass[];
  readonly validGateClasses: readonly SupportedGateClass[];
}

export interface GateProviderCardinalityDiagnostic {
  readonly code: 'DUPLICATE_GATE_PROVIDER' | 'MISSING_GATE_PROVIDER';
  readonly message: string;
  readonly gateClasses: readonly SupportedGateClass[];
}

export interface InvalidGateProviderDiagnostic {
  readonly code: 'INVALID_GATE_PROVIDER';
  readonly message: string;
  readonly gateClass: string;
}

export type GateProviderDiagnostic =
  | UnknownGateClassDiagnostic
  | GateProviderCardinalityDiagnostic
  | InvalidGateProviderDiagnostic;

export type GateProviderResolution =
  | {
      readonly success: true;
      readonly data: { readonly provider: GateProvider };
    }
  | {
      readonly success: false;
      readonly error: UnknownGateClassDiagnostic;
    };

export interface GateProviderRegistry {
  resolve(gateClass: string): GateProviderResolution;
  list(): readonly GateProvider[];
}

export type GateProviderRegistryBuildResult =
  | {
      readonly success: true;
      readonly data: { readonly registry: GateProviderRegistry };
    }
  | {
      readonly success: false;
      readonly error: GateProviderDiagnostic;
    };

/**
 * This object is the exhaustive ownership declaration. `satisfies Record<...>`
 * makes a newly-added shared mechanical GateClass a compile failure until it
 * receives one owner. Object insertion order is the stable registry order.
 */
const BUILTIN_REGISTRATIONS = {
  'test-adequacy': {
    actionName: 'check_test_adequacy',
  },
  'contract-drift': {
    actionName: 'check_contract_drift',
  },
  'mock-boundary': {
    actionName: 'check_mock_boundary',
  },
  'static-analysis': {
    actionName: 'check_static_analysis',
  },
  'integration-suite': {
    actionName: 'check_integration_suite',
  },
  'plan-coverage': {
    actionName: 'check_plan_coverage',
  },
  'provenance-chain': {
    actionName: 'check_provenance_chain',
  },
  'review-verdict': {
    actionName: 'check_review_verdict',
  },
  'prepare-synthesis': {
    actionName: 'prepare_synthesis',
  },
  'security-scan': {
    actionName: 'check_security_scan',
  },
  convergence: {
    actionName: 'check_convergence',
  },
  'invariant-conformance': {
    actionName: 'check_invariant_conformance',
  },
  'task-decomposition': {
    actionName: 'check_task_decomposition',
  },
  'spec-coverage': {
    actionName: 'spec_coverage_check',
  },
  'context-economy': {
    actionName: 'check_context_economy',
  },
  'coverage-thresholds': {
    actionName: 'check_coverage_thresholds',
  },
  'debug-review': {
    actionName: 'debug_review_gate',
  },
  'exploration-depth': {
    actionName: 'check_exploration_depth',
  },
  'operational-resilience': {
    actionName: 'check_operational_resilience',
  },
  'post-delegation': {
    actionName: 'post_delegation_check',
  },
  'post-merge': {
    actionName: 'check_post_merge',
  },
  'pr-stack': {
    actionName: 'validate_pr_stack',
  },
  'pre-synthesis': {
    actionName: 'pre_synthesis_check',
  },
  'workflow-determinism': {
    actionName: 'check_workflow_determinism',
  },
} as const satisfies Readonly<
  Record<
    SupportedGateClass,
    Omit<GateProviderRegistration, 'gateClass'>
  >
>;

export const SUPPORTED_GATE_CLASSES = Object.freeze(
  Object.keys(BUILTIN_REGISTRATIONS) as SupportedGateClass[],
);

const SUPPORTED_GATE_CLASS_SET: ReadonlySet<string> = new Set(
  SUPPORTED_GATE_CLASSES,
);

/**
 * Edit distance between two strings, with two typed-array rows.
 * Under `noUncheckedIndexedAccess`, a typed-array read types as `number | undefined`. An out-of-bounds read throws, so it cannot pass silently.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const cell = (row: Int32Array, index: number): number => {
    const value = row[index];
    if (value === undefined) {
      throw new Error(`levenshtein: DP cell ${index} out of bounds`);
    }
    return value;
  };
  let previous = Int32Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Int32Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        cell(current, j - 1) + 1,
        cell(previous, j) + 1,
        cell(previous, j - 1) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    [previous, current] = [current, previous];
  }
  return cell(previous, b.length);
}

/** Builds the unknown-class diagnostic. It cuts the class name to 128 characters, which bounds the edit-distance work and the echoed text. */
function unknownGateClassDiagnostic(gateClass: string): UnknownGateClassDiagnostic {
  const safeGateClass = gateClass.slice(0, 128);
  const suggestions = Object.freeze(
    SUPPORTED_GATE_CLASSES
      .map((candidate, stableIndex) => ({
        candidate,
        stableIndex,
        distance: levenshtein(safeGateClass.toLowerCase(), candidate),
      }))
      .sort(
        (left, right) =>
          left.distance - right.distance ||
          left.stableIndex - right.stableIndex,
      )
      .slice(0, 3)
      .map(({ candidate }) => candidate),
  );

  return {
    code: 'UNKNOWN_GATE_CLASS',
    message: `Unknown gate class ${JSON.stringify(safeGateClass)}`,
    gateClass: safeGateClass,
    suggestions,
    validGateClasses: SUPPORTED_GATE_CLASSES,
  };
}

function canonicalGateClassOrder(
  gateClasses: ReadonlySet<string>,
): SupportedGateClass[] {
  return SUPPORTED_GATE_CLASSES.filter((gateClass) =>
    gateClasses.has(gateClass),
  );
}

/**
 * Builds a registry with exactly one provider for each supported gate class.
 * If a class has no registration after the missing-class check, the build returns a typed failure, not a crash.
 */
export function buildGateProviderRegistry(
  registrations: readonly GateProviderRegistration[],
): GateProviderRegistryBuildResult {
  const unknownClasses = [...new Set(
    registrations
      .map(({ gateClass }) => gateClass)
      .filter((gateClass) => !SUPPORTED_GATE_CLASS_SET.has(gateClass)),
  )].sort();
  const [firstUnknown] = unknownClasses;
  if (firstUnknown !== undefined) {
    return {
      success: false,
      error: unknownGateClassDiagnostic(firstUnknown),
    };
  }

  const counts = new Map<string, number>();
  for (const { gateClass } of registrations) {
    counts.set(gateClass, (counts.get(gateClass) ?? 0) + 1);
  }

  const duplicates = canonicalGateClassOrder(
    new Set(
      [...counts]
        .filter(([, count]) => count > 1)
        .map(([gateClass]) => gateClass),
    ),
  );
  if (duplicates.length > 0) {
    return {
      success: false,
      error: {
        code: 'DUPLICATE_GATE_PROVIDER',
        message: 'Gate classes must have exactly one provider',
        gateClasses: Object.freeze(duplicates),
      },
    };
  }

  const missing = SUPPORTED_GATE_CLASSES.filter(
    (gateClass) => !counts.has(gateClass),
  );
  if (missing.length > 0) {
    return {
      success: false,
      error: {
        code: 'MISSING_GATE_PROVIDER',
        message: 'Every supported gate class must have a provider',
        gateClasses: Object.freeze(missing),
      },
    };
  }

  const registrationByClass = new Map(
    registrations.map((registration) => [
      registration.gateClass as SupportedGateClass,
      registration,
    ]),
  );
  const providers: GateProvider[] = [];
  for (const gateClass of SUPPORTED_GATE_CLASSES) {
    const registration = registrationByClass.get(gateClass);
    if (registration === undefined) {
      return {
        success: false,
        error: {
          code: 'MISSING_GATE_PROVIDER',
          message: `No provider registered for gate class "${gateClass}"`,
          gateClasses: Object.freeze([gateClass]),
        },
      };
    }
    const providerRef = ProviderRefSchema.safeParse(registration.actionName);
    if (!providerRef.success) {
      return {
        success: false,
        error: {
          code: 'INVALID_GATE_PROVIDER',
          message: 'Provider references and action names must be stable non-empty identifiers',
          gateClass,
        },
      };
    }
    providers.push(
      Object.freeze({
        gateClass,
        providerRef: providerRef.data,
        actionName: registration.actionName,
      }),
    );
  }

  const frozenProviders = Object.freeze(providers);
  const byClass = new Map(
    frozenProviders.map((provider) => [provider.gateClass, provider]),
  );
  const registry: GateProviderRegistry = Object.freeze({
    resolve(gateClass: string): GateProviderResolution {
      const provider = byClass.get(gateClass as SupportedGateClass);
      return provider
        ? { success: true, data: { provider } }
        : { success: false, error: unknownGateClassDiagnostic(gateClass) };
    },
    list(): readonly GateProvider[] {
      return frozenProviders;
    },
  });

  return { success: true, data: { registry } };
}

const builtinBuild = buildGateProviderRegistry(
  SUPPORTED_GATE_CLASSES.map((gateClass) => ({
    gateClass,
    ...BUILTIN_REGISTRATIONS[gateClass],
  })),
);

if (!builtinBuild.success) {
  throw new Error(`Invalid built-in gate provider registry: ${builtinBuild.error.code}`);
}

export const BUILTIN_GATE_PROVIDER_REGISTRY = builtinBuild.data.registry;

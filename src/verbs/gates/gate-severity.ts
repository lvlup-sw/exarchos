/**
 * Resolves the effective severity of a quality gate, and applies it to each gate action through one wrapper.
 * Gate-level overrides take precedence over dimension-level settings from the project config.
 * The register marks each gate action where a severity has a reduced meaning, with its reason and its owner.
 */

import type { ResolvedProjectConfig } from '../../config/resolve.js';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import {
  getDispatchContext,
  runWithDispatchContext,
  type GateSeverityDirective,
} from '../../dispatch/dispatch-context.js';
import type { ToolResult } from '../../format.js';
import { VERIFICATION_GATE_NAMES } from '../../workflow/verification-policy.js';
import { readGateSkipDescriptor, resolvePhaseMode, type ImplementMode } from './gate-utils.js';

type DimensionKey = 'D1' | 'D2' | 'D3' | 'D4' | 'D5';
type Severity = 'blocking' | 'warning' | 'disabled';

/**
 * Default severity for verification-ladder gates, keyed by workflow type. For
 * `oneshot`, a ladder-gate miss gives a warning, not a block. The default
 * applies only to gates in `VERIFICATION_GATE_NAMES`. A gate-level override or
 * a disabled dimension takes precedence. This axis is workflow-specific, so it
 * is not in `KIND_OBLIGATIONS`. The mode axis is `IMPLEMENT_PHASE_MODE` in
 * `gate-utils.ts`.
 */
export const WORKFLOW_DEFAULT_SEVERITY: Readonly<Record<string, 'warning'>> =
  Object.freeze({ oneshot: 'warning' });

/** The ladder-gate names as a Set. `VERIFICATION_GATE_NAMES` is the source. */
const LADDER_GATE_NAMES: ReadonlySet<string> = new Set(VERIFICATION_GATE_NAMES);

/**
 * Resolves the effective severity for a named gate within a dimension.
 *
 * Resolution order (highest precedence first):
 * 1. Gate-level override (`review.gates[gateName]`).
 * 2. Explicit dimension disable (`enabled === false`) gives `'disabled'`. It
 *    beats the ladder default, so `oneshot` does not turn a disabled gate into
 *    a warning.
 * 3. Per-workflow ladder default, when `workflowType` is given, the gate is a
 *    ladder gate, and `WORKFLOW_DEFAULT_SEVERITY` has an entry.
 * 4. Dimension-level severity (`review.dimensions[dimension].severity`).
 * 5. `'blocking'` for an unknown dimension.
 */
export function resolveGateSeverity(
  gateName: string,
  dimension: string,
  config: ResolvedProjectConfig,
  workflowType?: string,
): Severity {
  const gateOverride = config.review.gates[gateName];
  if (gateOverride) {
    if (!gateOverride.enabled) return 'disabled';
    return gateOverride.blocking ? 'blocking' : 'warning';
  }

  const dimKey = dimension as DimensionKey;
  const dimConfig = config.review.dimensions[dimKey];
  if (dimConfig && !dimConfig.enabled) return 'disabled';

  if (workflowType !== undefined && LADDER_GATE_NAMES.has(gateName)) {
    const workflowDefault = WORKFLOW_DEFAULT_SEVERITY[workflowType];
    if (workflowDefault !== undefined) return workflowDefault;
  }

  if (!dimConfig) return 'blocking';
  return dimConfig.severity;
}

/**
 * The reduced meaning of a severity for one gate action.
 * - `disabled-acts-as-warning`: a disabled gate still runs, and a failing verdict does not block.
 * - `no-severity`: no severity applies, so the handler runs unchanged.
 * - `second-resolution`: the wrapper applies the severity, and the handler keeps a second, advisory resolution of its own.
 */
export type GateSeverityMeaning = 'disabled-acts-as-warning' | 'no-severity' | 'second-resolution';

/** One row of the severity register: a gate action whose severity has a reduced meaning, with its reason and its owner. */
export interface GateSeverityRegisterRow {
  readonly action: string;
  readonly meaning: GateSeverityMeaning;
  readonly reason: string;
  readonly owner: string;
}

/** The reason of each gate action whose next step reads its data. */
const DATA_READ_BY_NEXT_STEP =
  'The next step reads the data of this action, and a skip carrier cannot stand in for that data.';

/** The reason of each gate action with a verdict-shaped result. */
const VERDICT_SHAPED =
  'The result is verdict-shaped, and a verdict-shaped result has no skip form.';

/**
 * The severity register. Each row names a gate action of the registry where a severity has a reduced meaning.
 * A structural test checks that each row names a gate action of the registry.
 */
export const GATE_SEVERITY_REGISTER: readonly GateSeverityRegisterRow[] = Object.freeze([
  {
    action: 'mutation-adequacy',
    meaning: 'disabled-acts-as-warning',
    reason:
      'The handler appends mutation.executed and its own gate.executed rows, not through the gate runner. ' +
      'A skip with no run breaks those always rows.',
    owner: '#2147',
  },
  { action: 'check_review_verdict', meaning: 'no-severity', reason: VERDICT_SHAPED, owner: '#1976' },
  { action: 'check_invariant_conformance', meaning: 'no-severity', reason: VERDICT_SHAPED, owner: '#1976' },
  { action: 'prepare_synthesis', meaning: 'no-severity', reason: DATA_READ_BY_NEXT_STEP, owner: '#2147' },
  { action: 'prepare_review', meaning: 'no-severity', reason: DATA_READ_BY_NEXT_STEP, owner: '#2147' },
  { action: 'discover_bridge', meaning: 'no-severity', reason: DATA_READ_BY_NEXT_STEP, owner: '#2147' },
  {
    action: 'check_mock_boundary',
    meaning: 'second-resolution',
    reason:
      "The handler keeps a second, advisory resolution under review.gates['mock-boundary'], " +
      'read from the config of the task worktree.',
    owner: 'slice 4 (#1540, #1814)',
  },
]);

/** The handler of one action, as the orchestrate action table holds it. */
export type GateActionHandler = (
  args: Record<string, unknown>,
  stateDir: string,
  ctx?: DispatchContext,
) => Promise<ToolResult>;

/**
 * The facts of one gate action that the wrapper reads. The table builder reads them from the registration of the action.
 * Thus the wrapper reads no registry type.
 */
export interface GateSeverityDescriptor {
  /** The action name. It is also the gate name for the severity resolution. */
  readonly name: string;
  /** The review dimension from the gate metadata of the action. An empty string names no dimension. */
  readonly dimension: string;
  /** True when the action contract declares an `always` row of the gate signal. */
  readonly signal: boolean;
}

/** Resolves the workflow type of one call. The wrapper calls it before the handler runs. */
export type WorkflowTypeOf = (
  args: Readonly<Record<string, unknown>>,
  ctx: DispatchContext | undefined,
) => Promise<string>;

/** The gate actions whose failing verdict the IMPLEMENT-phase audit mode softens: the ladder gates and the mutation gate. */
const AUDIT_MODE_ACTIONS: ReadonlySet<string> = new Set([...VERIFICATION_GATE_NAMES, 'mutation-adequacy']);

/** Each handler that {@link withGateSeverity} returned. {@link isSeverityWrapped} reads it. */
const SEVERITY_WRAPPED = new WeakSet<GateActionHandler>();

/** True when {@link withGateSeverity} returned this handler. */
export function isSeverityWrapped(handler: GateActionHandler): boolean {
  return SEVERITY_WRAPPED.has(handler);
}

/** True for an object record. An array and null are not records. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The severity of one call. With no project config, a gate blocks.
 * The gate name is the action name, and the dimension comes from the descriptor of the action.
 * A register row can reduce the meaning of `disabled` to `warning`.
 */
function callSeverity(
  gate: GateSeverityDescriptor,
  meaning: GateSeverityMeaning | undefined,
  config: ResolvedProjectConfig | undefined,
  workflowType: string | undefined,
): Severity {
  if (config === undefined) return 'blocking';
  const resolved = resolveGateSeverity(gate.name, gate.dimension, config, workflowType);
  return resolved === 'disabled' && meaning === 'disabled-acts-as-warning' ? 'warning' : resolved;
}

/**
 * Runs the handler inside a dispatch context that carries the skip directive.
 * With no active dispatch context, the handler runs with no directive. The gate runner then refuses the call for its missing caller identity.
 */
async function runUnderDirective(
  directive: GateSeverityDirective,
  run: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const active = getDispatchContext();
  if (active === undefined) return run();
  return runWithDispatchContext({ ...active, gateSeverity: directive }, run);
}

/** The warning that softens a failing verdict, or undefined when the verdict stays. Audit mode wins over the warning severity. */
function softeningWarning(action: string, severity: Severity, mode: ImplementMode): string | undefined {
  if (mode === 'audit') {
    return `Gate '${action}' failed but the implement phase is in audit mode (finding recorded, non-blocking)`;
  }
  if (severity === 'warning') return `Gate '${action}' failed but is configured as warning-only`;
  return undefined;
}

/**
 * Softens a failing verdict. A success carrier with `passed: false` that is not a skip becomes `passed: true` with a warning.
 * The evidence record keeps the true verdict, because the runner wrote it before this step.
 * An error envelope is never softened, so `INVALID_INPUT` stays an error.
 */
function softenedVerdict(action: string, result: ToolResult, severity: Severity, mode: ImplementMode): ToolResult {
  if (!result.success || readGateSkipDescriptor(result) !== undefined) return result;
  const data = result.data;
  if (!isRecord(data) || data.passed !== false) return result;
  const warning = softeningWarning(action, severity, mode);
  if (warning === undefined) return result;
  return { ...result, data: { ...data, passed: true }, warnings: [...(result.warnings ?? []), warning] };
}

/**
 * Wraps the handler of one gate action with the severity that the project config of the call gives.
 * - `blocking`: the handler runs, unchanged.
 * - `disabled`: the handler runs inside a dispatch context with a skip directive. The gate runner records a skip and does not call the provider.
 * - `warning`: the handler runs, and a failing verdict passes with a warning.
 * For the ladder gates and the mutation gate, the wrapper resolves the workflow type before the run, for the ladder default and the audit mode.
 * Each returned handler is marked, so {@link isSeverityWrapped} can check the action table.
 */
export function withGateSeverity(
  gate: GateSeverityDescriptor,
  handler: GateActionHandler,
  workflowTypeOf: WorkflowTypeOf,
): GateActionHandler {
  const meaning = GATE_SEVERITY_REGISTER.find((row) => row.action === gate.name)?.meaning;
  const wrapped: GateActionHandler = async (args, stateDir, ctx) => {
    if (meaning === 'no-severity') return handler(args, stateDir, ctx);
    const workflowType = AUDIT_MODE_ACTIONS.has(gate.name) ? await workflowTypeOf(args, ctx) : undefined;
    const severity = callSeverity(gate, meaning, ctx?.projectConfig, workflowType);
    if (severity === 'disabled') {
      return runUnderDirective(
        { action: gate.name, severity: 'disabled', signal: gate.signal },
        () => handler(args, stateDir, ctx),
      );
    }
    const result = await handler(args, stateDir, ctx);
    const mode = workflowType === undefined ? 'enforce' : resolvePhaseMode('IMPLEMENT', workflowType);
    return softenedVerdict(gate.name, result, severity, mode);
  };
  SEVERITY_WRAPPED.add(wrapped);
  return wrapped;
}

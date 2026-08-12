// ─── The Exarchos tool registry — the DECLARATION AUTHORITY (DR-11) ──────────
//
// AUTHORITY DIRECTION (resolved, T-16). This file is the single place an
// Exarchos action is DECLARED. Every other description of the action surface is
// a PROJECTION of these declarations, never a second declaration:
//
//   registry.ts  ──▶  adapters/mcp.ts        (tools/list: buildRegistrationSchema
//                │                            + buildToolDescription + annotations)
//                ├──▶  core/dispatch.ts       (routing + per-action .safeParse)
//                ├──▶  describe/handler.ts    (the `describe` action clients read)
//                ├──▶  adapters/cli.ts        (the CLI verb tree)
//                └──▶  contract/compiler/meta-model.ts
//                            └──▶ compile() ──▶ descriptors / schemas / proof fixtures
//
// The running server consumes the LEFT-hand projections. It does NOT consume a
// `compile()` descriptor — the compiled contract is an artifact about the
// server, not the thing the server runs on. Inverting that (so the descriptor
// IS the runtime surface) is DR-11's first acceptance criterion and is NOT done;
// it stays open. Until it lands, do not describe the compiler as "the authority":
// adding an action here and nowhere else is correct and sufficient; adding one
// to the meta-model alone ships nothing.
//
// WHAT GUARDS THE PROJECTION. Because meta-model.ts derives from this file, a
// guard that compares the two is a tautology and is blind to a wrong meta-model
// (the Class B defect DR-11 names). The drift guard that is NOT blind lives in
// `contract/compiler/runtime-authority.ts`: it audits the meta-model against
// the runtime projections listed above — a differential between two independent
// projections of these declarations. Its limits are stated in that file's
// header and are real: it catches a wrong PROJECTION (a `derive*Policy` reading
// the wrong field, an entry bound to the wrong action, a field the strict wire
// would reject), and it CANNOT catch a wrong DECLARATION here — an action
// annotated `readOnly: true` whose handler mutates the tree is invisible to it,
// because every projection reads the same (wrong) declaration.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { AsOfSchema, CheckpointHandoffSchema, WorkflowTypeSchema } from './workflow/schemas.js';
import { agentSpecSchema as agentSpecSchemaForRegistry } from './agents/handler.js';
import { EnvelopeSchema } from './contract/schemas/envelope.js';
import {
  AcquireWorktreeOutputSchema,
  ReleaseWorktreeOutputSchema,
  PruneWorktreesOutputSchema,
  SerializeMergeOutputSchema,
  PsOutputSchema,
  WaitOutputSchema,
  WorktreesOutputSchema,
} from './verbs/worktree/schemas.js';
import { AmendInvariantOutputSchema } from './verbs/invariants/amend.js';
// DR-4 (task 069) — the invariant-conformance gate's response contract, paid
// down from `vacuityWaiver` to a real `data` schema. Held in its own module so
// the registry does not pull the handler's import closure (event store, config
// loader, catalog resolver) in behind it.
import { CheckInvariantConformanceOutputSchema } from './verbs/gates/check-invariant-conformance-schema.js';
// DR-4 (task 055) — the closed `outputSchema` declaration surface. `ToolAction.
// outputSchema` accepts only what these two constructors mint, so the vacuous
// form (`EnvelopeSchema(z.unknown())`) is not merely discouraged here, it does
// not typecheck. See `output-schema-declaration.ts` for the mechanism and
// `output-schema-vacuity-allowlist.ts` for the shrink-only seed.
import { withCappedShape, vacuityWaiver } from './output-schema-declaration.js';
// NOTE (task 060): `unregisteredActionOutputSchema` is deliberately NOT imported
// here. It is the out-of-registry escape, and this file is the registry. Its
// absence from this import list is checked textually by
// `output-schema-vacuity-allowlist.test.ts`; its unusability here is checked by
// `tsc` via `_OutputSchemaRegistryActionUsingExtensionEscapeFailsCompile` below.
import type {
  DeclaredOutputSchema,
  ExtensionOutputSchema,
  RegisteredOutputSchema,
} from './output-schema-declaration.js';
import type { VacuityWaiverId } from './output-schema-vacuity-allowlist.js';
// Lifecycle verbs (worktree-lifecycle-verbs) — task-019 shared field shapes +
// task-008 `inspect` typed output schema. Import shapes from the SoT module so
// the flattened `exarchos_view` registration cannot drift a shared field's base
// type apart across verbs (DR-8).
import {
  followField,
  scopeField as lifecycleScopeField,
  limitField as lifecycleLimitField,
  phaseField as lifecyclePhaseField,
  statusField as lifecycleStatusField,
  workflowTypeField as lifecycleWorkflowTypeField,
  allField as lifecycleAllField,
  operationField as lifecycleOperationField,
  outputField as lifecycleOutputField,
} from './projections/views/lifecycle/schema-fields.js';
import { InspectOutputSchema } from './projections/views/lifecycle/inspect.js';
import { ExportOutputSchema } from './projections/views/lifecycle/export.js';
import type { AgentPosture } from './agents/spec.js';
export { coercedRecord, coercedPositiveInt, coercedNonnegativeInt, coercedStringArray, coercedIntArray } from './coerce.js';
import { coercedRecord, coercedPositiveInt, coercedNonnegativeInt, coercedStringArray, coercedIntArray } from './coerce.js';
import {
  REMOVED_PRUNE_ACTION_KNOBS,
  PRUNE_ACTION_KNOWN_KEYS,
  removedPruneKnobMessage,
  unrecognizedPruneKeyMessage,
} from './config/prune-removed-knobs.js';
import type { SupportedGateClass } from './verbs/gates/gate-provider-registry.js';
import {
  INTERNAL_ADMISSION_EVENT_TYPES,
  INTERNAL_CANCELLATION_EVENT_TYPES,
} from './events/schemas.js';

// ─── Tool Registry Types ────────────────────────────────────────────────────

export interface CliActionHints {
  readonly alias?: string;
  readonly group?: string;
  readonly examples?: readonly string[];
  readonly flags?: Readonly<Record<string, {
    readonly alias?: string;
    readonly description?: string;
  }>>;
  readonly format?: 'table' | 'json' | 'tree';
  /**
   * DR-7 — hoist this action to a TOP-LEVEL CLI command in addition to its
   * `<tool> <action>` subcommand form. When set to (say) `'ps'`, the CLI
   * adapter registers `exarchos ps` alongside `exarchos view ps`; both forms
   * dispatch through the same code path and derive their flags from the same
   * Zod schema (no divergent parsing). A `topLevel` name that collides with an
   * existing top-level command fails at registration (build time), not at
   * runtime — see the hoist loop in `adapters/cli.ts`. This task ships only the
   * generic mechanism + its guard; the lifecycle-verb re-map (which actions
   * declare `topLevel`, the exit-code map, and parity) is a follow-on.
   */
  readonly topLevel?: string;
}

export interface CliToolHints {
  readonly alias?: string;
  readonly group?: string;
}

/**
 * Action-descriptor-level dispatch metadata (#1440 Op 2, preview-4 T2,
 * design §4.3).
 *
 * Lives at the action-descriptor level (sibling to `cli`, `gate`,
 * `autoEmits`) — NOT under `cli.` — because the Tasks dispatch-core is
 * shared between the CLI and MCP facades (INV-2). Annotating under
 * `cli.` would imply this is CLI-presentation metadata; it isn't. It's
 * action-behavior metadata: "this action is long-running and benefits
 * from Tasks-augmented dispatch."
 *
 * The block is intentionally extensible — a future `streaming: true`
 * marker, for example, belongs here too. Hence the name `dispatch`
 * (not `tasks`, which would be too narrow).
 */
export interface DispatchHints {
  /**
   * Advisory marker: this action is long-running and benefits from
   * Tasks-augmented dispatch. Surfaced via `exarchos_view describe` so
   * clients can enumerate. The actual opt-in gate remains
   * `taskAugmented && ctx.taskStore && taskCapabilityGate` at
   * core/dispatch.ts:927-954. Clients are not required to honor this
   * marker; the gate is binding.
   */
  readonly taskSuitable?: boolean;
  /**
   * Suggested TTL for Tasks-augmented dispatch, in ms. Surfaced
   * alongside `taskSuitable` so clients have a sensible default to
   * thread when they opt in.
   */
  readonly taskTtlSuggestionMs?: number;
}

/**
 * Action-descriptor-level response-economy metadata (DR-1, design
 * §"The economy block").
 *
 * Lives at the action-descriptor level — sibling to `cli`, `gate`,
 * `autoEmits`, `dispatch` — because a response budget is action-behavior
 * metadata shared by both facades (INV-2), exactly the placement rationale
 * documented on {@link DispatchHints}. Annotating under `cli.` would imply
 * this is CLI-presentation metadata; a response token budget is not
 * presentation, it is a property of what the action emits, so both the CLI
 * and MCP surfaces inherit the same ceiling from one declaration.
 *
 * - `budgetTokens` — the per-action response ceiling in estimated output
 *   tokens. Resolves via {@link resolveEconomyBudget}: declared value wins
 *   over {@link DEFAULT_ECONOMY_BUDGET_TOKENS}, so every action resolves a
 *   concrete number.
 * - `compactByDefault` — advisory marker that this action's presentation
 *   should default to its compact rendering (consumed by DR-8/DR-12).
 * - `summarize` — optional per-action reducer applied on overflow (else a
 *   generic capped fallback). Declared here so schemas stay honest.
 *
 * Enforcement lives at the dispatch-core measurement seam (Task 003); this
 * block is the declaration, that seam is the guard. They agree by
 * construction because both read {@link resolveEconomyBudget}.
 */
export interface EconomyHints {
  readonly budgetTokens?: number;
  readonly compactByDefault?: boolean;
  readonly summarize?: (data: unknown) => unknown;
}

/**
 * Registry-wide default response budget in estimated output tokens (DR-1,
 * design §"The economy block"). An action's declared `economy.budgetTokens`
 * wins over this default; every action therefore resolves to a concrete
 * number via {@link resolveEconomyBudget}. Initial value from the
 * token-economy audit (PR #1679); the qualityHints 25,600-token threshold
 * remains the last-resort catastrophic backstop. Tune after dogfooding.
 */
export const DEFAULT_ECONOMY_BUDGET_TOKENS = 2000;

// Verbose-by-design response budgets (DR-1). These actions are the
// intentional detail paths, so they declare explicit higher budgets rather
// than exemptions — everything still resolves a number. Values are grounded
// in measured worst-case outputs (token-economy audit, PR #1679): a
// `describe` of the ten largest orchestrate actions runs ~21k tokens
// (full input + output JSON schemas per action), the event `describe`
// emission catalog ~3.5k tokens on top of action schemas, and the largest
// resolved runbook ~2k tokens. Budgets sit between typical usage and the
// worst case so a normal detail call is uncapped while an extreme dump is
// summarized by the dispatch-core seam (Task 003). Tune after dogfooding.

/** `describe` (workflow / orchestrate / view) — full per-action schemas. */
export const DESCRIBE_ECONOMY_BUDGET_TOKENS = 8000;

/**
 * Event `describe` — sized above {@link DESCRIBE_ECONOMY_BUDGET_TOKENS}
 * because it carries the additional `emissionGuide` param path (the full
 * event catalog grouped by source) on top of action schemas. The
 * `emissionGuide` is a *param* of the one `describe` action, not a separate
 * action, so its budget rides that single descriptor.
 */
export const EVENT_DESCRIBE_ECONOMY_BUDGET_TOKENS = 12000;

/** `runbook` — a resolved runbook with step schemas. */
export const RUNBOOK_ECONOMY_BUDGET_TOKENS = 4000;

/**
 * Resolve an action's effective response budget: its declared
 * `economy.budgetTokens` when present, else {@link DEFAULT_ECONOMY_BUDGET_TOKENS}.
 * Always returns a number so callers (the dispatch-core seam, `describe`
 * surfacing) never branch on "declared vs default". The returned value's
 * validity (finite, positive) is pinned at build time by the registry
 * budget-snapshot test; the runtime seam (Task 003) fails open on a
 * non-finite / non-positive budget per DR-1.
 */
export function resolveEconomyBudget(action: Pick<ToolAction, 'economy'>): number {
  const declared = action.economy?.budgetTokens;
  return declared !== undefined ? declared : DEFAULT_ECONOMY_BUDGET_TOKENS;
}

// DR-3 / B-3 — `prNumbers` and its int-array peers bind the shared, CSV-tolerant
// `coercedIntArray` helper imported from `coerce.ts` (Task 010). It accepts a
// JSON-stringified array (`"[1660,1671]"`), a CSV string (`"1660,1671,1659"`),
// or a native array, so the direct-MCP path funnels the same shapes the CLI's
// `coerceFlags` splitter produces. (The former local stub here was NOT
// CSV-tolerant and made the direct-MCP CSV path fail INVALID_INPUT while its
// tests exercised the unused shared helper — review fix.)

export interface GateMetadata {
  readonly blocking: boolean;
  readonly dimension?: string;
  /**
   * Shared mechanical gate identity owned by the provider registry. Most
   * quality gates intentionally have no GateClass and remain unchanged.
   */
  readonly gateClass?: SupportedGateClass;
}

export interface AutoEmission {
  readonly event: string;
  readonly condition: 'always' | 'conditional';
  readonly description?: string;
}

export interface ReservedEventAppendRegistration {
  readonly eventType: string;
  readonly typedHandler?: string;
}

/**
 * Server-owned admission event reservation catalog (DR-3).
 *
 * This is intentionally separate from EVENT_EMISSION_REGISTRY: that registry
 * describes replay/emission classification, while this one controls which
 * untrusted write surfaces may mint a fact. A typed handler name is present
 * only when v2.12 actually ships that handler; planned v3 actions remain
 * reserved without pretending that callers can invoke them.
 */
export const RESERVED_EVENT_APPEND_REGISTRY: ReadonlyMap<
  string,
  ReservedEventAppendRegistration
> = new Map(
  [...INTERNAL_ADMISSION_EVENT_TYPES, ...INTERNAL_CANCELLATION_EVENT_TYPES].map((eventType) => [
    eventType,
    {
      eventType,
      ...(eventType === 'admission.disagreement-disposition'
        ? { typedHandler: 'handleAdmissionDisagreementDisposition' }
        : {}),
    },
  ]),
);

export function getReservedEventAppendRegistration(
  eventType: string,
): ReservedEventAppendRegistration | undefined {
  return RESERVED_EVENT_APPEND_REGISTRY.get(eventType);
}

// ─── Action Annotations (#1289, design §2.4) ─────────────────────────
//
// Per-action metadata co-located with the schema. `safety` is
// server-trusted (consumed by HSM guards + computeNextActions in a
// later task). The 4 *Hint flags are spec-defined client-untrusted UI
// hints populated to tools/list. Per MCP §Tools / Annotations,
// annotations are EXPLICITLY untrusted by clients unless the server is
// trusted — they are advisory only on the wire.
export type ActionAnnotations = {
  readonly safety: 'read-only' | 'local-mutation' | 'remote-mutation' | 'compensable';
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly idempotent: boolean;
  readonly openWorld: boolean;
};

// Mapping rules (mirror the §"Shared Annotation Presets" comment block
// below). `superRefine` rejects contradictory tuples — e.g. an action
// that claims `safety: 'read-only'` but flips `readOnly: false` would
// otherwise pass the shape-only check yet smuggle a writer past the
// capability boundary (CodeRabbit MAJOR on PR #1369; also the same
// mis-annotation class behind the doctor / check_convergence Sentry
// HIGH).
//
// `idempotent` is not asserted because the comment block explicitly
// notes that idempotency varies per handler within the local-mutation
// family. `openWorld` is asserted only where the safety enum implies
// it (remote-mutation must be openWorld:true; other classes leave it
// free because compensable splits local/remote).
export const ActionAnnotationsSchema = z.object({
  safety: z.enum(['read-only', 'local-mutation', 'remote-mutation', 'compensable']),
  readOnly: z.boolean(),
  destructive: z.boolean(),
  idempotent: z.boolean(),
  openWorld: z.boolean(),
}).strict().superRefine((a, ctx) => {
  switch (a.safety) {
    case 'read-only':
      if (!a.readOnly) {
        ctx.addIssue({
          code: 'custom',
          path: ['readOnly'],
          message: "safety 'read-only' requires readOnly: true",
        });
      }
      if (a.destructive) {
        ctx.addIssue({
          code: 'custom',
          path: ['destructive'],
          message: "safety 'read-only' requires destructive: false",
        });
      }
      break;
    case 'local-mutation':
      if (a.readOnly) {
        ctx.addIssue({
          code: 'custom',
          path: ['readOnly'],
          message: "safety 'local-mutation' requires readOnly: false",
        });
      }
      if (a.destructive) {
        ctx.addIssue({
          code: 'custom',
          path: ['destructive'],
          message: "safety 'local-mutation' requires destructive: false (use 'compensable' for destructive writes)",
        });
      }
      break;
    case 'remote-mutation':
      if (a.readOnly) {
        ctx.addIssue({
          code: 'custom',
          path: ['readOnly'],
          message: "safety 'remote-mutation' requires readOnly: false",
        });
      }
      if (a.destructive) {
        ctx.addIssue({
          code: 'custom',
          path: ['destructive'],
          message: "safety 'remote-mutation' requires destructive: false (use 'compensable' for destructive writes)",
        });
      }
      if (!a.openWorld) {
        ctx.addIssue({
          code: 'custom',
          path: ['openWorld'],
          message: "safety 'remote-mutation' requires openWorld: true",
        });
      }
      break;
    case 'compensable':
      if (a.readOnly) {
        ctx.addIssue({
          code: 'custom',
          path: ['readOnly'],
          message: "safety 'compensable' requires readOnly: false",
        });
      }
      if (!a.destructive) {
        ctx.addIssue({
          code: 'custom',
          path: ['destructive'],
          message: "safety 'compensable' requires destructive: true",
        });
      }
      break;
  }
});

export function validateAnnotations(a: unknown, actionName: string): asserts a is ActionAnnotations {
  const result = ActionAnnotationsSchema.safeParse(a);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Action '${actionName}' has invalid annotations: ${issues}`);
  }
}

/**
 * Registration-time invariant check (Wave 0 task C.3, design §2.1 + §2.4,
 * issues #1287 + #1289).
 *
 * Every action MUST declare both `outputSchema` (a Zod schema for the
 * response envelope) and `annotations` (a typed ActionAnnotations record).
 * Called from the module-load loop at the bottom of this file so any
 * malformed action fails the import — DIM-3 contracts fail closed at
 * startup rather than at first call. The thrown error always surfaces
 * the fully-qualified `${toolName}.${action.name}` identifier so the
 * operator can navigate from a failed import directly to the offender.
 */
export function validateAction(
  action: { name: string; outputSchema?: z.ZodType; annotations?: unknown },
  toolName: string,
): void {
  const id = `${toolName}.${action.name}`;
  if (action.outputSchema === undefined) {
    throw new Error(`Action '${id}' is missing required outputSchema`);
  }
  if (typeof (action.outputSchema as { parse?: unknown }).parse !== 'function') {
    throw new Error(`Action '${id}' outputSchema is not a Zod schema`);
  }
  // ActionAnnotationsSchema is re-validated here (not just a presence
  // check) so a hand-edited field set that drifts from the schema fails
  // at the same boundary as a missing declaration.
  validateAnnotations(action.annotations, id);
}

// ─── Shared Annotation Presets (Wave 0 E.1-E.5, design §2.4) ────────
//
// Each preset codifies the (safety, readOnly, destructive, idempotent,
// openWorld) tuple for one of the recurring action shapes in the
// registry. Co-locating them removes drift risk across 90+ declaration
// sites and makes per-action annotations a single keyword in the array
// literal — the *kind* of action is the only thing the author has to
// classify; the flag tuple follows from the preset.
//
// Mapping rules (DIM-3 safety boundary, applied uniformly):
// - read-only            → readOnly:true,  destructive:false, idempotent:true,  openWorld:false
// - read-only + external → readOnly:true,  destructive:false, idempotent:true,  openWorld:true
// - local-mutation       → readOnly:false, destructive:false, idempotent:false, openWorld:false
// - local-mutation idem. → readOnly:false, destructive:false, idempotent:true,  openWorld:false
// - compensable (local)  → readOnly:false, destructive:true,  idempotent:false, openWorld:false
// - compensable (remote) → readOnly:false, destructive:true,  idempotent:false, openWorld:true
// - remote-mutation      → readOnly:false, destructive:false, idempotent:false, openWorld:true
//
// `idempotent: true` is asserted only for actions whose handler is
// documented or empirically safe to re-run (reconcile, rehydrate,
// checkpoint, sync, plus all pure reads). Default for state-writers is
// false because re-running yields a new event in the stream.

const READ_ONLY_LOCAL: ActionAnnotations = {
  safety: 'read-only',
  readOnly: true,
  destructive: false,
  idempotent: true,
  openWorld: false,
};

const READ_ONLY_REMOTE: ActionAnnotations = {
  safety: 'read-only',
  readOnly: true,
  destructive: false,
  idempotent: true,
  openWorld: true,
};

const LOCAL_MUTATION: ActionAnnotations = {
  safety: 'local-mutation',
  readOnly: false,
  destructive: false,
  idempotent: false,
  openWorld: false,
};

const LOCAL_MUTATION_IDEMPOTENT: ActionAnnotations = {
  safety: 'local-mutation',
  readOnly: false,
  destructive: false,
  idempotent: true,
  openWorld: false,
};

// DR-6 (lifecycle-verbs) — a local-mutation whose side effect is a FILE written
// OUTSIDE the managed `.exarchos/` store (the `export` diagnostic zip bundle),
// so `openWorld` is true. Non-destructive (a diagnostic write, not a workflow
// mutation) and NOT idempotent at the event level (a fresh invocation mints a
// new INV-13 pair). `local-mutation` leaves `openWorld` free (the annotation
// schema only pins it for `remote-mutation`), so this tuple is valid.
const LOCAL_MUTATION_OPEN_WORLD: ActionAnnotations = {
  safety: 'local-mutation',
  readOnly: false,
  destructive: false,
  idempotent: false,
  openWorld: true,
};

const COMPENSABLE_LOCAL: ActionAnnotations = {
  safety: 'compensable',
  readOnly: false,
  destructive: true,
  idempotent: false,
  openWorld: false,
};

const COMPENSABLE_REMOTE: ActionAnnotations = {
  safety: 'compensable',
  readOnly: false,
  destructive: true,
  idempotent: false,
  openWorld: true,
};

const REMOTE_MUTATION: ActionAnnotations = {
  safety: 'remote-mutation',
  readOnly: false,
  destructive: false,
  idempotent: false,
  openWorld: true,
};

// Wave 5 (#1437) — shared correlation-tuple filter shape spliced into every
// view action that supports dispatch-boundary scoping. Keeping it in one
// place prevents the six call sites from drifting if a field is added,
// renamed, or constrained.
const CORRELATION_TUPLE_FILTER_SHAPE = {
  operationId: z.string().optional(),
  correlationId: z.string().optional(),
  causationId: z.string().optional(),
} as const;

export interface ToolAction {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodObject<z.ZodRawShape>;
  readonly phases: ReadonlySet<string>;
  readonly roles: ReadonlySet<string>;
  readonly cli?: CliActionHints;
  readonly gate?: GateMetadata;
  readonly autoEmits?: readonly AutoEmission[];
  /**
   * Dispatch-layer metadata (#1440 Op 2, preview-4 T2, design §4.3).
   * Sibling-level (not under `cli`) because the Tasks dispatch-core is
   * shared between CLI and MCP facades (INV-2). Advisory only — the
   * binding opt-in gate stays at `dispatch/core/dispatch.ts:927-954`. Surfaced
   * via `exarchos_view describe` so clients can enumerate
   * task-suitable actions.
   */
  readonly dispatch?: DispatchHints;
  /**
   * DR-1 (design §"The economy block") — response-economy metadata:
   * per-action token budget (+ optional summarizer / compact-by-default
   * markers). Sibling-level (not under `cli`) because the budget is
   * action-behavior metadata shared by both facades (INV-2), mirroring
   * `dispatch`. Undefined leaves the action on {@link DEFAULT_ECONOMY_BUDGET_TOKENS};
   * every action resolves a number via {@link resolveEconomyBudget}. The
   * effective budget is surfaced via `exarchos_view describe`
   * (`economyBudgetTokens`); the binding cap lives at the dispatch-core
   * measurement seam (Task 003).
   */
  readonly economy?: EconomyHints;
  /**
   * DR-5: When true, the action can take multiple seconds to complete and
   * the CLI adapter should emit stderr heartbeats under `--json` so a long
   * silence doesn't look like the process hung.  MCP hosts render progress
   * natively and ignore this flag.
   */
  readonly longRunning?: boolean;
  /**
   * DR-4 / DR-11 (durable-substrate, #1259) — when true, this action is
   * scheduled for removal one release ahead and currently routes through a
   * deprecation rerouting surface. Surfaces in `describe` entries so model-
   * facing agents can self-correct toward the canonical action without
   * human prompting.
   */
  readonly deprecated?: boolean;
  /**
   * #1305 — Trust-tier posture for this action's handler. When declared, the
   * capability resolver mints this action's write capabilities from the
   * posture table (`capabilities/posture-mapping.ts`) rather than inferring
   * them from the (advisory, MCP-untrusted) annotation hints. Today only
   * `merge_orchestrate` declares a posture: `shared-mutating`, because it
   * mutates shared state (the integration branch, the working tree, the
   * event store) from the main worktree with no worktree isolation. Most
   * actions leave this undefined and rely on annotations alone; #1305 T14/T15
   * (read-only-caller rejection, transition exclusivity) build on this
   * declaration being the trust-tier source of truth.
   */
  readonly posture?: AgentPosture;
  /**
   * Typed Zod schema describing the action's response envelope (Wave 0
   * task E.1-E.5, DR-11, design §2.1).
   *
   * DR-4 (task 055) narrowed this field from `z.ZodType` to
   * {@link DeclaredOutputSchema}. Under the old type the field recorded
   * PRESENCE, not SUBSTANCE: the cheapest satisfying expression was
   * `EnvelopeSchema(z.unknown())`, whose success-branch `data` accepts every
   * payload, and 112 of 122 declarations wrote exactly that. A schema total
   * over every shape satisfies INV-17's totality precondition trivially, so
   * INV-2's "schema-checked in addition to byte-checked" collapsed into
   * byte-checked plus a tautology for 92% of the surface.
   *
   * There are now exactly two ways to produce a value of this type:
   *   • `withCappedShape(<typed envelope>)` — the sole constructor of a
   *     SUBSTANTIVE schema;
   *   • `vacuityWaiver('<tool>.<action>')` — the explicit allowlist escape,
   *     whose id parameter is the literal union of the ids seeded in
   *     `output-schema-vacuity-allowlist.ts`.
   * A new action therefore cannot declare a vacuous `outputSchema`: the bare
   * expression is unbranded, and the waiver rejects an unseeded id. See
   * `_OutputSchema*` below for the machine-checked statement of that.
   *
   * TASK 060 widened THIS field — the CONSUMER-facing one — to
   * {@link RegisteredOutputSchema}, the union of the registry brand and the
   * out-of-registry extension brand, so dispatch / the MCP adapter / the CLI
   * adapter / `describe` keep seeing one action type across built-in and
   * `.exarchos.yml` tools. The narrowing that closes DR-4's first hole moved to
   * the DECLARATION types: {@link BuiltinToolAction} (what {@link TOOL_REGISTRY}
   * is declared with) accepts `DeclaredOutputSchema` only, and
   * {@link ExtensionToolAction} accepts `ExtensionOutputSchema` only. Widening
   * here is not a loosening of the tooth: nothing can be constructed for this
   * union that could not already be constructed for one of its members, and no
   * value of this union type can reach `TOOL_REGISTRY`.
   *
   * The field is required at the interface boundary; the registration-
   * time validator (`validateAction`) also enforces presence at module
   * load so a malformed declaration fails the import (DIM-3 fail-closed).
   */
  readonly outputSchema: RegisteredOutputSchema;
  /**
   * DR-1 structural marker for the worktree "DR-10 surface" actions
   * (acquire_worktree, release_worktree, prune_worktrees, serialize_merge, ps,
   * wait, worktrees). Reads sit on `exarchos_view` and mutations on
   * `exarchos_orchestrate`, so the surface is otherwise not structurally
   * distinguishable; this marker lets a registry-driven conformance harness
   * enumerate exactly the surface (typed outputSchema + parity) by filter
   * rather than a hardcoded name list. Undefined on every non-surface action.
   */
  readonly surface?: 'worktree';
  /**
   * Per-action annotations (Wave 0 task E.1-E.5, design §2.4, #1289).
   * `safety` is server-trusted and is consumed by HSM guards +
   * computeNextActions in a later task. The four Hint flags
   * (readOnly/destructive/idempotent/openWorld) are spec-defined
   * advisory hints surfaced to MCP clients via `tools/list`; per the
   * MCP spec they are EXPLICITLY untrusted unless the server itself
   * is trusted.
   */
  readonly annotations: ActionAnnotations;
}

export interface CompositeTool {
  readonly name: string;
  readonly description: string;
  readonly actions: readonly ToolAction[];
  readonly cli?: CliToolHints;
  /** When true, the tool is excluded from MCP registration (not exposed to agents). CLI access is preserved. */
  readonly hidden?: boolean;
  /** One-line summary for slim MCP registration. Used when slimRegistration is enabled. */
  readonly slimDescription?: string;
}

// ─── DR-4 (task 060): the two DECLARATION paths, told apart nominally ────────
//
// `ToolAction` / `CompositeTool` above are the CONSUMER types — what dispatch,
// the adapters and `describe` read. The two types below are the DECLARATION
// types, and they are the ones that carry DR-4's compile-time tooth.
//
// Task 055 closed `outputSchema` vacuity for the built-in registry and then
// reported the residual: `unregisteredActionOutputSchema()` — the bounded escape
// for actions whose name is not a compile-time literal — minted the same brand
// as the two registry constructors, so a NEW registry action could call it and
// compile. The audit still reported it (`UNWAIVED_VACUITY`), but at run time,
// while DR-4 claims compile time.
//
// The fix is nominal, not a deletion: `.exarchos.yml` custom tools are a
// SUPPORTED surface and must keep working. The escape now mints
// `ExtensionOutputSchema`, `ExtensionToolAction` is the type the two extension
// sites build, and `TOOL_REGISTRY` is declared `readonly BuiltinCompositeTool[]`
// — so the escape is not merely discouraged in this file, it does not typecheck
// in it, and the door is the registry constant rather than any single array's
// annotation (adding a sixth `readonly ToolAction[]` array to TOOL_REGISTRY is
// itself a compile error).

/**
 * An action DECLARED in {@link TOOL_REGISTRY}.
 *
 * Identical to {@link ToolAction} except that `outputSchema` is narrowed to
 * {@link DeclaredOutputSchema} — the brand minted only by `withCappedShape`
 * (substantive) and `vacuityWaiver` (allowlisted). The out-of-registry escape
 * mints the other brand and is therefore not assignable here.
 */
export interface BuiltinToolAction extends ToolAction {
  readonly outputSchema: DeclaredOutputSchema;
}

/** A composite tool whose actions are all built-in declarations. */
export interface BuiltinCompositeTool extends CompositeTool {
  readonly actions: readonly BuiltinToolAction[];
}

/**
 * An action declared OUTSIDE the built-in registry: a `.exarchos.yml` custom
 * tool (`config/register.ts`) or the oracle registration probe
 * (`contract/oracle/fixtures.ts`). Its name is a runtime string, so it has no
 * census id to waive and no compile-time literal to match against the allowlist
 * union — which is exactly why it needs its own nominal type rather than a
 * shared escape.
 *
 * Assignable to {@link ToolAction}, so an extension action is dispatchable,
 * registrable and describable exactly like a built-in one. NOT assignable to
 * {@link BuiltinToolAction}, which is the whole point.
 */
export interface ExtensionToolAction extends ToolAction {
  readonly outputSchema: ExtensionOutputSchema;
}

/** A composite tool assembled from extension-declared actions. */
export interface ExtensionCompositeTool extends CompositeTool {
  readonly actions: readonly ExtensionToolAction[];
}

// ─── DR-4: vacuity is unconstructible at the ToolAction boundary ─────────────
//
// `OutputSchema_NewActionDeclaringVacuous_FailsCompile`, stated where it is
// enforced. These aliases live in a NON-TEST source file deliberately: the
// package tsconfig excludes `*.test.ts`, so the same claim written as a
// `@ts-expect-error` in a spec would never be checked by `npm run typecheck`.
// The `_Pola*` aliases in `capabilities/resolver.ts` are the precedent.
// `Expect<T extends true>` is a compile error unless T is exactly `true`.
type ExpectTrue<T extends true> = T;
type NotAssignableTo<A, B> = A extends B ? false : true;

/**
 * THE ACCEPTANCE CRITERION. `EnvelopeSchema(z.unknown())` — the expression 109
 * declaration sites used to write — cannot be assigned to the field. A new
 * action that reaches for it does not compile.
 * @proof
 */
export type _OutputSchemaNewActionDeclaringVacuousFailsCompile = ExpectTrue<
  NotAssignableTo<ReturnType<typeof EnvelopeSchema<z.ZodUnknown>>, BuiltinToolAction['outputSchema']>
>;
/**
 * …and it is not assignable to the CONSUMER union either, so nothing widened.
 * @proof
 */
export type _OutputSchemaNewActionDeclaringVacuousIsNotRegistered = ExpectTrue<
  NotAssignableTo<ReturnType<typeof EnvelopeSchema<z.ZodUnknown>>, ToolAction['outputSchema']>
>;
/**
 * The escape is closed too: an id that is not already seeded in the shrink-only
 * allowlist is not a `VacuityWaiverId`, so `vacuityWaiver('<new id>')` is also
 * a compile error. Waiving a NEW declaration requires editing the generated
 * seed file, which is exactly the reviewable act DR-4 wants it to be.
 * @proof
 */
export type _OutputSchemaNewActionCannotBeWaived = ExpectTrue<
  NotAssignableTo<'exarchos_view.a_brand_new_action', VacuityWaiverId>
>;
/**
 * TASK 060, HOLE 1 — THE ACCEPTANCE CRITERION.
 * `OutputSchema_RegistryActionUsingExtensionEscape_FailsCompile`, stated where
 * it is enforced. The out-of-registry escape returns `ExtensionOutputSchema`
 * (proved in `output-schema-declaration.ts`), and that type does not satisfy a
 * built-in declaration's `outputSchema`. A new action in this file that reaches
 * for `unregisteredActionOutputSchema()` does not compile — it no longer merely
 * reddens the runtime audit.
 * @proof
 */
export type _OutputSchemaRegistryActionUsingExtensionEscapeFailsCompile = ExpectTrue<
  NotAssignableTo<ExtensionOutputSchema, BuiltinToolAction['outputSchema']>
>;
/**
 * The same claim one level up: an extension action is not a registry declaration.
 * @proof
 */
export type _OutputSchemaExtensionActionIsNotABuiltinDeclaration = ExpectTrue<
  NotAssignableTo<ExtensionToolAction, BuiltinToolAction>
>;
/**
 * …and the DOOR is the registry constant, not a per-array annotation: a plain
 * `CompositeTool` (whose actions carry the consumer-facing union) is not a legal
 * `TOOL_REGISTRY` entry, so a new `readonly ToolAction[]` array cannot be
 * smuggled in beside the five that exist.
 * @proof
 */
export type _OutputSchemaRegistryDoorRejectsUnnarrowedTools = ExpectTrue<
  NotAssignableTo<CompositeTool, BuiltinCompositeTool>
>;
/**
 * And the guarantee is not vacuous — the two blessed constructors DO satisfy
 * a built-in declaration's field, and the escape DOES satisfy an extension
 * declaration's. Without these lines the aliases above would still pass if a
 * field had been narrowed to something nothing at all can produce, and the
 * `.exarchos.yml` surface could have been "closed" by breaking it.
 * @proof
 */
export type _OutputSchemaCappedShapeSatisfiesTheField = ExpectTrue<
  ReturnType<typeof withCappedShape> extends BuiltinToolAction['outputSchema'] ? true : false
>;
/** @proof */
export type _OutputSchemaWaiverSatisfiesTheField = ExpectTrue<
  ReturnType<typeof vacuityWaiver> extends BuiltinToolAction['outputSchema'] ? true : false
>;
/** @proof */
export type _OutputSchemaExtensionEscapeSatisfiesTheExtensionField = ExpectTrue<
  ExtensionOutputSchema extends ExtensionToolAction['outputSchema'] ? true : false
>;
/**
 * Both declaration types remain consumable as plain `ToolAction`s.
 * @proof
 */
export type _OutputSchemaBuiltinActionIsAToolAction = ExpectTrue<
  BuiltinToolAction extends ToolAction ? true : false
>;
/** @proof */
export type _OutputSchemaExtensionActionIsAToolAction = ExpectTrue<
  ExtensionToolAction extends ToolAction ? true : false
>;
/** @proof */
export type _OutputSchemaExtensionToolIsACompositeTool = ExpectTrue<
  ExtensionCompositeTool extends CompositeTool ? true : false
>;

// ─── Schema Generation ──────────────────────────────────────────────────────

/** A ZodObject whose shape includes an `action` discriminator key. */
type ActionDiscriminatedSchema = z.ZodObject<{ action: z.ZodType } & z.ZodRawShape>;

/**
 * Builds a Zod discriminated union from a list of ToolActions.
 * Each action's schema is extended with an `action: z.literal(name)` discriminator.
 *
 * Note (Zod v4): `ZodDiscriminatedUnion` swapped its generic order. The
 * declaration is now `<Options, Disc>` (tuple first, discriminator second);
 * v3 used `<Disc, Options>`.
 */
export function buildCompositeSchema(
  actions: readonly ToolAction[],
): z.ZodDiscriminatedUnion<[ActionDiscriminatedSchema, ...ActionDiscriminatedSchema[]], 'action'> {
  if (actions.length < 2) {
    throw new Error('buildCompositeSchema requires at least 2 actions for a discriminated union');
  }

  // The .extend() call adds { action: z.literal(name) } to each schema, but
  // TypeScript cannot infer the discriminator key through .map(). The assertion
  // is safe because every schema is extended with an `action` literal field.
  const schemas = actions.map((action) =>
    action.schema.extend({ action: z.literal(action.name) }),
  ) as ActionDiscriminatedSchema[];

  // Zod discriminatedUnion requires a tuple of [first, ...rest]
  const [first, ...rest] = schemas;
  if (first === undefined) {
    throw new Error('buildCompositeSchema requires at least 2 actions for a discriminated union');
  }
  return z.discriminatedUnion('action', [first, ...rest]);
}

/**
 * Unwraps `z.preprocess()` effects so zodToJsonSchema emits the inner
 * schema's type (e.g., `{"type":"object"}`) instead of an opaque
 * `{"allOf":[{},{"type":"object"}]}` wrapper.  Handles both bare and
 * optional-wrapped preprocess effects.
 *
 * The preprocess coercion still runs at validation time via the original
 * action schemas in `buildCompositeSchema` — this only affects the JSON
 * Schema sent to tool callers.
 *
 * Zod v4 unified `ZodEffects` into `ZodPipe`. A `z.preprocess(fn, inner)`
 * is now a `ZodPipe` whose `def.in` is a `ZodTransform` and whose `def.out`
 * is the original `inner` schema. We detect that exact shape rather than
 * matching every `ZodPipe` — `.transform()` is also a `ZodPipe` but with
 * `transform` as `def.out`, which we don't want to unwrap (the wire-level
 * type is the inner schema's output, not its input).
 */
function isPreprocessPipe(schema: z.ZodType): schema is z.ZodPipe {
  if (!(schema instanceof z.ZodPipe)) return false;
  const def = schema._zod.def;
  return def.in._zod.def.type === 'transform';
}

function unwrapPreprocess(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodOptional) {
    // Zod v4 types `innerType` as the core `$ZodType` (the internal base
    // interface) rather than the classic `ZodType`. Cast at the boundary;
    // the runtime instance is always a classic schema in practice.
    const inner = schema._zod.def.innerType as z.ZodType;
    if (isPreprocessPipe(inner)) {
      return (inner._zod.def.out as z.ZodType).optional();
    }
  }
  if (isPreprocessPipe(schema)) {
    return schema._zod.def.out as z.ZodType;
  }
  return schema;
}

/**
 * Builds a strict Zod object schema for MCP SDK tool registration.
 *
 * The MCP SDK's `normalizeObjectSchema` cannot generate JSON Schema from
 * discriminated unions, so we flatten the composite schema into a single
 * object with `action` as a required enum and all other fields as optional.
 *
 * The composite handler performs action-level routing and the underlying
 * handlers validate required fields per action.
 *
 * The returned schema uses `.strict()` so that unrecognized parameter names
 * (e.g., `streamId` instead of `stream`) produce clear validation errors
 * instead of being silently dropped.
 *
 * Preprocess effects are unwrapped so zodToJsonSchema emits clean type
 * constraints (e.g., `{"type":"object"}`) rather than opaque wrappers.
 * Runtime coercion is preserved via the original schemas in buildCompositeSchema.
 */
export function buildRegistrationSchema(
  actions: readonly ToolAction[],
): z.ZodObject<z.ZodRawShape> {
  const actionNames = actions.map((a) => a.name) as [string, ...string[]];
  // Zod v4 typed `ZodRawShape` as `Readonly<{[k:string]:$ZodType}>`, so the
  // builder uses a plain mutable record and casts at the `z.object(...)`
  // boundary. Behavior is unchanged: the resulting object still has the
  // same shape and `.strict()` semantics.
  const shape: Record<string, z.ZodType> = {
    action: z.enum(actionNames),
  };
  // Track the first action to declare each field. A later action declaring the
  // same field with an incompatible enum value set or differing default is a
  // #1127-class collision — the composite's "first wins" merge silently
  // shadowed the later declaration at the MCP-registration boundary.
  // Constraint drift (min/max, pattern, optionality) is allowed: handler-level
  // schemas re-validate via dispatch(), so "first wins" is harmless there.
  const provenance = new Map<string, { action: string; contract: FieldContract }>();

  for (const action of actions) {
    const fields = action.schema.shape;
    for (const [key, zodType] of Object.entries(fields)) {
      const field = unwrapPreprocess(zodType as z.ZodType);
      const contract = fieldContract(field);

      const prior = provenance.get(key);
      if (prior) {
        const conflict = describeContractConflict(prior.contract, contract);
        if (conflict) {
          throw new Error(
            `buildRegistrationSchema: field '${key}' declared by action '${action.name}' collides with the declaration from action '${prior.action}'. ${conflict} ` +
            `Rename the field in one action (see agent_spec.outputFormat, #1127) or align the declarations.`,
          );
        }
        continue; // compatible — first wins preserved
      }

      shape[key] = field.isOptional() ? field : field.optional();
      provenance.set(key, { action: action.name, contract });
    }
  }

  return z.object(shape as z.ZodRawShape).strict();
}

/**
 * Contract-level view of a Zod field, capturing only the properties whose
 * divergence across actions causes MCP-registration-time hazards: the enum
 * value set and the default value. Base type is tracked solely to distinguish
 * enum-vs-non-enum collisions. Refinements and optionality are ignored.
 */
interface FieldContract {
  readonly kind: 'enum' | 'string' | 'number' | 'boolean' | 'array' | 'object' | 'other';
  readonly enumValues: readonly string[] | null; // present iff kind === 'enum'
  readonly defaultValue: string | null; // JSON-stringified default, null if none
}

function fieldContract(zodType: z.ZodType): FieldContract {
  const inner = unwrapOptional(zodType);
  const enumValues = extractEnumValues(inner);
  const defaultValue = extractDefault(inner);
  return {
    kind: enumValues ? 'enum' : baseKind(inner),
    enumValues,
    defaultValue: defaultValue === undefined ? null : JSON.stringify(defaultValue),
  };
}

function baseKind(schema: z.ZodType): FieldContract['kind'] {
  let current: z.ZodType = schema;
  // Zod v4: `_def` was renamed to `_zod.def`. Inner-type peeling now uses
  // `_zod.def.innerType`.
  if (current instanceof z.ZodDefault) current = current._zod.def.innerType as z.ZodType;
  if (current instanceof z.ZodOptional) current = current._zod.def.innerType as z.ZodType;
  if (current instanceof z.ZodString) return 'string';
  // Number covers z.number() and z.number().int() — JSON Schema distinguishes
  // them as number vs integer, but the per-handler schema re-validates
  // refinements, so at the composite boundary they're the same contract.
  if (current instanceof z.ZodNumber) return 'number';
  if (current instanceof z.ZodBoolean) return 'boolean';
  if (current instanceof z.ZodArray) return 'array';
  if (current instanceof z.ZodObject || current instanceof z.ZodRecord) return 'object';
  return 'other';
}

function unwrapOptional(schema: z.ZodType): z.ZodType {
  let current: z.ZodType = schema;
  // Peel Optional and Nullable wrappers. Keep Default wrappers — the default
  // is a contract-level attribute we explicitly want to inspect.
  while (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
    current = current._zod.def.innerType as z.ZodType;
  }
  return current;
}

function extractEnumValues(schema: z.ZodType): readonly string[] | null {
  const current = peelEnumWrappers(schema);
  if (current instanceof z.ZodEnum) {
    // Zod v4 unified `ZodEnum` and `ZodNativeEnum` into a single `ZodEnum`
    // whose `def.entries` is a `{ name: value }` map. For string enums the
    // map is `{x:'x', y:'y'}`; for numeric TS enums it round-trips both
    // member names and values via reverse mapping
    // (`{'0':'A', '1':'B', A:0, B:1}`). Stringify-dedupe to produce a
    // stable, comparable value set across both shapes.
    const raw = Object.values(current._zod.def.entries as Record<string, unknown>);
    return [...new Set(raw.map((v) => JSON.stringify(v)))].sort();
  }
  if (current instanceof z.ZodLiteral) {
    // Treat a literal as a 1-member enum so two actions declaring the same
    // field with different literal values collide instead of silently
    // shadowing each other (#1127-class hazard). Zod v4 changed
    // `ZodLiteral.def` from `{ value: T }` to `{ values: T[] }` (an array
    // — a literal can now carry multiple permitted values in one schema).
    const values = current._zod.def.values as readonly unknown[];
    return [...new Set(values.map((v) => JSON.stringify(v)))].sort();
  }
  if (current instanceof z.ZodUnion) {
    // Union-of-literals is the hand-rolled form of z.enum(). Collect the
    // literal values; fall back to null if any branch isn't a literal so
    // heterogeneous unions (e.g. string | string[]) still classify via
    // baseKind instead of being falsely flagged as enum-compatible.
    const options = current._zod.def.options as readonly z.ZodType[];
    const literalValues: string[] = [];
    for (const opt of options) {
      const peeled = peelEnumWrappers(opt);
      if (!(peeled instanceof z.ZodLiteral)) return null;
      const lits = peeled._zod.def.values as readonly unknown[];
      for (const v of lits) literalValues.push(JSON.stringify(v));
    }
    return [...new Set(literalValues)].sort();
  }
  return null;
}

/** Peel ZodDefault / ZodOptional / ZodNullable wrappers so the caller can
 *  match on the underlying enum-ish kind. Kept narrow on purpose: we don't
 *  peel ZodPipe (formerly ZodEffects) or ZodBranded because those change
 *  the wire-level contract and deserve to be classified distinctly. */
function peelEnumWrappers(schema: z.ZodType): z.ZodType {
  let current: z.ZodType = schema;
  while (
    current instanceof z.ZodDefault ||
    current instanceof z.ZodOptional ||
    current instanceof z.ZodNullable
  ) {
    current = current._zod.def.innerType as z.ZodType;
  }
  return current;
}

function extractDefault(schema: z.ZodType): unknown {
  if (schema instanceof z.ZodDefault) {
    // Zod v4: `def.defaultValue` is the value itself (not a getter
    // function). v3 stored a `() => T` thunk that we had to invoke; v4
    // resolves the lazy form internally and exposes the materialized
    // value on the def. See `$ZodDefaultDef.defaultValue` in
    // zod/v4/core/schemas.d.ts.
    return schema._zod.def.defaultValue;
  }
  return undefined;
}

function describeContractConflict(a: FieldContract, b: FieldContract): string | null {
  if (a.kind !== b.kind) {
    return `Base types differ: ${a.kind} vs ${b.kind}.`;
  }
  if (a.kind === 'enum') {
    if (
      !a.enumValues ||
      !b.enumValues ||
      a.enumValues.length !== b.enumValues.length ||
      a.enumValues.some((v, i) => v !== b.enumValues![i])
    ) {
      return `Enum value sets differ: [${a.enumValues?.join(', ')}] vs [${b.enumValues?.join(', ')}].`;
    }
  }
  if (a.defaultValue !== b.defaultValue) {
    return `Default values differ: ${a.defaultValue ?? '(none)'} vs ${b.defaultValue ?? '(none)'}.`;
  }
  return null;
}

/**
 * Builds a tool description that includes action signatures.
 * Appends action names and their parameters to the base description.
 */
export function buildToolDescription(tool: CompositeTool, slim = false): string {
  if (slim && tool.slimDescription) {
    return tool.slimDescription;
  }
  const actionSigs = tool.actions.map((action) => {
    const fields = Object.entries(action.schema.shape);
    const params = fields.map(([key, zodType]) => {
      const isOptional = (zodType as z.ZodType).isOptional();
      return isOptional ? `${key}?` : key;
    });
    return `- ${action.name}(${params.join(', ')}): ${action.description}`;
  });
  return `${tool.description}\n\nActions:\n${actionSigs.join('\n')}`;
}

// ─── Shared Constants ───────────────────────────────────────────────────────

export const ALL_PHASES: ReadonlySet<string> = new Set([
  // Feature workflow
  'plan',
  'plan-review',
  'delegate',
  // Substate of `delegate` — entered when a worktree-task's autonomous merge
  // is pending. Must be in this set so phase-gated actions (notably
  // `merge_orchestrate` itself) remain dispatchable while the workflow sits
  // in this phase.
  'merge-pending',
  'review',
  'synthesize',
  // Debug workflow
  'triage',
  'investigate',
  'rca',
  'design',
  'debug-implement',
  'debug-validate',
  'debug-review',
  'hotfix-implement',
  'hotfix-validate',
  // Refactor workflow
  'explore',
  'brief',
  'polish-implement',
  'polish-validate',
  'polish-update-docs',
  'overhaul-plan',
  'overhaul-delegate',
  'overhaul-review',
  'overhaul-update-docs',
  // Oneshot workflow (compressed lifecycle: plan → implementing →
  // synthesize|completed). `plan` is already present above from the
  // feature workflow; `implementing` is oneshot-exclusive and MUST be in
  // this set so generic actions gated by ALL_PHASES (get / set / cancel /
  // event append / etc.) remain callable while a oneshot is mid-flight.
  'implementing',
  // Shared
  'blocked',
]);

const ROLE_ANY: ReadonlySet<string> = new Set(['any']);
const ROLE_LEAD: ReadonlySet<string> = new Set(['lead']);
const ROLE_TEAMMATE: ReadonlySet<string> = new Set(['teammate']);

const DELEGATE_PHASES: ReadonlySet<string> = new Set([
  'delegate',
  'overhaul-delegate',
  'debug-implement',
]);
const STACK_PHASES: ReadonlySet<string> = new Set([
  'synthesize',
  'delegate',
  'overhaul-delegate',
  'debug-implement',
]);
const REVIEW_PHASES: ReadonlySet<string> = new Set([
  'review',
  'overhaul-review',
  'debug-review',
]);
const SYNTHESIS_REVIEW_PHASES: ReadonlySet<string> = new Set([
  'synthesize',
  'review',
  'overhaul-review',
  'debug-review',
]);
const PLAN_PHASES: ReadonlySet<string> = new Set([
  'plan',
  'plan-review',
  'overhaul-plan',
]);
// `prepare_review` serves BOTH the back-of-pipeline code-review catalog (REVIEW
// phases) and the DR-10 front-of-pipeline plan-review provisioning (the
// `plan-review` PLAN-kind phase). Deliberately NOT equal to the PLAN_PHASES set
// — an action whose phase set exactly equals the plan-structure binding counts
// as a canonical plan gate (the #1581 task-013 binding trap), which prepare_review
// is not (it is a non-blocking provisioning surface, scope-discriminated).
const PREPARE_REVIEW_PHASES: ReadonlySet<string> = new Set([
  ...REVIEW_PHASES,
  'plan-review',
]);

// ─── Shared Schema Fragments ────────────────────────────────────────────────

const featureIdSchema = z.string().min(1).regex(/^[a-z0-9-]+$/);

// ─── Describe Action ────────────────────────────────────────────────────────

const describeSchema = z.object({
  actions: z.array(z.string()).min(1).max(10)
    .describe('Action names to describe. Returns full schema + description for each.'),
});

/** Creates a shared describe action definition for composite tools. */
function makeDescribeAction(waiverId: VacuityWaiverId): BuiltinToolAction {
  return {
    name: 'describe',
    description: 'Return full schemas, descriptions, gate metadata, and phase/role info for specific actions',
    schema: describeSchema,
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    // DR-1: verbose-by-design detail path — full per-action JSON schemas.
    economy: { budgetTokens: DESCRIBE_ECONOMY_BUDGET_TOKENS },
    outputSchema: vacuityWaiver(waiverId),
    annotations: READ_ONLY_LOCAL,
  };
}

/** Workflow-specific describe schema: supports actions, topology, playbooks, and config. */
const workflowDescribeSchema = z.object({
  actions: z.array(z.string()).min(1).max(10)
    .describe('Action names to describe. Returns full schema + description for each.')
    .optional(),
  topology: z.string()
    .describe('Workflow type to return HSM topology for. Use "all" to list all types.')
    .optional(),
  playbook: z.string()
    .describe('Workflow type for phase playbooks. "all" lists types.')
    .optional(),
  config: z.boolean()
    .describe('When true, returns annotated project config showing values and sources (default vs .exarchos.yml).')
    .optional(),
});

/** Creates a workflow-specific describe action with topology, playbook, and config support. */
function makeWorkflowDescribeAction(waiverId: VacuityWaiverId): BuiltinToolAction {
  return {
    name: 'describe',
    description: 'Return full schemas, descriptions, gate metadata, and phase/role info for specific actions. Optionally return HSM topology, phase playbooks, or annotated project config.',
    schema: workflowDescribeSchema,
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    // DR-1: verbose-by-design detail path — schemas + topology/playbooks/config.
    economy: { budgetTokens: DESCRIBE_ECONOMY_BUDGET_TOKENS },
    outputSchema: vacuityWaiver(waiverId),
    annotations: READ_ONLY_LOCAL,
  };
}

const eventDescribeSchema = z.object({
  actions: z.array(z.string()).min(1).max(10)
    .describe('Action names to describe. Returns full schema + description for each.')
    .optional(),
  eventTypes: z.array(z.string()).min(1).max(20)
    .describe('Event type names to describe. Returns data schema, emission source, and built-in status for each.')
    .optional(),
  emissionGuide: z.boolean().optional()
    .describe('When true, returns the full event emission catalog grouped by source'),
});

/** Creates a describe action for the event tool that supports both actions, eventTypes, and emissionGuide. */
function makeEventDescribeAction(waiverId: VacuityWaiverId): BuiltinToolAction {
  return {
    name: 'describe',
    description: 'Return schemas for actions and/or event types, or the emission guide. At least one of actions, eventTypes, or emissionGuide must be provided.',
    schema: eventDescribeSchema,
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    // DR-1: verbose-by-design detail path whose budget accounts for the
    // `emissionGuide` param path (the full event catalog), which is a param
    // of this one describe action — not a separate action.
    economy: { budgetTokens: EVENT_DESCRIBE_ECONOMY_BUDGET_TOKENS },
    outputSchema: vacuityWaiver(waiverId),
    annotations: READ_ONLY_LOCAL,
  };
}

// ─── Output Schemas — `_meta.deprecation` Registration (DR-11, #1259) ──────
//
// The HSM single-path consolidation introduces a deprecation envelope on
// the affected actions. `_meta.deprecation` describes the migration window
// (since/removeIn) and the canonical replacement so agents can self-correct
// without human prompting. The schemas below describe the typed sub-shape
// registered in each action's `outputSchema`.
//
// v2.10 registered the same typed sub-shape on both
// `exarchos_workflow.set` and `exarchos_workflow.transition`. v2.11 (DR-4)
// removes the `set` action entry from the registry, but keeps the
// `_meta.deprecation` slot on `transition`'s `outputSchema` for one more
// release as a historical marker (INV-5b). v2.12 drops the slot.
// `WorkflowSetOutputSchema` is retained as a private export for one
// release to preserve symmetry of the schema definitions; nothing in the
// registry references it any longer.
//
// The envelope version is implicitly bumped via this schema registration:
// `_meta.envelopeVersion` callers can rely on the structured deprecation
// payload appearing instead of (or alongside) any free-text warning that
// may have surfaced via `result.warnings` historically.

/**
 * `_meta.deprecation` typed sub-shape (DR-4, DR-11). Surfaces on the response
 * envelope of any action whose handler routes through a deprecation rerouting
 * surface (currently: `exarchos_workflow.set` when `phase` is provided).
 *
 * `since` / `removeIn` use semver strings (validated as non-empty);
 * `replacement` names the canonical action a caller should migrate to.
 */
export const MetaDeprecationSchema = z.object({
  since: z.string().min(1).describe('Version when this action was deprecated (semver)'),
  removeIn: z.string().min(1).describe('Version when this action is removed (semver)'),
  replacement: z.string().min(1).describe('Canonical action name that supersedes this one'),
});

// Wave 0 / Task G.2 (#1340): consolidate the three v2.10.0-preview.2
// standalone envelope constants onto the canonical `EnvelopeSchema(data)`
// factory from `contract/schemas/envelope.ts`. Each surface remains as a named
// export so any downstream consumer that typed-imported the constants
// directly continues to compile through one release window; canonical
// replacement is `EnvelopeSchema` itself (callers should migrate to it
// before the v2.12 removal).
//
// Per design §2.1 (single envelope factory) and DIM-1 (dispatch core is
// single-source for action contracts) — the previous bespoke
// `z.object({...}).passthrough()` shapes drifted from the canonical
// envelope contract (no typed `_perf`, `success` not literal-discriminated,
// no typed `error` block). The factory anchors all three on the same
// discriminated-union envelope and applies an additional intersection
// constraint where DR-4/DR-11 requires the typed `_meta.deprecation`
// sub-shape.

/**
 * Shape constraint for `_meta.deprecation` (DR-4, DR-11). When `_meta`
 * carries a `deprecation` slot, each sub-field must validate against
 * {@link MetaDeprecationSchema}. The slot itself is always optional —
 * the canonical action does not emit it; the rerouted/deprecated
 * surface does.
 *
 * `passthrough()` on `_meta` so the rest of the typed envelope's
 * `z.record(z.string(), z.unknown())` _meta merge survives the
 * intersection.
 */
const MetaDeprecationConstraint = z.object({
  _meta: z.object({
    deprecation: MetaDeprecationSchema.optional(),
  }).passthrough().optional(),
}).passthrough();

/**
 * `outputSchema` for the (now-removed) `exarchos_workflow.set` action.
 *
 * @deprecated v2.10 LCD; will be removed in v2.12. Use
 * `EnvelopeSchema(dataSchema)` from `./schemas/envelope.js` directly.
 *
 * Retained for one release as a named re-export so downstream typed
 * imports compile. Nothing in the registry references this constant
 * any longer (the `set` action entry was removed in v2.11/DR-4).
 */
export const WorkflowSetOutputSchema = EnvelopeSchema(z.unknown()).and(
  MetaDeprecationConstraint,
);

/**
 * `outputSchema` for `exarchos_workflow.transition` (DR-11).
 *
 * @deprecated v2.10 LCD; will be removed in v2.12. Use
 * `EnvelopeSchema(dataSchema)` from `./schemas/envelope.js` directly
 * (parameterized on the action's success-data shape).
 *
 * Thin wrapper over the canonical envelope factory plus the DR-4/DR-11
 * typed `_meta.deprecation` constraint. The canonical action does not
 * emit `_meta.deprecation` itself, but registering the typed sub-shape
 * keeps the surfaces interchangeable from a contract-introspection
 * standpoint (INV-5b).
 */
export const WorkflowTransitionOutputSchema = EnvelopeSchema(z.unknown()).and(
  MetaDeprecationConstraint,
);

/**
 * `outputSchema` for `exarchos_workflow.update` (Wave 0, #1340 prep for
 * #1266).
 *
 * @deprecated v2.10 LCD; will be removed in v2.12. Use
 * `EnvelopeSchema(dataSchema)` from `./schemas/envelope.js` directly.
 *
 * Mirrors {@link WorkflowTransitionOutputSchema} EXCEPT the
 * `_meta.deprecation` constraint: `update` is a canonical surface
 * restored in v2.10.0-preview.2 and is not on a deprecation track, so
 * the envelope does not advertise the migration sub-shape.
 */
export const WorkflowUpdateOutputSchema = EnvelopeSchema(z.unknown());

/**
 * `outputSchema` for `exarchos_view.telemetry` (PR3/T10, #1364 — Wave 3
 * polish on top of Wave 0 carrier swap).
 *
 * Typed envelope so MCP advertises the per-tool `actionErrors` and
 * `actionErrorBreakdown` fields the `tool.action_errored` projection now
 * folds. Both fields are required on every tool entry so downstream
 * consumers (CLI rendering, dashboards, drift detection) can rely on
 * their presence rather than treating them as optional decorators.
 *
 * The per-tool entry is intentionally `.passthrough()` because the
 * compact-vs-full split adds extra arrays (`durations`, `sizes`,
 * `tokenEstimates`) on the non-compact path — strict objects would
 * reject the full shape. `hints[]` items are also passthrough to leave
 * room for future hint flavours without re-cutting the schema.
 *
 * See [`docs/designs/archive/2026-05-15-wave2-wave3-polish.md`](../docs/designs/archive/2026-05-15-wave2-wave3-polish.md)
 * `#1364 — split transport vs action-level errors` for context.
 */
const TelemetryToolEntrySchema = z.object({
  tool: z.string(),
  invocations: z.number().nonnegative(),
  errors: z.number().nonnegative(),
  totalDurationMs: z.number().nonnegative(),
  totalBytes: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
  p50DurationMs: z.number().nonnegative(),
  p95DurationMs: z.number().nonnegative(),
  p50Bytes: z.number().nonnegative(),
  p95Bytes: z.number().nonnegative(),
  p50Tokens: z.number().nonnegative(),
  p95Tokens: z.number().nonnegative(),
  // PR3/T10 (#1364) — structured action-level failure counters.
  actionErrors: z.number().nonnegative(),
  actionErrorBreakdown: z.record(z.string(), z.number().nonnegative()),
}).passthrough();

const TelemetryViewDataSchema = z.object({
  session: z.object({
    start: z.string(),
    totalInvocations: z.number().nonnegative(),
    totalTokens: z.number().nonnegative(),
  }),
  tools: z.array(TelemetryToolEntrySchema),
  hints: z.array(z.unknown()),
}).passthrough();

export const TelemetryViewOutputSchema = EnvelopeSchema(TelemetryViewDataSchema);

// ─── Capped-shape outputSchema union (DR-1/DR-3/DR-8, Task 022) ───────────────
//
// DR-4 (task 055) moved `CappedDataSchema` and `withCappedShape` into
// `output-schema-declaration.ts`, where the `DeclaredOutputSchema` brand they
// mint is defined. The brand's minting function is module-private there, which
// is what makes `withCappedShape` the SOLE constructor of a substantive
// `outputSchema` instead of merely the conventional one. Both are re-exported
// from this module so their long-standing import path (`./registry.js`) keeps
// working for the economy-enforcement and contract-compiler consumers.
export { CappedDataSchema, withCappedShape } from './output-schema-declaration.js';

// ─── Composite Tool: exarchos_workflow ───────────────────────────────────────

const workflowActions: readonly BuiltinToolAction[] = [
  {
    name: 'init',
    description: 'Initialize a new workflow. Auto-emits workflow.started event. For workflowType=oneshot, an optional synthesisPolicy (always | never | on-request) seeds state.oneshot.synthesisPolicy; silently ignored for other workflow types.',
    schema: z.object({
      featureId: featureIdSchema,
      workflowType: WorkflowTypeSchema,
      synthesisPolicy: z.enum(['always', 'never', 'on-request']).optional(),
    }),
    phases: new Set<string>(),
    roles: ROLE_LEAD,
    cli: {
      flags: { featureId: { alias: 'f' }, workflowType: { alias: 't' } },
      examples: [
        'exarchos wf init -f my-feature -t feature',
        'exarchos wf init -f my-oneshot -t oneshot --synthesisPolicy always',
      ],
    },
    autoEmits: [
      { event: 'workflow.started', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_workflow.init'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'get',
    description: 'Read workflow state with optional query or field projection',
    schema: z.object({
      featureId: featureIdSchema,
      query: z.string().optional(),
      fields: coercedStringArray().optional(),
      // #1555 — optional bounded-fold (as-of/time-travel) read. Shares the
      // single-source `AsOfSchema`; mutually-exclusive untilSequence /
      // untilTimestamp enforced at the schema. Omitted ⇒ live tip.
      asOf: AsOfSchema.optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    cli: {
      alias: 'status',
      flags: { featureId: { alias: 'f' }, query: { alias: 'q' } },
      examples: [
        'exarchos wf status -f my-feature',
        'exarchos wf status -f my-feature -q phase',
        'exarchos wf status -f my-feature --as-of \'{"untilSequence":3}\'',
      ],
    },
    outputSchema: vacuityWaiver('exarchos_workflow.get'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'transition',
    description: 'Transition the workflow to a target phase. Canonical phase-mutation action. Routes through the HSM transition guard primitive — emits exactly one workflow.transition event on success, or returns a structured error envelope (validTargets, expectedShape, suggestedFix) on guard/topology failure.',
    schema: z.object({
      featureId: featureIdSchema,
      target: z.string().min(1).describe('Target phase (must be a declared transition from the current phase)'),
    }),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    cli: {
      flags: { featureId: { alias: 'f' }, target: { alias: 't' } },
      examples: ['exarchos wf transition -f my-feature -t plan'],
    },
    autoEmits: [
      { event: 'workflow.transition', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_workflow.transition', WorkflowTransitionOutputSchema),
    annotations: LOCAL_MUTATION,
  },
  {
    // Wave 0 (#1340, v2.10.0-preview.2): canonical state-mutation surface.
    // Replaces the deprecated v2.10 `set({updates})` rerouting path that
    // was removed alongside `set({phase})` in v2.11. Phase mutation lives
    // on `transition`; non-phase fields (artifacts, planReview, task
    // results, etc.) flow through this action so callers see a single
    // validated, output-enveloped surface instead of being told to emit
    // `state.patched` directly via `event.append` (which bypasses input
    // validation, output enveloping, idempotency, and `next_actions`).
    //
    // Handler delegates to the existing internal `workflow.update()`
    // helper (`handleSet` with `updates` only, no `phase`). The phase
    // field is rejected at the input boundary with a structured
    // `INVALID_INPUT` + `suggestedFix` pointing callers at `transition`
    // (Task 0.2). `updates` is `Record<string, unknown>` so dot-paths
    // (`'artifacts.design'`) and nested objects both resolve through
    // `applyDotPath` in `handleSet`.
    name: 'update',
    description: 'Mutate non-phase workflow state fields (artifacts, planReview, task results, etc.). Canonical state-mutation surface. Emits exactly one state.patched event on success. For phase changes use action: transition.',
    schema: z.object({
      featureId: featureIdSchema,
      updates: z.record(z.string(), z.unknown()),
    }),
    // Wave 0 judgment call: the plan literally specified `new Set<string>()`
    // (no phases) but the registry has an existing invariant — enforced by
    // `registry.test.ts:should have non-empty phases for every action except
    // init` — that every non-init action declares at least one phase. Using
    // `ALL_PHASES` honors both the plan's intent (phase-agnostic mutation
    // surface, parallel to `transition`) and the existing invariant. The
    // semantically equivalent alternative would be to widen the test's
    // exception list, but adding `update` to the empty-phase exception
    // bucket would couple a foundational action to an `init`-only escape
    // hatch — fragile against future audits.
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    cli: {
      flags: { featureId: { alias: 'f' } },
      examples: ['exarchos wf update -f my-feature --updates \'{"artifacts":{"spec":"docs/specs/foo.md"}}\''],
    },
    autoEmits: [
      { event: 'state.patched', condition: 'always' },
    ],
    // Wave 0 (#1340) — register WorkflowUpdateOutputSchema for envelope-
    // version discipline (#1266 prep). The schema mirrors the transition
    // surface's contract minus the `_meta.deprecation` slot (`update` is
    // not on a deprecation track) so a future contract-introspection
    // consumer can decode both surfaces with the same envelope shape.
    // `describe/handler.ts` exposes the schema via `outputSchema` in
    // action descriptions; callers reach it through
    // `exarchos_workflow.describe({actions: ['update']})`.
    outputSchema: vacuityWaiver('exarchos_workflow.update', WorkflowUpdateOutputSchema),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'cancel',
    description: 'Cancel a workflow with saga compensation. Auto-emits workflow.cancel and compensation events',
    schema: z.object({
      featureId: featureIdSchema,
      dryRun: z.boolean().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    autoEmits: [
      { event: 'workflow.cancel', condition: 'always' },
      { event: 'workflow.compensation', condition: 'conditional', description: 'Per compensation action' },
    ],
    outputSchema: vacuityWaiver('exarchos_workflow.cancel'),
    annotations: COMPENSABLE_LOCAL,
  },
  {
    name: 'cleanup',
    description: 'Resolve a merged workflow to completed. Verifies merge, backfills synthesis metadata, force-resolves reviews, transitions to completed. Auto-emits workflow.cleanup event',
    schema: z.object({
      featureId: featureIdSchema,
      mergeVerified: z.boolean(),
      prUrl: z.union([z.string(), z.array(z.string())]).optional(),
      mergedBranches: z.array(z.string()).optional(),
      dryRun: z.boolean().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    autoEmits: [
      { event: 'workflow.cleanup', condition: 'always' },
    ],
    // T9 (#1440 Op 2, preview-4 design §4.3): post-merge cleanup is a
    // long-running multi-step verb (merge verification, synthesis
    // metadata backfill, review force-resolve, transition) that benefits
    // from Tasks-augmented dispatch. The annotation is advisory — the
    // binding opt-in gate stays at `dispatch/core/dispatch.ts:927-954`.
    dispatch: { taskSuitable: true, taskTtlSuggestionMs: 60_000 },
    outputSchema: vacuityWaiver('exarchos_workflow.cleanup'),
    annotations: COMPENSABLE_LOCAL,
  },
  {
    name: 'reconcile',
    description: 'Rebuild workflow state from event store. Applies events newer than state _eventSequence. Idempotent — no new events returns {reconciled: false, eventsApplied: 0}. Use after compaction or crash recovery',
    schema: z.object({
      featureId: featureIdSchema,
    }),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_workflow.reconcile'),
    annotations: LOCAL_MUTATION_IDEMPOTENT,
  },
  {
    name: 'rehydrate',
    description: 'Rehydrate the canonical workflow document for a feature via the rehydration@v1 projection. Loads the latest snapshot and folds events written since, returning the full RehydrationDocument. Emits workflow.rehydrated on successful hydration (T032, DR-4) — the event records the deliveryPath used so downstream observers can correlate cache hints. Optional deliveryPath ∈ {direct, ndjson, snapshot}; defaults to "direct".',
    schema: z.object({
      featureId: featureIdSchema,
      // Closed enum mirrors `WorkflowRehydratedData.deliveryPath` so an
      // invalid value can't reach the workflow.rehydrated event payload.
      // Without this, registry validation accepted any string and let the
      // bad value bubble all the way to event-store append, where Zod
      // would reject it AFTER the read had already produced a document —
      // surfacing as a confusing "rehydrate succeeded but emit failed"
      // call. (CodeRabbit on PR #1178.)
      deliveryPath: z.enum(['direct', 'ndjson', 'snapshot']).optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    autoEmits: [
      {
        event: 'workflow.rehydrated',
        condition: 'conditional',
        description: 'When rehydration succeeds (event-store emission failures are logged but do not fail the call — see rehydrate.ts).',
      },
    ],
    // T9 (#1440 Op 2, preview-4 design §4.3): full state rebuild is a
    // long-running projection fold (latest snapshot + every event since)
    // that benefits from Tasks-augmented dispatch. Advisory — the
    // binding opt-in gate stays at `dispatch/core/dispatch.ts:927-954`.
    dispatch: { taskSuitable: true, taskTtlSuggestionMs: 60_000 },
    outputSchema: vacuityWaiver('exarchos_workflow.rehydrate'),
    annotations: LOCAL_MUTATION_IDEMPOTENT,
  },
  {
    name: 'checkpoint',
    description: 'Create an explicit checkpoint, resetting the operation counter. Persists checkpoint metadata to workflow state and emits workflow.checkpoint event',
    schema: z.object({
      featureId: featureIdSchema,
      summary: z.string().optional(),
      // T5 (#1240): formal `handoff` field on the dispatch surface so the
      // MCP arm validates the same shape `handleCheckpoint` re-validates
      // internally via `CheckpointInputSchema`. Without this, dispatch
      // silently strips `handoff` (registry per-action schemas are
      // non-strict) and an MCP caller passing `handoff` would observe a
      // successful checkpoint with no persisted handoff payload — the
      // CLI would honour the convenience flags while MCP would not,
      // breaking DR-3 surface parity.
      //
      // CodeRabbit nitpick on PR #1297: reuse the canonical
      // `CheckpointHandoffSchema` rather than redefining the shape inline.
      // The handler re-parses against `CheckpointInputSchema` so the
      // strictObject cap is ultimately enforced on a single line of code;
      // composing the canonical schema here keeps schema introspection
      // (`exarchos schema describe wf.checkpoint`) and the auto-gen CLI
      // flag table aligned with the handler's contract.
      handoff: CheckpointHandoffSchema.optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    autoEmits: [
      { event: 'workflow.checkpoint', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_workflow.checkpoint'),
    annotations: LOCAL_MUTATION_IDEMPOTENT,
  },
  {
    // #1319 — agent→runtime friction back-channel (Trevin Principle 10b).
    // Deliberately on `exarchos_workflow` (INV-5d collapses to 4 visible
    // tools) yet NOT feature-scoped: it takes no featureId and lands on the
    // shared `meta/feedback` stream so reports are queryable across every
    // workflow. The handler owns the local write (offline-first, INV-15) and
    // the optional best-effort upstream POST; `/exarchos:dogfood` reads the
    // stream back as triage input.
    name: 'feedback',
    description:
      'File an agent→runtime friction report onto the shared meta/feedback stream (cross-workflow, queryable). Emits feedback.recorded; optionally POSTs upstream when .exarchos.yml sets feedback.upstream. No featureId — feedback is not feature-scoped.',
    schema: z.object({
      message: z.string().min(1).describe('The friction report (required, non-empty).'),
      // ZodObject (not a union) so the CLI flag classifies as `object` and
      // `coerceFlags` JSON-parses `--sessionContext '{...}'` into the same
      // shape the MCP wire receives (governing INV-2 — one registered schema
      // is the contract every client derives from; #1127
      // object-classification).
      sessionContext: z
        .object({
          workflow: z.string().optional(),
          action: z.string().optional(),
          errorCode: z.string().optional(),
        })
        .optional()
        .describe('Optional provenance: the workflow / action / errorCode the agent hit friction in.'),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    cli: {
      flags: { message: { alias: 'm' } },
      examples: [
        'exarchos feedback "rehydrate envelope omitted taskProgress when projection lagged"',
        'exarchos wf feedback -m "check_static_analysis ran in the wrong worktree" --sessionContext \'{"action":"check_static_analysis","errorCode":"GATE_FAILED"}\'',
      ],
    },
    autoEmits: [
      { event: 'feedback.recorded', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_workflow.feedback'),
    annotations: LOCAL_MUTATION,
  },
  makeWorkflowDescribeAction('exarchos_workflow.describe'),
];

// ─── Composite Tool: exarchos_event ─────────────────────────────────────────

const eventActions: readonly BuiltinToolAction[] = [
  {
    name: 'append',
    description: 'Append an event to a stream',
    schema: z.object({
      stream: z.string().min(1),
      event: coercedRecord(),
      expectedSequence: coercedNonnegativeInt().optional(),
      idempotencyKey: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    cli: {
      examples: ['exarchos ev append --stream my-feature --event \'{"type":"task.completed","data":{"taskId":"t1"}}\''],
    },
    outputSchema: vacuityWaiver('exarchos_event.append'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'query',
    description: 'Query events from a stream with optional filtering',
    schema: z.object({
      stream: z.string().min(1),
      filter: coercedRecord().optional(),
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
      fields: coercedStringArray().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_event.query'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'batch_append',
    description: 'Append multiple events to a stream atomically',
    schema: z.object({
      stream: z.string().min(1),
      events: z.array(coercedRecord()),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_event.batch_append'),
    annotations: LOCAL_MUTATION,
  },
  makeEventDescribeAction('exarchos_event.describe'),
];

// ─── Composite Tool: exarchos_orchestrate ───────────────────────────────────

const orchestrateActions: readonly BuiltinToolAction[] = [
  {
    name: 'task_claim',
    description: 'Claim a task for execution',
    schema: z.object({
      taskId: z.string().min(1),
      agentId: z.string().min(1),
      // DR-6: `streamId` IS the bare featureId. Both spellings are accepted
      // and exactly one is required (`resolveStreamIdentity` in
      // `tasks/tools.ts` is the single resolver). Requiring only the
      // internal spelling made agents ASK the operator for a value they
      // already held under the name every workflow surface uses.
      streamId: z.string().min(1).optional(),
      featureId: z.string().min(1).optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_TEAMMATE,
    autoEmits: [
      { event: 'task.claimed', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.task_claim'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'task_complete',
    description: 'Mark a task as complete with optional result and evidence. Auto-emits task.completed event. When evidence is provided, verified=true in event data; otherwise verified=false',
    schema: z.object({
      taskId: z.string().min(1),
      result: coercedRecord().optional(),
      evidence: z.object({
        type: z.enum(['test', 'build', 'typecheck', 'manual']),
        output: z.string(),
        passed: z.boolean(),
      }).optional(),
      // DR-6: `streamId` IS the bare featureId. Both spellings are accepted
      // and exactly one is required (`resolveStreamIdentity` in
      // `tasks/tools.ts` is the single resolver). Requiring only the
      // internal spelling made agents ASK the operator for a value they
      // already held under the name every workflow surface uses.
      streamId: z.string().min(1).optional(),
      featureId: z.string().min(1).optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_TEAMMATE,
    autoEmits: [
      { event: 'task.completed', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.task_complete'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'task_fail',
    description: 'Mark a task as failed with error details. Auto-emits task.failed event',
    schema: z.object({
      taskId: z.string().min(1),
      error: z.string().min(1),
      diagnostics: coercedRecord().optional(),
      // DR-6: `streamId` IS the bare featureId. Both spellings are accepted
      // and exactly one is required (`resolveStreamIdentity` in
      // `tasks/tools.ts` is the single resolver). Requiring only the
      // internal spelling made agents ASK the operator for a value they
      // already held under the name every workflow surface uses.
      streamId: z.string().min(1).optional(),
      featureId: z.string().min(1).optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_TEAMMATE,
    autoEmits: [
      { event: 'task.failed', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.task_fail'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'review_triage',
    description: 'Score PRs by risk and dispatch to CodeRabbit or self-hosted review based on velocity',
    schema: z.object({
      featureId: z.string().min(1),
      prs: z.array(z.object({
        number: z.number().int().positive(),
        paths: z.array(z.string()),
        linesChanged: z.number().int().nonnegative(),
        filesChanged: z.number().int().nonnegative(),
        newFiles: z.number().int().nonnegative(),
      })),
      activeWorkflows: z.array(z.object({ phase: z.string() })).optional(),
      pendingCodeRabbitReviews: z.number().int().nonnegative().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.review_triage'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'prepare_delegation',
    description: 'Query delegation readiness and prepare quality hints for subagent dispatch',
    schema: z.object({
      featureId: z.string().min(1),
      // #1636: the per-task object accepts the planner's verification-routing
      // stamps. Previously `z.object({ id, title })` default-stripped them, so
      // `deriveRiskTier`/`deriveBoundaryTouching`'s "planner value wins" branch
      // was structurally unreachable via MCP and every task fell through to the
      // keyword/glob heuristic. `files`/`blockedBy`/`testLayer` feed the heuristic
      // fallback for UNstamped tasks. Base types match the top-level `riskTier`
      // override to stay clear of the joint-schema collision guard.
      tasks: z.array(z.object({
        id: z.string(),
        title: z.string(),
        riskTier: z.enum(['low', 'medium', 'high']).optional(),
        boundaryTouching: z.boolean().optional(),
        files: z.array(z.string()).optional(),
        blockedBy: z.array(z.string()).optional(),
        testLayer: z.enum(['acceptance', 'integration', 'unit', 'property']).optional(),
      })).optional(),
      // #1636: point at the decomposition markdown to have the per-task stamps
      // lifted automatically (deterministic parse — no LLM). An explicit field on
      // a `tasks[]` entry still wins over the parsed stamp; the parsed stamp wins
      // over the heuristic. Absent, behavior is unchanged.
      planPath: z.string().optional().describe('Decomposition markdown path; lifts per-task **Risk Tier:**/**Boundary Touching:** stamps onto tasks'),
      nativeIsolation: z.boolean().default(false).describe('When true, skip worktree-related blockers (the host platform handles isolation natively)'),
      // DR-2: explicit workflow-level risk-tier override. Absent, prepare_delegation
      // derives state.riskTier as the max-of-tiers over the classified wave; when
      // supplied it WINS over the derived value (the planner has context the
      // heuristic cannot infer).
      riskTier: z.enum(['low', 'medium', 'high']).optional().describe('Explicit workflow risk-tier override; wins over the derived max-of-tiers'),
      // DR-4: the full-prompt escape hatch. `detail:true` (or its alias
      // `outputFormat:'prompt-only'`) inlines the full per-task implementer
      // prompt instead of the deduped template + per-task deltas. Declared on
      // the schema so the hatch is reachable through BOTH facades — Zod would
      // otherwise `.strip()` an undeclared key on the MCP path, and the CLI
      // would emit no flag (review fix: previously the handler honored these but
      // the schema declared neither, so the affordance was dead). `outputFormat`
      // mirrors `agent_spec.outputFormat` exactly to satisfy the registration
      // flattener's field-contract guard (`buildRegistrationSchema`).
      detail: z.boolean().optional().describe('DR-4: inline the full per-task implementer prompt instead of the deduped template + per-task deltas'),
      outputFormat: z.enum(['full', 'prompt-only']).default('full').describe("DR-4: 'prompt-only' is an alias for detail:true; 'full' (default) returns the deduped template + per-task deltas"),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
    autoEmits: [
      { event: 'quality.hint.generated', condition: 'conditional', description: 'When hints exist' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.prepare_delegation'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'prepare_synthesis',
    description: 'Run pre-synthesis checks: tests, typecheck, stack health. Emits events for readiness views and eval flywheel.',
    schema: z.object({
      featureId: z.string().min(1),
    }),
    phases: SYNTHESIS_REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, gateClass: 'prepare-synthesis' },
    // DR-5: invokes `npm run test:run` + typecheck under the hood; seconds
    // to minutes on non-trivial repos.  CLI adapter emits heartbeats.
    longRunning: true,
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.prepare_synthesis'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'assess_stack',
    description: 'Assess PR stack health during synthesize: CI status, reviews, comments. Emits events for the shepherd iteration loop (within synthesize phase) and eval flywheel.',
    schema: z.object({
      featureId: z.string().min(1),
      // DR-3/Task 010 — route `prNumbers` through the coercion layer as an int
      // array (CSV tolerance rides Task 010's coerce.ts helper).
      prNumbers: coercedIntArray(),
      // DR-2 — per-PR comment paging inputs, schema-declared so the CLI flags
      // auto-emit. The capped comments + `page` metadata land in the handler
      // under DR-2 (Task 002 shaping); Task 022 owns only the schema surface.
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
    }),
    phases: SYNTHESIS_REVIEW_PHASES,
    roles: ROLE_LEAD,
    // DR-5: shells out to `gh` across each PR in the stack; latency scales
    // with stack depth + GitHub API round-trip time.
    longRunning: true,
    autoEmits: [
      { event: 'shepherd.started', condition: 'conditional', description: 'First invocation (idempotent)' },
      { event: 'shepherd.approval_requested', condition: 'conditional', description: 'When approval needed' },
      { event: 'shepherd.completed', condition: 'conditional', description: 'When PR merged' },
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.assess_stack'),
    // sentry LOW on PR #1369: `assess_stack` reads GitHub PR state but
    // also emits 3 shepherd lifecycle events + gate.executed on every
    // call. `readOnly: true` would mislead clients that gate on the
    // hint. REMOTE_MUTATION matches the actual write surface; the
    // conditional emission discipline is a handler-level detail and
    // should not be smuggled into the advisory annotation.
    annotations: REMOTE_MUTATION,
  },
  {
    name: 'check_static_analysis',
    description: 'Run static analysis gate (lint + typecheck) and persist canonical subject-bound evidence.',
    schema: z.object({
      featureId: z.string().min(1),
      taskId: z.string().optional(),
      branch: z.string().optional(),
      baseBranch: z.string().optional(),
      repoRoot: z.string().optional(),
      // #1330: the handler threads worktreePath into resolveRepoRoot so
      // `repoRoot: 'auto'` resolves the agent's worktree. The field must be
      // declared here or action-level schema parsing drops it before the
      // handler sees it (the task-completion runbook passes it as a template var).
      worktreePath: z.string().optional(),
      skipLint: z.boolean().optional(),
      skipTypecheck: z.boolean().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, dimension: 'D2', gateClass: 'static-analysis' },
    // DR-5: shells out to `npm run lint` and `npm run typecheck`; on
    // non-trivial repos both exceed the 2s heartbeat threshold.
    longRunning: true,
    // T-01/T-02: routed through `runDurableGateProducer` → `runGate`, the
    // single authoritative producer of `gate.executed` (minted from the SAME
    // persisted `admission.evidence-recorded` record). Both rows are genuinely
    // emitted on every call — declaring only the evidence row here understated
    // the contract `task_complete`'s `hasPassingGate('static-analysis')` reads.
    autoEmits: [
      { event: 'admission.evidence-recorded', condition: 'always' },
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_static_analysis'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_integration_suite',
    description:
      'Run the FULL test suite against the integration tip and fold file-LOAD ' +
      'failures into the failure count (#1329). vitest counts a file that throws ' +
      'at import as "1 failed suite / 0 failed tests" — invisible to per-task ' +
      'gates; this gate makes a load cascade a hard FAIL. Set repoRoot to the ' +
      'integration worktree (or "auto" to resolve the calling delegation\'s ' +
      'worktree). Persists canonical subject-bound evidence. Do NOT use for a single task\'s scoped tests — use ' +
      'check_static_analysis / check_test_adequacy for per-task verification; ' +
      'this gate is the cumulative-regression backstop between merges.',
    schema: z.object({
      featureId: z.string().min(1),
      repoRoot: z.string().optional(),
      worktreePath: z.string().optional(),
      taskId: z.string().optional(),
      branch: z.string().optional(),
      baseBranch: z.string().optional(),
      testScript: z.string().optional(),
    }),
    phases: STACK_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, dimension: 'D2', gateClass: 'integration-suite' },
    // Shells out to `npm run test:run -- --reporter=json` over the entire
    // suite; on a real repo this far exceeds the 2s heartbeat threshold.
    longRunning: true,
    // T-01/T-02: routed through `runDurableGateProducer` → `runGate`, which
    // mints `gate.executed` from the same persisted evidence record it just
    // wrote — both rows are genuinely emitted on every call.
    autoEmits: [
      { event: 'admission.evidence-recorded', condition: 'always' },
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_integration_suite'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_security_scan',
    description: 'Run security pattern scan on diff. Emits gate.executed event with dimension D1.',
    schema: z.object({
      featureId: z.string().min(1),
      diffContent: z.string().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: false, dimension: 'D1' },
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_security_scan'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_context_economy',
    description: 'Check code complexity impacting LLM context consumption. Emits gate.executed event with dimension D3.',
    schema: z.object({
      featureId: z.string().min(1),
      repoRoot: z.string().optional(),
      baseBranch: z.string().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: false, dimension: 'D3' },
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_context_economy'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_operational_resilience',
    description: 'Check for operational anti-patterns (empty catches, swallowed errors, console.log). Emits gate.executed event with dimension D4.',
    schema: z.object({
      featureId: z.string().min(1),
      repoRoot: z.string().optional(),
      baseBranch: z.string().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: false, dimension: 'D4' },
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_operational_resilience'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_workflow_determinism',
    description: 'Check test reliability and determinism (.only/.skip, non-deterministic time/random, debug artifacts). Emits gate.executed event with dimension D5.',
    schema: z.object({
      featureId: z.string().min(1),
      repoRoot: z.string().optional(),
      baseBranch: z.string().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: false, dimension: 'D5' },
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_workflow_determinism'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_review_verdict',
    description: 'Compute review verdict from finding counts. Emits per-dimension and summary gate.executed events. On NEEDS_FIXES, bounds the fix-loop via the shared escalation policy (DR-3): returns escalate:true when the auto-fix bound is hit or a finding is intent-touching.',
    schema: z.object({
      featureId: z.string().min(1),
      high: coercedNonnegativeInt(),
      medium: coercedNonnegativeInt(),
      low: coercedNonnegativeInt(),
      blockedReason: z.string().optional(),
      dimensionResults: z.record(z.string(), z.object({
        passed: z.boolean(),
        findingCount: z.number().int().nonnegative(),
      })).optional(),
      pluginFindings: z.array(z.object({
        source: z.string(),
        severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
        dimension: z.string().optional(),
        file: z.string().optional(),
        line: z.number().int().positive().optional(),
        message: z.string(),
        // DR-3: intent-touching classification for the escalation policy. A
        // spec-category (or explicitly-flagged) finding escalates immediately.
        category: z.string().optional(),
        intentTouching: z.boolean().optional(),
      })).optional(),
      // DR-3: per-loop override of the auto-fix bound (highest precedence over
      // config `escalation.maxIterations` and the built-in default of 5).
      maxFixCycles: coercedPositiveInt().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, gateClass: 'review-verdict' },
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_review_verdict'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_convergence',
    description: 'Query D1-D5 convergence status from gate.executed events. Emits gate.executed event on each invocation. Returns overall pass/fail and per-dimension summary.',
    schema: z.object({
      featureId: z.string().min(1),
      workflowId: z.string().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: false },
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_convergence'),
    // sentry HIGH on PR #1369: although `check_convergence` reads
    // existing gate state, the handler `emitGateEvent`s on every call,
    // so the action is not readOnly — annotating it as such would let
    // readonly-capability clients mutate the event store. LOCAL_MUTATION
    // matches the actual write surface (matches the rest of the check_*
    // family that emits gate.executed).
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_provenance_chain',
    description: 'Verify design requirement traceability (DR-N) from design doc to plan tasks. Emits gate.executed event with dimension D1.',
    schema: z.object({
      featureId: z.string().min(1),
      designPath: z.string().min(1),
      planPath: z.string().min(1),
    }),
    phases: PLAN_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, dimension: 'D1', gateClass: 'provenance-chain' },
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_provenance_chain'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_design_completeness',
    description: 'DEPRECATED (#1581): delegates to check_plan_coverage on the unified docs/specs/ artifact; its acceptance-criteria check folded into plan-coverage. Use check_plan_coverage. Removed in a future minor version.',
    deprecated: true,
    schema: z.object({
      featureId: z.string().min(1),
      stateFile: z.string().optional(),
      designPath: z.string().optional(),
      // Unified-artifact delegation: when design and plan are one docs/specs/
      // file, planPath == designPath. Optional — the handler also resolves the
      // path from workflow-state artifacts.
      planPath: z.string().optional(),
    }),
    // Deprecated alias: callable in the (post-collapse) plan phase. Deliberately
    // NOT the full PLAN_PHASES set — that set marks an action as a canonical
    // plan-structure gate (see the `setEqualsNames(a.phases, PLAN_PHASE_NAMES)`
    // binding pin in phase-kind.test.ts); this alias is being excised from the
    // chains (task 014), so it must not register as a bound plan gate.
    phases: new Set<string>(['plan']),
    roles: ROLE_LEAD,
    gate: { blocking: false, dimension: 'D1' },
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_design_completeness'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_plan_coverage',
    description: 'Verify plan tasks cover all design sections. Emits gate.executed event with dimension D1.',
    schema: z.object({
      featureId: z.string().min(1),
      designPath: z.string().min(1),
      planPath: z.string().min(1),
    }),
    phases: PLAN_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, dimension: 'D1', gateClass: 'plan-coverage' },
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_plan_coverage'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_exploration_depth',
    description:
      'Deep-depth planning gate (DR-4): verifies a `deep`-designDepth spec carries ' +
      'the template-required `### Exploration` section citing the /exarchos:discover ' +
      'research pass by report path + correlationId, failing when the section is ' +
      'absent (or present but not citing the pass). SELF-SKIPS at thin/standard ' +
      'depth — the Exploration citation is a deep-only obligation. Resolves ' +
      'designDepth + the unified docs/specs/ artifact path from explicit args, then ' +
      'from workflow state. Emits a gate.executed event (gate "exploration-depth", ' +
      'layer planning, dimension D1) on every path, including the skip.',
    schema: z.object({
      featureId: z.string().min(1),
      // The unified docs/specs/ artifact. Optional — resolved from workflow-state
      // artifacts (plan preferred, then design) when absent.
      designPath: z.string().optional(),
      // Frozen per-feature designDepth stamp. Optional — resolved from
      // state.designDepth when absent; non-`deep` self-skips.
      designDepth: z.enum(['thin', 'standard', 'deep']).optional(),
      stateFile: z.string().optional(),
    }),
    // Callable in the plan phase, but deliberately NOT the full PLAN_PHASES set:
    // that set is the canonical plan-STRUCTURE binding pinned to the `standard`
    // rung (`setEqualsNames(a.phases, PLAN_PHASE_NAMES)` in phase-kind.test.ts).
    // check_exploration_depth is the DEEP-ONLY obligation the plan-structure
    // resolver appends at `deep` depth — it must stay OUT of the standard-rung
    // binding, so it uses the subset idiom (cf. the check_design_completeness alias).
    phases: new Set<string>(['plan']),
    roles: ROLE_LEAD,
    gate: { blocking: true, dimension: 'D1' },
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_exploration_depth'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_test_adequacy',
    description:
      'Per-task test-adequacy kill probe (mutation-testing-at-N=1): reverts the ' +
      "task's source hunks (keeping tests), re-runs the new/changed tests, and " +
      'asserts at least one goes red — proving the tests are not vacuous. ' +
      'Restores the working tree unconditionally (INV-14) and persists canonical ' +
      'subject-bound evidence. Pass repoRoot ("auto" to resolve the calling ' +
      "delegation's worktree). Stamp riskTier + boundaryTouching (from " +
      'prepare_delegation) to let the gate self-skip when the verification ' +
      'policy excludes it for that tier (skipped-by-policy). This is the sole ' +
      'per-task verification gate: it subsumes the regression-coverage intent of ' +
      'the retired check_tdd_compliance (#1587) — outcome-based test adequacy, ' +
      'test-after, NOT commit-order test-first.',
    schema: z.object({
      featureId: z.string().min(1),
      taskId: z.string().min(1),
      branch: z.string().optional(),
      baseBranch: z.string().optional(),
      repoRoot: z.string().optional(),
      worktreePath: z.string().optional(),
      operationId: z.string().optional(),
      // Legacy phase carrier retained for compatibility. Durable evidence uses
      // the active persisted phaseAttemptId, never caller-supplied provenance.
      phase: z.string().optional(),
      riskTier: z.enum(['low', 'medium', 'high']).optional(),
      boundaryTouching: z.boolean().optional(),
      // .strict() so the dispatch layer rejects unknown keys (e.g. `base`
      // instead of `baseBranch`) rather than silently defaulting — the #1188
      // protection, inherited from the retired check_tdd_compliance (#1587).
      // Tolerant dispatch strips leaked sibling-action defaults BEFORE this
      // per-action validation, so strict never false-rejects a real dispatch.
    }).strict(),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, dimension: 'D1', gateClass: 'test-adequacy' },
    // Reverts source + shells out to the resolved test command; on a real repo
    // this exceeds the 2s heartbeat threshold.
    longRunning: true,
    // T-01/T-02: routed through `runDurableGateProducer` → `runGate`, which
    // mints `gate.executed` from the same persisted evidence record it just
    // wrote — both rows are genuinely emitted on every call.
    autoEmits: [
      { event: 'admission.evidence-recorded', condition: 'always' },
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_test_adequacy'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_contract_drift',
    description:
      'Per-task contract-drift gate (verification-ladder slice 1): regenerates ' +
      'schema bindings (codegen), typechecks the regen, then runs a ' +
      'breaking-change diff against the MERGE-BASE (git merge-base baseBranch ' +
      'HEAD). A drift gate, NOT a write-lock — reports findings, never mutates ' +
      'the tree. Persists canonical subject-bound evidence. Degrades to a ' +
      'skipped/advisory pass when no contract tool resolves ' +
      '(INV-4). Pass repoRoot ("auto" to resolve the calling delegation\'s ' +
      'worktree). On a ' +
      'clean pass, surfaces a one-semantic-test steer in next_actions.',
    // Field names + base types match check_test_adequacy exactly so the shared
    // registration schema (buildRegistrationSchema) never sees a same-name
    // field with a divergent base type.
    schema: z.object({
      featureId: z.string().min(1),
      taskId: z.string().min(1),
      branch: z.string().optional(),
      baseBranch: z.string().optional(),
      repoRoot: z.string().optional(),
      worktreePath: z.string().optional(),
      operationId: z.string().optional(),
      riskTier: z.enum(['low', 'medium', 'high']).optional(),
      boundaryTouching: z.boolean().optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, dimension: 'D1', gateClass: 'contract-drift' },
    // Shells out to codegen/typecheck/breaking-diff against a real repo; on a
    // real project this exceeds the 2s heartbeat threshold.
    longRunning: true,
    // T-01/T-02: routed through `runDurableGateProducer` → `runGate`, which
    // mints `gate.executed` from the same persisted evidence record it just
    // wrote — both rows are genuinely emitted on every call.
    autoEmits: [
      { event: 'admission.evidence-recorded', condition: 'always' },
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_contract_drift'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_mock_boundary',
    description:
      'Per-task mock-boundary gate (verification-ladder slice 1, SIV-4): scans ' +
      "the task's NEW test hunks for mock sites (mock/stub/spy/fake/patch/" +
      'monkeypatch at an identifier boundary) and cross-references each mocked ' +
      'target against the resolved `ownership.firstParty` scope. Mocking a ' +
      'FIRST-PARTY module is low-risk (its contract is visible); mocking an ' +
      'UNOWNED dependency asserts against a fiction — the high-risk pattern. ' +
      'ADVISORY by default (severity resolved via DEFAULTS.review.gates, like ' +
      'tdd-compliance; a project review-gate override still wins). On an unowned ' +
      'finding, surfaces a per-finding steer in next_actions (replace with a ' +
      'hermetic fixture / contract-verified stub / a fake). An explicit `reason` ' +
      'is an escape hatch that passes the gate advisory AND records the ' +
      'acknowledgement in durable evidence. Pass repoRoot ("auto" to resolve ' +
      "the calling delegation's worktree).",
    // Field names + base types match check_test_adequacy / check_contract_drift
    // exactly so the shared registration schema (buildRegistrationSchema) never
    // sees a same-name field with a divergent base type. `reason` reuses the
    // existing optional-string contract (request_synthesize.reason).
    schema: z.object({
      featureId: z.string().min(1),
      taskId: z.string().min(1),
      branch: z.string().optional(),
      baseBranch: z.string().optional(),
      repoRoot: z.string().optional(),
      worktreePath: z.string().optional(),
      operationId: z.string().optional(),
      reason: z.string().optional(),
      riskTier: z.enum(['low', 'medium', 'high']).optional(),
      boundaryTouching: z.boolean().optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
    // Advisory by default — the runtime severity demotion lives in
    // DEFAULTS.review.gates['mock-boundary'] (resolved per-call via
    // resolveGateSeverity). The registry flag mirrors that default so the
    // RunbookDrift blocking-gate coverage check treats it as advisory.
    gate: { blocking: false, dimension: 'D1', gateClass: 'mock-boundary' },
    // T-01/T-02: routed through `runDurableGateProducer` → `runGate`, which
    // mints `gate.executed` from the same persisted evidence record it just
    // wrote — both rows are genuinely emitted on every call.
    autoEmits: [
      { event: 'admission.evidence-recorded', condition: 'always' },
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_mock_boundary'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'mutation-adequacy',
    description:
      'Verification-ladder slice 3 (R5): the mutation-adequacy backstop for the ' +
      'relaxed verification mix. Runs the resolved mutation command DIFF-SCOPED ' +
      'against `base` (Stryker --since / cargo-mutants --in-diff / mutmut path ' +
      'restriction, resolved from the toolchains SoT), parses the Stryker ' +
      'mutation-testing-report-schema, and returns the fixed carrier ' +
      '{passed, mutationScore, killed, survived, noCoverage, total, report}. ' +
      'Surviving + NoCoverage mutants become next_actions ("write a test that ' +
      'kills <file>:<line>"). ADVISORY by default (severity resolved via ' +
      "DEFAULTS.review.gates['mutation-adequacy']; an explicit override can raise " +
      'it to blocking). An unresolved mutation command → Skipped (reason names ' +
      'remediation); a malformed/empty report → Warning (degrade, never throws). ' +
      "scope:'full' runs full-tree only with offline:true (nightly lane); else a " +
      'deferred advisory (no inline run). Emits mutation.executing_started/executed (INV-10) and a foldable ' +
      'gate.executed carrying mutationScore (INV-1); operationId makes the gate ' +
      'emission idempotent (INV-8). Reuse `base` as a string verbatim.',
    // `base` reuses the existing string field contract (request_synthesize.base /
    // assess_stack.base); `scope`/`worktreePath`/`operationId`/`threshold` match
    // their existing declarations' base types so buildRegistrationSchema never
    // sees a same-name field with a divergent contract (field-collision trap).
    // `scope` is a plain string here (matching prepare_review.scope) and is
    // validated to 'diff'|'full' by the handler — declaring it as an enum would
    // collide with prepare_review's z.string().
    schema: z.object({
      featureId: z.string().min(1),
      base: z.string().min(1),
      // `taskId` lets `repoRoot:'auto'` resolve via the task's worktree.created
      // event (the check_test_adequacy contract). Optional here (the review-gate
      // path often passes an explicit repoRoot/worktreePath); matches the
      // existing `taskId: z.string().optional()` declarations so
      // buildRegistrationSchema sees no divergent same-name contract.
      taskId: z.string().optional(),
      worktreePath: z.string().optional(),
      operationId: z.string().optional(),
      threshold: z.number().min(0).max(1).optional(),
      scope: z.string().optional(),
      // DR-6: explicit offline/opt-in for a full-tree run. Inline `/review` never
      // sets it, so `scope:'full'` stays deferred on the inline path.
      offline: z.boolean().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    // Advisory by default — the runtime severity demotion lives in
    // DEFAULTS.review.gates['mutation-adequacy'] (resolved per-call via
    // resolveGateSeverity); the registry flag mirrors that default.
    gate: { blocking: false, dimension: 'mutation-adequacy' },
    // Shells out to a real mutation runner; on a real repo this exceeds the 2s
    // heartbeat threshold.
    longRunning: true,
    autoEmits: [
      { event: 'mutation.executing_started', condition: 'always' },
      { event: 'mutation.executed', condition: 'always' },
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.mutation-adequacy'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_post_merge',
    description: 'Post-merge regression check. Emits gate.executed event with dimension D4.',
    schema: z.object({
      featureId: z.string().min(1),
      prUrl: z.string().min(1),
      mergeSha: z.string().min(1),
    }),
    phases: new Set<string>(['synthesize']),
    roles: ROLE_LEAD,
    gate: { blocking: false, dimension: 'D4' },
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_post_merge'),
    annotations: LOCAL_MUTATION,
  },
  // ─── Merge Orchestrator (DR-MO-1) ─────────────────────────────────────────
  {
    name: 'merge_orchestrate',
    description: 'Top-level merge orchestrator (DR-MO-1): runs preflight, emits merge.preflight, then delegates to the executor on pass; handles abort/dryRun/resume. Use for: merging a task/feature source branch into the integration target with full preflight + compensating recovery from the main worktree. Do NOT use for: a raw provider PR/MR merge (use merge_pr); verifying a directory is a git worktree (use verify_worktree); or requesting synthesis/PR creation on a oneshot workflow (use request_synthesize).',
    schema: z.object({
      featureId: z.string().min(1),
      sourceBranch: z.string().min(1),
      targetBranch: z.string().min(1),
      taskId: z.string().optional(),
      // Required-no-default — matches `merge_pr.strategy` per #1127, gives
      // CLI/MCP user-visible parity (#1109 §2), and keeps operator intent
      // explicit in the event log (DIM-2 / DIM-3).
      strategy: z.enum(['squash', 'rebase', 'merge']),
      dryRun: z.boolean().optional(),
      resume: z.boolean().optional(),
      repoRoot: z.string().optional(),
      // DR-2 single-writer lease guard: the caller-presented merge-lease
      // correlator. When the target integration ref carries an in-flight
      // `worktrees@v1` lease whose holder `operationId` differs from this
      // value AND the holder is not provably dead, the handler fails closed
      // (route through `serialize_merge`). `serialize_merge` threads its own
      // lease `operationId` here so its composed call passes the guard; a
      // crash-resumed caller presents the ORIGINAL claim's `operationId`.
      // Optional string — the SOLE declaration of this field across the
      // registry, so `buildRegistrationSchema` sees no same-name base-type
      // collision. Omitting it preserves today's no-lease behavior.
      leaseOperationId: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    autoEmits: [
      { event: 'merge.preflight', condition: 'always' },
      { event: 'merge.executed', condition: 'conditional', description: 'When preflight passes and execute succeeds' },
      // DR-2 (task 006): recovery emits ONLY the canonical `merge.recovered`.
      // The legacy `merge.rollback` write path is retired (read-tolerant, not
      // emittable) so it is NO LONGER declared here — a `retired` event must not
      // appear in any `autoEmits` (RegistryDrift enforces `autoEmits ⊆ auto`).
      { event: 'merge.recovered', condition: 'conditional', description: 'When execute fails and the INV-14 recovery ladder runs' },
    ],
    // T9 (#1440 Op 2, preview-4 design §4.3): multi-step git merge
    // orchestration (preflight → execute → optional rollback) is the
    // canonical long-running verb and benefits from Tasks-augmented
    // dispatch. Advisory — the binding opt-in gate stays at
    // `dispatch/core/dispatch.ts:927-954`.
    dispatch: { taskSuitable: true, taskTtlSuggestionMs: 60_000 },
    // DR-5 (task 076): `merge-orchestrate` is promoted to a top-level verb from
    // HERE, the registry declaration — not by a hand-written
    // `.command('merge-orchestrate')` in the composition root. Task 023 found
    // that duplicate declaration while seeding G1's allowlist: the verb was
    // declared twice (registry action + composition root), which is the
    // multiply-owned-representation defect DR-5 exists to eliminate, and the
    // guard's kill fixture refuses to exempt it. The DR-7 hoist loop reads this
    // hint and routes the top-level command through `registerActionCommand` —
    // the same schema, handler and exit-code ladder as the `orch
    // merge-orchestrate` subcommand form. The operator-visible surface is
    // UNCHANGED (`exarchos merge-orchestrate …` still works), so no rename stub
    // or deprecation window is spent: this is a change of WHERE the name is
    // declared, not WHETHER the verb exists.
    cli: { topLevel: 'merge-orchestrate' },
    // #1305 T13: merge_orchestrate mutates shared state (the integration
    // branch, the working tree, the event store) from the main worktree with
    // no worktree isolation — the strictest mutating trust tier. The resolver
    // mints fs:write + shell:exec from this posture.
    posture: 'shared-mutating',
    outputSchema: vacuityWaiver('exarchos_orchestrate.merge_orchestrate'),
    annotations: COMPENSABLE_REMOTE,
  },
  {
    name: 'check_task_decomposition',
    description: 'Task decomposition quality check at plan boundary. Emits gate.executed event with dimension D5.',
    schema: z.object({
      featureId: z.string().min(1),
      planPath: z.string().min(1),
    }),
    phases: PLAN_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: false, dimension: 'D5' },
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_task_decomposition'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_event_emissions',
    description: 'Check for expected-but-missing model-emitted events in the current workflow phase. Returns structured hints for missing events.',
    schema: z.object({
      featureId: z.string().min(1),
      workflowId: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_event_emissions'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'extract_task',
    description: 'Extract a task definition from a plan file by task ID',
    schema: z.object({
      planPath: z.string().min(1),
      taskId: z.string().min(1),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.extract_task'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'review_diff',
    description: 'Collect diff statistics for a worktree branch against its base',
    schema: z.object({
      worktreePath: z.string().optional(),
      baseBranch: z.string().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.review_diff'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'verify_worktree',
    description: 'Verify a directory is a valid git worktree',
    schema: z.object({
      cwd: z.string().optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_orchestrate.verify_worktree'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'select_debug_track',
    description: 'Select hotfix or thorough debug track based on urgency and root cause knowledge',
    schema: z.object({
      // INV-1: urgency/rootCauseKnown resolve from the event-store projection
      // when not passed directly; `featureId` enables fileless resolution.
      featureId: z.string().min(1).optional(),
      urgency: z.string().optional(),
      rootCauseKnown: z.union([z.boolean(), z.string()]).optional(),
      stateFile: z.string().optional(),
    }),
    phases: new Set<string>(['investigate']),
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.select_debug_track'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'investigation_timer',
    description: 'Check investigation time budget and recommend continue or escalate',
    schema: z.object({
      // INV-1: investigation.startedAt resolves from the event-store
      // projection when not passed directly; `featureId` enables fileless
      // resolution for MCP-only workflows.
      featureId: z.string().min(1).optional(),
      startedAt: z.string().optional(),
      stateFile: z.string().optional(),
      budgetMinutes: z.number().optional(),
    }),
    phases: new Set<string>(['investigate']),
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.investigation_timer'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'check_coverage_thresholds',
    description: 'Check code coverage metrics against threshold values',
    schema: z.object({
      coverageFile: z.string().min(1),
      lineThreshold: z.number().optional(),
      branchThreshold: z.number().optional(),
      functionThreshold: z.number().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: false, dimension: 'D3' },
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_coverage_thresholds'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'assess_refactor_scope',
    description: 'Assess refactoring scope and recommend polish or overhaul track',
    schema: z.object({
      // INV-1: explore.scopeAssessment.filesAffected resolves from the
      // event-store projection when no explicit `files` list is supplied;
      // `featureId` enables fileless resolution.
      featureId: z.string().min(1).optional(),
      files: z.array(z.string()).optional(),
      stateFile: z.string().optional(),
    }),
    phases: new Set<string>(['explore', 'brief']),
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.assess_refactor_scope'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'check_pr_comments',
    description: 'Check PR for unresolved review comment threads',
    schema: z.object({
      pr: z.number().int().positive(),
      repo: z.string().optional(),
    }),
    phases: SYNTHESIS_REVIEW_PHASES,
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_pr_comments'),
    annotations: READ_ONLY_REMOTE,
  },
  {
    name: 'validate_pr_body',
    description: 'Validate PR body contains required sections (Summary, Changes, Test Plan)',
    schema: z.object({
      pr: z.number().int().positive().optional(),
      bodyFile: z.string().optional(),
      body: z.string().optional(),
      template: z.string().optional(),
      // DR-1 (#1593) task 006: optional — enables the advisory intent-grounding
      // check (reads `artifacts.intent`). Absent → unchanged legacy validation.
      featureId: featureIdSchema.optional(),
    }),
    phases: SYNTHESIS_REVIEW_PHASES,
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.validate_pr_body'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'validate_pr_stack',
    description: 'Validate PR stack ordering and base branch consistency',
    schema: z.object({
      baseBranch: z.string().min(1),
    }),
    phases: new Set<string>(['synthesize']),
    roles: ROLE_LEAD,
    gate: { blocking: true },
    outputSchema: vacuityWaiver('exarchos_orchestrate.validate_pr_stack'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'debug_review_gate',
    description: 'Run debug-track review gate: verify test files exist and pass for changed files',
    schema: z.object({
      repoRoot: z.string().min(1),
      baseBranch: z.string().min(1),
      skipRun: z.boolean().optional(),
    }),
    phases: new Set<string>(['debug-review']),
    roles: ROLE_LEAD,
    gate: { blocking: true },
    outputSchema: vacuityWaiver('exarchos_orchestrate.debug_review_gate'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'extract_fix_tasks',
    description: 'Extract fix tasks from review findings and map to worktrees',
    schema: z.object({
      // featureId OR stateFile — the handler enforces "at least one source"
      // (Zod single-field `.min(1)` can't express the cross-field rule).
      featureId: z.string().min(1).optional(),
      // INV-1: findings + worktrees resolve from the event-store projection;
      // `stateFile` is an optional override for legacy file-based workflows.
      stateFile: z.string().min(1).optional(),
      reviewReport: z.string().optional(),
      repoRoot: z.string().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.extract_fix_tasks'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'classify_review_items',
    description: 'Group ActionItems by file and recommend dispatch strategy (direct/delegate-fixer/delegate-scaffolder) per group (#1159)',
    schema: z.object({
      featureId: z.string().min(1),
      actionItems: z.array(z.record(z.string(), z.unknown())),
    }),
    // Shepherd operates within `synthesize` and invokes classify_review_items
    // after assess_stack; restricting to REVIEW_PHASES would trip phase-guard
    // at runtime (#1161 / Sentry bug prediction).
    phases: SYNTHESIS_REVIEW_PHASES,
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.classify_review_items'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'generate_traceability',
    description: 'Generate a traceability matrix mapping design sections to plan tasks',
    schema: z.object({
      designFile: z.string().min(1),
      planFile: z.string().min(1),
      outputFile: z.string().optional(),
    }),
    phases: PLAN_PHASES,
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.generate_traceability'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'spec_coverage_check',
    description: 'Verify that test files referenced in the plan exist in the repo',
    schema: z.object({
      planFile: z.string().min(1),
      repoRoot: z.string().min(1),
      skipRun: z.boolean().optional(),
      // WFQ-010. Declared here or the parameter cannot reach the handler at all:
      // dispatch forwards only schema-parsed args and Zod strips unknown keys, so
      // an undeclared field left `runPlanSyntaxCheck` unreachable and applied
      // post-implementation semantics in the plan phases this action is bound to.
      // The handler's default stays `post-implementation` for back-compat; plan-time
      // callers pass `coveragePhase: 'plan'` so a declared-but-uncreated test file
      // reads as a forward declaration rather than a failure.
      //
      // NOT named `phase`: `buildRegistrationSchema` flattens field names across
      // every action, and `check_test_adequacy` already declares a free-form
      // `phase: z.string()` legacy workflow-phase carrier. Two different meanings
      // under one name is a hard collision (base types differ, string vs enum) that
      // throws at server construction — and widening this one to `string` to match
      // would trade a schema-level constraint for a prose one, which INV-5a forbids.
      coveragePhase: z.enum(['plan', 'post-implementation']).optional(),
    }),
    phases: PLAN_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: false, dimension: 'D1' },
    outputSchema: vacuityWaiver('exarchos_orchestrate.spec_coverage_check'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'verify_worktree_baseline',
    description: 'Verify a worktree passes baseline tests before task work begins',
    schema: z.object({
      worktreePath: z.string().min(1),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_orchestrate.verify_worktree_baseline'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'setup_worktree',
    description: 'Create a git worktree for a task with branch and baseline verification',
    schema: z.object({
      repoRoot: z.string().min(1),
      taskId: z.string().min(1),
      taskName: z.string().min(1),
      baseBranch: z.string().optional(),
      skipTests: z.boolean().optional(),
      // DR-3 (T-09, #1204): resolution priority is
      //   `branch` > `workflow.tasks[id=taskId].branch` > legacy default.
      // Provide `featureId` to let the composite adapter look up the planned
      // branch from workflow state when `branch` is not supplied.
      branch: z.string().min(1).optional(),
      featureId: z.string().min(1).optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.setup_worktree'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'verify_delegation_saga',
    description: 'Verify delegation event saga completeness (spawned, dispatched, disbanded)',
    schema: z.object({
      featureId: z.string().min(1),
      stateDir: z.string().optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.verify_delegation_saga'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'post_delegation_check',
    description: 'Run post-delegation checks: task completion, test pass, branch existence',
    schema: z.object({
      stateFile: z.string().min(1).optional(),
      featureId: z.string().min(1).optional(),
      repoRoot: z.string().min(1),
      skipTests: z.boolean().optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true },
    // DR-5: chains `npm run test:run` across every task worktree with a
    // 120s per-worktree timeout; scales with the number of tasks.
    longRunning: true,
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.post_delegation_check'),
    annotations: COMPENSABLE_LOCAL,
  },
  {
    name: 'reconcile_state',
    description: 'Reconcile workflow state file against git and filesystem reality',
    schema: z.object({
      stateFile: z.string().min(1).optional(),
      featureId: z.string().min(1).optional(),
      repoRoot: z.string().min(1),
    }),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.reconcile_state'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'pre_synthesis_check',
    description: 'Run pre-synthesis checks: task completion, reviews, tests, and stack health',
    schema: z.object({
      // featureId OR stateFile — the handler enforces "at least one source".
      featureId: z.string().min(1).optional(),
      // INV-1: the event store is the sole source of truth. `stateFile` is an
      // optional override; when omitted the gate materializes state from the
      // event store via `featureId` (MCP-only workflows have no `.state.json`).
      stateFile: z.string().min(1).optional(),
      repoRoot: z.string().optional(),
      skipTests: z.boolean().optional(),
      skipStack: z.boolean().optional(),
      testCommand: z.string().optional(),
    }),
    phases: new Set<string>(['synthesize']),
    roles: ROLE_LEAD,
    gate: { blocking: true },
    // DR-5: runs the full project test suite + typecheck + build + stack
    // assessment; routinely seconds-to-minutes on real repos.
    longRunning: true,
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.pre_synthesis_check'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_coderabbit',
    description: 'Query CodeRabbit review state on GitHub PRs — APPROVED/NONE → pass, else fail',
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      // DR-3/Task 010 — same coerced int-array param as assess_stack's
      // prNumbers so the shared registration flattener sees one contract.
      prNumbers: coercedIntArray(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_coderabbit'),
    annotations: READ_ONLY_REMOTE,
  },
  {
    name: 'check_polish_scope',
    description: 'Check if polish refactor scope has expanded beyond limits (>5 files, >2 modules)',
    schema: z.object({
      repoRoot: z.string(),
      baseBranch: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_polish_scope'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'needs_schema_sync',
    description: 'Detect API file modifications (Endpoints.cs, Models/, Requests/, etc.) requiring schema sync',
    schema: z.object({
      repoRoot: z.string(),
      baseBranch: z.string().optional(),
      diffFile: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_orchestrate.needs_schema_sync'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'verify_doc_links',
    description: 'Check that internal markdown links resolve to existing files',
    schema: z.object({
      docFile: z.string().optional(),
      docsDir: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_orchestrate.verify_doc_links'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'verify_review_triage',
    description: 'Verify review triage routing — check review.routed events against state PRs',
    schema: z.object({
      // featureId OR stateFile — the handler enforces "at least one source".
      featureId: z.string().min(1).optional(),
      // INV-1: PRs resolve from the event-store projection; `review.routed`
      // events are queried directly from the store. Both file inputs are
      // OPTIONAL overrides for legacy file-based workflows.
      stateFile: z.string().min(1).optional(),
      eventStream: z.string().min(1).optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_orchestrate.verify_review_triage'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'check_invariant_conformance',
    description: 'Evaluate invariant conformance as a review dimension (DR-3/DR-4). Projects the effective invariant catalog for (workflow-type, review, touched-files), evaluates check-mode combinator trees against the diff, renders audit-mode prompts for the review subagent, and folds findings into the review verdict by context-resolved severity. Emits gate.executed; read-only otherwise.',
    schema: z.object({
      featureId: z.string().min(1),
      workflowType: z.string().optional(),
      phase: z.string().optional(),
      touchedFiles: z.array(z.string()).optional(),
      diff: z.string().optional(),
      diffContent: z.string().optional(),
      repoRoot: z.string().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    // DR-15 / task 027: this gate BLOCKS on check-mode findings only. Raising
    // INV-13/14/16 to `mode:check` (alongside INV-4) gave the gate deterministic
    // mechanical findings; a blocking-severity check violation (INV-4/14/16)
    // folds to a HIGH → NEEDS_FIXES. The scope to check-mode is STRUCTURAL, not
    // a flag knob: the 11 audit-mode entries render into the review subagent's
    // PROMPT (never a programmatic finding in this handler), and an
    // advisory-severity check finding (INV-13) surfaces as MEDIUM without
    // gating — so declaring `blocking:true` cannot red CI on the unproven
    // audit-mode rules.
    gate: { blocking: true },
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    // DR-4 / task 069: PAID DOWN. This gate governs conformance to the catalog
    // that contains the anti-vacuity invariant, and it used to advertise
    // `EnvelopeSchema(z.unknown())` — total over every payload shape, including
    // the wrong ones. `auditPrompt` is the one field the audit-mode path exists
    // to deliver, so a consumer instructed to act on it needs the contract to
    // guarantee its presence and its name; `auditInvariantIds` is its enumerable
    // checklist. Both are declared REQUIRED, and
    // `architecture/audit-delivery-closure.ts` reddens if either stops being so.
    // Its allowlist entry MOVED to `VACUITY_RETIRED` — a shrink, which leaves the
    // pinned seed digest unchanged.
    outputSchema: withCappedShape(CheckInvariantConformanceOutputSchema),
    // The gate reads the catalog and computes a verdict, but `emitGateEvent`s
    // on every call — so it is NOT readOnly. Annotating it read-only would let
    // readonly-capability clients mutate the event store. LOCAL_MUTATION
    // matches the actual write surface and the rest of the check_* family that
    // auto-emits gate.executed (see check_convergence / check_review_verdict);
    // the `RegistryDrift_AutoEmitsImpliesNotReadOnly` invariant enforces this.
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'prepare_review',
    description: 'Prepare a review pass as structured data. Default scope serves the back-of-pipeline code-review check catalog. scope:"plan" serves the DR-10 front-of-pipeline plan-review provisioning — a dispatched, fresh-context, adversarial (refute-the-plan) read-only pass over the unified docs/specs/ artifact, provisioned with only {artifact, spec} (never the authoring transcript) and depth-scaled by the frozen designDepth.',
    schema: z.object({
      featureId: z.string().min(1),
      scope: z.string().optional(),
      dimensions: z.array(z.string()).optional(),
      repoRoot: z.string().optional(),
      // DR-10 (plan-review scope) — the unified artifact under review, the
      // spec it must satisfy, and the frozen planning depth (scales the
      // adversarial rung; the second consumer of designDepth).
      artifact: z.string().optional(),
      spec: z.string().optional(),
      designDepth: z.enum(['thin', 'standard', 'deep']).optional(),
    }),
    phases: PREPARE_REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: false },
    outputSchema: vacuityWaiver('exarchos_orchestrate.prepare_review'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'discover_bridge',
    description: 'Opt-in deep-rung escalation (DR-7): bridge the unified spec to a /exarchos:discover research pre-pass, stitched by a deterministic correlationId. Requires author confirmation (confirm:true) — never auto-spawns. On confirmation it records the link as a state.patched event on the feature stream (report path + discover stream id + correlationId) so provenance spans both documents.',
    schema: z.object({
      featureId: featureIdSchema,
      artifact: z.string().min(1),
      confirm: z.boolean().optional(),
      reportPath: z.string().optional(),
      discoverFeatureId: z.string().optional(),
      correlationId: z.string().optional(),
    }),
    // The deep-rung authoring affordance fires during PLAN authoring. A single
    // 'plan' phase — deliberately NOT the full PLAN_PHASES set (the task-013
    // canonical-plan-gate binding trap).
    phases: new Set<string>(['plan']),
    roles: ROLE_LEAD,
    gate: { blocking: false },
    autoEmits: [
      { event: 'state.patched', condition: 'conditional', description: 'On confirm:true — records the discover-bridge link, stitched by correlationId' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.discover_bridge'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'prune_stale_workflows',
    description: 'Find stale non-terminal workflows and cancel them. Defaults to dry-run; pass dryRun:false to actually prune. Auto-emits workflow.pruned event per pruned workflow.',
    // `thresholdMinutes` was removed in the debloat wave (DR-9): per-phase
    // staleness has lived exclusively in `topology.yaml` `staleness` blocks
    // since #1334 (v2.10.0-preview.1), so the field was accepted-but-ignored.
    // Dropping it here also drops the auto-emitted `--threshold-minutes` CLI
    // flag.
    //
    // The rejection lives HERE, on the real dispatch/CLI seam — NOT in the
    // handler. A plain `z.object` SILENTLY STRIPS unknown keys before any
    // refinement runs, so a legacy `thresholdMinutes` would be
    // accepted-then-ignored (`dispatch()` forwards the stripped `parsed.data`
    // and the handler never sees the key). `.passthrough()` keeps the extra key
    // VISIBLE to the `.superRefine` below, which emits an ACTIONABLE removal
    // issue (naming DR-9, #1334, and `topology.yaml`) — the actionable message
    // WINS because passthrough never emits a competing generic
    // `unrecognized_keys` for it. Genuinely-unknown keys (caller typos) are
    // still rejected, preserving the per-action typo guard. `.shape` is retained
    // (verified), so `buildRegistrationSchema` and the tolerant-dispatch
    // sibling-key stripping (core/dispatch.ts) are undisturbed.
    schema: z
      .object({
        dryRun: z.boolean().optional(),
        force: z.boolean().optional(),
        includeOneShot: z.boolean().optional(),
      })
      .passthrough()
      .superRefine((val, ctx) => {
        for (const key of Object.keys(val)) {
          if (REMOVED_PRUNE_ACTION_KNOBS.has(key)) {
            ctx.addIssue({ code: 'custom', path: [key], message: removedPruneKnobMessage(key) });
          } else if (!PRUNE_ACTION_KNOWN_KEYS.has(key)) {
            ctx.addIssue({ code: 'custom', path: [key], message: unrecognizedPruneKeyMessage(key) });
          }
        }
      }),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    autoEmits: [
      { event: 'workflow.pruned', condition: 'conditional', description: 'Per pruned workflow when dryRun is false' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.prune_stale_workflows'),
    annotations: COMPENSABLE_LOCAL,
  },
  {
    name: 'request_synthesize',
    description: 'Opt-in event for oneshot workflows with synthesisPolicy:on-request. Appending a synthesize.requested event flips the choice-state guard so finalize_oneshot routes to the synthesize phase. Auto-emits synthesize.requested.',
    schema: z.object({
      featureId: featureIdSchema,
      reason: z.string().optional(),
    }),
    // Allowed from `plan` as well as `implementing`: the synthesisOptedIn
    // guard only fires at the `implementing → ?` choice-state boundary, so
    // emitting the event earlier is idempotent — it sits in the event stream
    // until finalize_oneshot reads it. Restricting to `implementing` broke
    // the "I know I'll want a PR" signal during planning.
    phases: new Set<string>(['plan', 'implementing']),
    roles: ROLE_LEAD,
    autoEmits: [
      { event: 'synthesize.requested', condition: 'always' },
    ],
    // T9 (#1440 Op 2, preview-4 design §4.3): the registry-canonical
    // name for the design's "synthesize" verb — PR creation flow flipped
    // by emitting `synthesize.requested` to the choice-state guard.
    // The synthesize phase itself is multi-step (branch staging, PR open,
    // CI wait) so the verb that gates it benefits from Tasks-augmented
    // dispatch. Advisory — the binding opt-in gate stays at
    // `dispatch/core/dispatch.ts:927-954`.
    dispatch: { taskSuitable: true, taskTtlSuggestionMs: 60_000 },
    outputSchema: vacuityWaiver('exarchos_orchestrate.request_synthesize'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'finalize_oneshot',
    description: 'Resolve the oneshot choice-state at the end of implementing: transitions to synthesize (PR path) or completed (direct-commit path) based on the synthesisOptedIn / synthesisOptedOut guards. The transition itself is emitted by the workflow set handler.',
    schema: z.object({
      featureId: featureIdSchema,
    }),
    phases: new Set<string>(['implementing']),
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.finalize_oneshot'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'runbook',
    description: 'List available runbooks or get a resolved runbook with schemas',
    schema: z.object({
      phase: z.string().optional(),
      id: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    // DR-1: verbose-by-design detail path — a resolved runbook with step schemas.
    economy: { budgetTokens: RUNBOOK_ECONOMY_BUDGET_TOKENS },
    outputSchema: vacuityWaiver('exarchos_orchestrate.runbook'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'agent_spec',
    description: 'Retrieve agent specification for subagent dispatch',
    schema: agentSpecSchemaForRegistry,
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_orchestrate.agent_spec'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'doctor',
    description: 'Run exarchos environment diagnostics — 12 checks across runtime, storage, VCS, agent config, plugin, env, and remote surfaces. Read-only by default; emits diagnostic.executed on completion. Pass --fix to repair reconcilable drift through the shared onboarding reconciler (the same apply onboard uses) — under --fix it emits onboard.requested then onboard.executed with trigger doctor-fix (NOT diagnostic.executed) and re-runs the checks to report residuals. Do not use --fix for a read-only diagnosis; omit it.',
    schema: z.object({
      timeoutMs: z.number().int().positive().optional(),
      format: z.enum(['table', 'json']).optional(),
      // DR-4: repair reconcilable drift through the shared reconciler. The CLI
      // `--fix` flag auto-emits from this schema via `addFlagsFromSchema`.
      fix: z.boolean().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    autoEmits: [
      { event: 'diagnostic.executed', condition: 'conditional', description: 'On the read-only path (no --fix)' },
      { event: 'onboard.requested', condition: 'conditional', description: 'Under --fix (shared reconciler intent)' },
      { event: 'onboard.executed', condition: 'conditional', description: 'Under --fix (shared reconciler result)' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.doctor'),
    // sentry HIGH on PR #1369: `doctor` emits `diagnostic.executed` on
    // every invocation (see `autoEmits` above and
    // `verbs/doctor/index.ts:204`). The advisory annotation must
    // match the actual write surface — `readOnly: true` would let a
    // readonly-capability client trigger event-store writes and bypass
    // the audit boundary.
    annotations: LOCAL_MUTATION,
  },
  // ─── VCS Actions ──────────────────────────────────────────────────────────
  {
    name: 'create_pr',
    description: 'Create a pull/merge request via the VCS provider abstraction. Auto-emits pr.created event.',
    schema: z.object({
      title: z.string().min(1),
      body: z.string().min(1),
      base: z.string().min(1),
      head: z.string().min(1),
      draft: z.boolean().optional(),
      labels: z.array(z.string()).optional(),
      // DR-1 (#1593) task 006: optional — grounds the PR body in
      // `artifacts.intent` (a deterministic `## Intent` section). Absent /
      // unreadable / empty intent → the body is left untouched.
      featureId: featureIdSchema.optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    autoEmits: [
      { event: 'pr.created', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.create_pr'),
    annotations: COMPENSABLE_REMOTE,
  },
  {
    name: 'merge_pr',
    description: 'Merge a pull/merge request via the VCS provider abstraction. Auto-emits pr.merged event on success.',
    schema: z.object({
      prId: z.string().min(1),
      strategy: z.enum(['squash', 'rebase', 'merge']),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    autoEmits: [
      { event: 'pr.merged', condition: 'conditional', description: 'When merge succeeds' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.merge_pr'),
    annotations: COMPENSABLE_REMOTE,
  },
  {
    name: 'check_ci',
    description: 'Check CI status for a pull/merge request via the VCS provider abstraction. Read-only, no events emitted.',
    schema: z.object({
      prId: z.string().min(1),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_ci'),
    annotations: READ_ONLY_REMOTE,
  },
  {
    name: 'list_prs',
    description: 'List pull/merge requests via the VCS provider abstraction. Read-only, no events emitted.',
    schema: z.object({
      state: z.enum(['open', 'closed', 'merged', 'all']).optional(),
      head: z.string().optional(),
      base: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_orchestrate.list_prs'),
    annotations: READ_ONLY_REMOTE,
  },
  {
    name: 'get_pr_comments',
    description: 'Get comments on a pull/merge request via the VCS provider abstraction. Read-only, no events emitted.',
    schema: z.object({
      prId: z.string().min(1),
      // DR-3 — window + projection inputs, schema-declared so the CLI flags
      // auto-emit via schema-to-flags. The default newest-window + `page`
      // metadata + `fields` projection land in the handler under Task 006;
      // Task 022 owns only the schema surface here.
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
      fields: coercedStringArray().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_orchestrate.get_pr_comments'),
    annotations: READ_ONLY_REMOTE,
  },
  {
    name: 'add_pr_comment',
    description: 'Add a comment to a pull/merge request via the VCS provider abstraction. Pass threadId to reply into an existing review-comment thread (provider-agnostic addReply) instead of posting a PR-level comment. Auto-emits pr.commented event.',
    schema: z.object({
      prId: z.string().min(1),
      body: z.string().min(1),
      threadId: z.string().min(1).optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    autoEmits: [
      { event: 'pr.commented', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.add_pr_comment'),
    annotations: COMPENSABLE_REMOTE,
  },
  {
    name: 'create_issue',
    description: 'Create an issue via the VCS provider abstraction. Auto-emits issue.created event.',
    schema: z.object({
      title: z.string().min(1),
      body: z.string().min(1),
      labels: z.array(z.string()).optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    autoEmits: [
      { event: 'issue.created', condition: 'always' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.create_issue'),
    annotations: COMPENSABLE_REMOTE,
  },
  // ─── Onboard Action (DR-2/DR-5, task 011) ─────────────────────────────────
  {
    // DR-2: `onboard` is the consolidated first-run verb — it composes the
    // reconciler's detect→config→generate→install→verify pipeline (the
    // superset of the legacy `init` + `install-skills` writes) and drives the
    // repo to a green doctor. Registered as an ACTION on exarchos_orchestrate
    // (INV-5d — NOT a fifth visible tool; the visible-tool count stays 4).
    //
    // Flags auto-emit from this schema via `addFlagsFromSchema` in the CLI
    // adapter, so CLI/MCP arg parity is preserved by construction (INV-2) and
    // there is no hand-written flag table to drift. The schema MIRRORS
    // `HandleOnboardArgs` (verbs/onboard/index.ts) MINUS `surface`:
    // `surface` is adapter-injected (DR-6) — the MCP adapter supplies its
    // capability surface, the CLI passes `'cli'` — so it must NOT appear here
    // as a user-facing flag.
    name: 'onboard',
    description:
      'Onboard (or re-onboard) the current repo: detect runtimes + VCS, write/reconcile agent config, install skills, then verify against doctor — driving the repo to a green doctor. Idempotent; re-running reconciles drift only. Use --dry-run to preview the plan without writing, --new <name> to scaffold a fresh project first, --force to overwrite hand-edited config, and --no-hooks to skip the SessionStart binding. Do not use to re-run individual diagnostics — use doctor for that. Emits onboard.requested then onboard.executed (skipped under --dry-run).',
    schema: z.object({
      // DR-3 greenfield: scaffold `<name>` then run the identical pipeline.
      new: z.string().optional(),
      // Explicit agent-host runtime ids — bypasses probing. Array (one per
      // runtime); the CLI coerces csv/json into the array before parse.
      runtime: z.array(z.string()).optional(),
      // Explicit VCS id — bypasses `.git` probing.
      vcs: z.string().optional(),
      // Compute the plan but perform NO side effect and emit NO events.
      dryRun: z.boolean().optional(),
      // Overwrite hand-edited config (DR-10) — preserves it otherwise.
      force: z.boolean().optional(),
      // Skip the DR-8 SessionStart hook step (#1485).
      noHooks: z.boolean().optional(),
      // Output projection hint (the carrier is shape-stable across both).
      format: z.enum(['table', 'json']).optional(),
      // NOTE: `surface` is intentionally absent — it is adapter-injected (DR-6),
      // not a user flag. Adding it here would auto-emit a spurious `--surface`
      // CLI flag and let a caller spoof the capability gate.
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    autoEmits: [
      { event: 'onboard.requested', condition: 'always' },
      { event: 'onboard.executed', condition: 'conditional', description: 'On a non-dry-run that applies the plan' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.onboard'),
    annotations: LOCAL_MUTATION,
  },
  // ─── Init Action ──────────────────────────────────────────────────────────
  // init action removed in Task 011 (onboard swap); the init handler
  // (`handleInitWithWriters`), `init.executed` event, and `install-skills` verb
  // were fully removed in DR-5 (task 018). The `onboard` action above supersedes
  // init (design line 322: "init action → onboard action") — it reuses the same
  // writer list (`getAllWriters()`) via the reconciler's GENERATE step. Removing
  // the action also cleared the #1127 flattener collision between init's legacy
  // `runtime: string` and onboard's `runtime: string[]` in
  // `buildRegistrationSchema`. The `init`/`install-skills` CLI verbs are now
  // DR-5 rename stubs (adapters/cli.ts).
  // ─── Invariant Authoring Actions (invariants-catalog-wizard, P2) ───────────
  {
    // P2/T7: create a starter invariant catalog file for a tier and
    // idempotently register it in `.exarchos.yml`. INV-5d: this is an ACTION on
    // exarchos_orchestrate, NOT a fifth visible tool. Never overwrites an
    // existing file (mirrors seedExarchosConfig).
    name: 'invariants_scaffold',
    description:
      'Create a starter invariant catalog file for a tier (dev | user) and idempotently register it in .exarchos.yml. Emits no events; never overwrites an existing catalog file. Do not use when the catalog file already exists, or to add an entry to an existing catalog — use invariants_add for that. After scaffolding, run doctor and inspect the resolved catalog via the invariants_effective view.',
    schema: z.object({
      tier: z.enum(['dev', 'user']).optional(),
      path: z.string().optional(),
      repoRoot: z.string().optional(),
      // #1489: `dev`/`INV-N` is exarchos's reserved substrate namespace. Outside
      // the exarchos repo, tier:dev is rejected unless this override is set.
      allowReservedTier: z.boolean().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_orchestrate.invariants_scaffold'),
    annotations: LOCAL_MUTATION,
  },
  {
    // P2/T11: validate one entry against InvariantEntryV3Schema (incl. the
    // .strict() enforcement DSL) and append it to a registered catalog.
    // `dryRun` defaults true (INV-5c): the dry run returns the rendered entry +
    // a file diff and writes nothing. On commit it auto-assigns the next free
    // id in the target namespace and emits invariant.authored (+ catalog.registered
    // on first registration). INV-5d: ACTION, not a fifth visible tool.
    name: 'invariants_add',
    description:
      'Validate one invariant entry against the v3 schema (including the sandbox-safe .strict() enforcement DSL) and append it to a registered catalog. Defaults to dryRun:true — returns the rendered YAML entry + a file diff without writing; pass dryRun:false to commit (auto-assigns the next free id, emits invariant.authored). Do not use to create a new catalog file — use invariants_scaffold first. Do not embed script/exec/code in enforcement; the DSL is declarative-only and rejects executable escape hatches. After committing, run doctor and inspect the result via the invariants_effective view.',
    schema: z.object({
      entry: z.record(z.string(), z.unknown()),
      catalog: z.string().optional(),
      tier: z.enum(['dev', 'user']).optional(),
      id: z.string().optional(),
      // INV-5c: this mutating verb defaults to dry-run. The default lives in
      // the handler/dispatch boundary (composite.ts: `dryRun === undefined ?
      // true`) rather than as a Zod `.default(true)` here, because the
      // MCP-registration flattener (`buildRegistrationSchema`) forbids two
      // actions declaring the same field with divergent defaults — and
      // `merge_orchestrate` / `prune_stale_workflows` already declare
      // `dryRun` as `.optional()` with no default. Keeping the field
      // `.optional()` here aligns the registration contract; the safe
      // dry-run default is enforced where the value is actually consumed.
      dryRun: z.boolean().optional(),
      repoRoot: z.string().optional(),
      // #1489: `dev`/`INV-N` is exarchos's reserved substrate namespace. Outside
      // the exarchos repo, tier:dev is rejected unless this override is set.
      allowReservedTier: z.boolean().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    autoEmits: [
      { event: 'invariant.authored', condition: 'conditional', description: 'On commit (dryRun:false)' },
      { event: 'catalog.registered', condition: 'conditional', description: 'On first registration of the target catalog' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.invariants_add'),
    annotations: LOCAL_MUTATION,
  },
  {
    // Task 068 / DR-23: the catalog had no sanctioned amend path. `invariants_add`
    // is append-only and the `/exarchos:invariants` skill forbids hand-writing
    // catalog YAML, so entries were effectively IMMUTABLE once committed —
    // every correction to a shipped invariant was unreachable.
    //
    // This verb is id-targeted and field-scoped: `id` names an existing entry
    // (identity is NOT patchable), `patch` names the top-level fields to
    // replace, and every field the patch omits survives verbatim. Amending is
    // not re-scaffolding. `dryRun` defaults true (INV-5c); a commit emits
    // `invariant.amended`. INV-5d: ACTION, not a fifth visible tool.
    //
    // Field-name contract (`buildRegistrationSchema`): `id` / `catalog` /
    // `tier` / `dryRun` / `repoRoot` / `allowReservedTier` reuse the exact base
    // types `invariants_add` already declares. The patch field is named `patch`
    // rather than the more obvious `fields` BECAUSE `fields` is already
    // declared on this tool as `coercedStringArray()` (an array) — a record
    // there would be a base-type collision and would throw at registration.
    name: 'invariants_amend',
    description:
      "Amend one EXISTING invariant entry in a registered catalog, in place. `id` names the entry to correct and is not itself patchable; `patch` names the top-level fields to replace, and any field the patch omits is carried through unchanged. The merged entry is re-validated against the full v3 schema (including the sandbox-safe .strict() enforcement DSL). Defaults to dryRun:true — returns the amended YAML entry + a before/after diff without writing; pass dryRun:false to commit (emits invariant.amended). Use this, NOT invariants_add, to correct a shipped invariant: invariants_add only appends, and re-using an existing id there is rejected. Do not hand-edit catalog YAML. After committing, run doctor and inspect the result via the invariants_effective view.",
    schema: z.object({
      id: z.string(),
      patch: z.record(z.string(), z.unknown()),
      catalog: z.string().optional(),
      tier: z.enum(['dev', 'user']).optional(),
      // INV-5c: dry-run default lives at the handler/dispatch boundary, not as
      // a Zod `.default(true)` — see the note on `invariants_add.dryRun`.
      dryRun: z.boolean().optional(),
      repoRoot: z.string().optional(),
      allowReservedTier: z.boolean().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    autoEmits: [
      { event: 'invariant.amended', condition: 'conditional', description: 'On commit (dryRun:false)' },
    ],
    // DR-4: declared SUBSTANTIVELY via the sole substantive constructor. A new
    // action has no seeded `vacuityWaiver` entry, and the waiver allowlist is
    // shrink-only — acquiring one would be a ratchet violation, so the shape is
    // stated instead. (`vacuityWaiver`'s `id` is typed as the literal union of
    // seeded ids, so this is enforced at compile time, not by convention.)
    outputSchema: withCappedShape(AmendInvariantOutputSchema),
    annotations: LOCAL_MUTATION,
  },
  // ─── Worktree-lifecycle Actions (WLM foundation, task 008) ────────────────
  // INV-5d: ACTIONS on exarchos_orchestrate, NOT a fifth visible tool. Each
  // delegates to the in-process `WorktreeManager` facade (INV-2 — adapters
  // carry zero behavior). `worktrees` (the read) rides exarchos_view.
  {
    name: 'acquire_worktree',
    surface: 'worktree',
    description:
      'Acquire a worktree for the live process: adopt-then-reserve composite. Adopts every on-disk worktree under repoRoot first (the adopt-gate), then reserves worktreeId for the caller. Idempotent. Auto-emits worktree.adopted (per newly tracked worktree) and worktree.reserved. Use for: claiming a worktree for the current process before it does isolated work. Do NOT use for: reading the governed set (use worktrees); freeing a claim (use release_worktree).',
    schema: z
      .object({
        repoRoot: z.string().min(1),
        worktreeId: z.string().min(1),
        path: z.string().min(1).optional(),
        featureId: featureIdSchema.optional(),
        // All-or-nothing: a (pid, startedAt) tuple must describe ONE real
        // process. Both explicit, or neither (then both are derived from the
        // current process). A partial override is rejected by the refine below
        // AND by the handler — keeping the schema and resolveOwner in sync. In
        // Zod v4 `.refine()` keeps the value a ZodObject, so `.shape` still
        // drives buildRegistrationSchema / addFlagsFromSchema.
        ownerPid: z.number().int().positive().optional(),
        ownerStartedAt: z.string().min(1).optional(),
      })
      .refine(
        (v) => (v.ownerPid === undefined) === (v.ownerStartedAt === undefined),
        {
          message:
            'ownerPid and ownerStartedAt must be provided together (both or neither)',
        },
      ),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    autoEmits: [
      { event: 'worktree.adopted', condition: 'conditional', description: 'Per on-disk worktree not yet tracked' },
      { event: 'worktree.reserved', condition: 'always' },
    ],
    outputSchema: withCappedShape(AcquireWorktreeOutputSchema),
    annotations: LOCAL_MUTATION_IDEMPOTENT,
  },
  {
    name: 'release_worktree',
    surface: 'worktree',
    description:
      "Release the caller's worktree reservation. Appends worktree.released for worktreeId; a no-op when nothing is held (idempotent). Auto-emits worktree.released. Use for: freeing a worktree the current process reserved once its isolated work is done. Do NOT use for: freeing another live owner's claim (refused — reaping a dead owner is ps probe:true / reconcile's job); deleting the worktree from disk (use prune_worktrees).",
    schema: z.object({
      worktreeId: z.string().min(1),
    }),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    autoEmits: [
      { event: 'worktree.released', condition: 'always' },
    ],
    outputSchema: withCappedShape(ReleaseWorktreeOutputSchema),
    annotations: LOCAL_MUTATION_IDEMPOTENT,
  },
  {
    name: 'prune_worktrees',
    surface: 'worktree',
    description:
      'Garbage-collect governed worktrees through the fail-closed safety ladder. Defaults to dry-run (report candidates + reclaimable bytes + grouped skip reasons, delete nothing); pass dryRun:false to apply. Orphan deletion needs pruneOrphans:true + yes:true on an apply run. Auto-emits worktree.remove.requested then worktree.remove.executed per deleted worktree. Use for: reclaiming released/orphan governed worktrees + their branches from the main worktree. Do NOT use for: freeing a live reservation (use release_worktree); listing the governed set (use worktrees).',
    schema: z.object({
      repoRoot: z.string().min(1),
      // INV-5c: dry-run is the safe default. The default is enforced in the
      // handler (dryRun === false ⇒ apply) — NOT a Zod `.default()` — because
      // the MCP-registration flattener forbids divergent defaults across the
      // shared `dryRun` field (merge_orchestrate / prune_stale_workflows
      // already declare it `.optional()` with no default).
      dryRun: z.boolean().optional(),
      pruneOrphans: z.boolean().optional(),
      yes: z.boolean().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    autoEmits: [
      { event: 'worktree.remove.requested', condition: 'conditional', description: 'Per delete-eligible candidate on an apply run' },
      { event: 'worktree.remove.executed', condition: 'conditional', description: 'After each git worktree remove succeeds' },
    ],
    // prune_worktrees → compensable + destructive (the two-event delete split
    // is the compensating recovery seam) AND idempotent (a re-run re-classifies
    // and deletes only what is still eligible). No preset carries this exact
    // tuple, so it is declared inline; the `superRefine` constraint
    // (destructive ⇒ compensable) is satisfied.
    // DR-4 / INV-11: garbage-collects governed worktrees + their branches —
    // shared, un-isolated state destroyed from the main worktree, the strictest
    // mutating trust tier. Mirrors merge_orchestrate / serialize_merge so the
    // resolver gate rejects a task-isolated or read-only caller BEFORE the
    // destructive prune runs.
    posture: 'shared-mutating',
    outputSchema: withCappedShape(PruneWorktreesOutputSchema),
    annotations: {
      safety: 'compensable',
      readOnly: false,
      destructive: true,
      idempotent: true,
      openWorld: false,
    },
  },
  // ─── Integration-branch merge serializer (WLM operational core, DR-7) ──────
  // INV-5d: an ACTION on exarchos_orchestrate, NOT a fifth visible tool. An
  // OPTIMISTIC LEASE over `integrationRef` — the right to merge `sourceBranch`
  // into `integrationRef` lives in the event log (the
  // worktree.merge_requested / worktree.merge_executed pair on the singleton
  // `worktrees` stream), enforcing at most one in-flight merge per integration
  // ref. It then composes `merge_orchestrate` UNCHANGED for the git work. No
  // flock / PID file / advisory-lock library — the lease IS the serialization.
  {
    name: 'serialize_merge',
    surface: 'worktree',
    description:
      'Serialize an integration-branch merge behind an optimistic per-integrationRef lease, then compose merge_orchestrate UNCHANGED. DEFAULTS TO DRY-RUN (INV-5c): omitting dryRun (or dryRun:true) claims NO lease, runs NO merge, and returns the planned effect (integration head + merge params); pass dryRun:false to actually claim the lease and execute. Grants at most one in-flight merge per integrationRef: a held slot bounded-waits (re-folding worktrees@v1) and reclaims a provably-dead holder inline, or returns a structured merge-slot-timeout. Auto-emits worktree.merge_requested (claim) then worktree.merge_executed (release) ONLY on an apply run. Use for: landing a source branch onto a shared integration ref under cross-process serialization. Do NOT use for: a single unsynchronized merge (use merge_orchestrate); a raw provider PR merge (use merge_pr).',
    schema: z.object({
      featureId: z.string().min(1),
      integrationRef: z.string().min(1),
      sourceBranch: z.string().min(1),
      strategy: z.enum(['squash', 'rebase', 'merge']),
      taskId: z.string().optional(),
      repoRoot: z.string().optional(),
      // Bounded-wait budget before merge-slot-timeout. Same base type
      // (ZodNumber) as `doctor.timeoutMs` so the MCP-registration flattener
      // does not see a divergent shape for the shared `timeoutMs` field name.
      timeoutMs: z.number().int().positive().optional(),
      // INV-5c safe default: dry-run unless the caller EXPLICITLY opts out with
      // dryRun:false. Declared `.optional()` with NO Zod `.default()` because the
      // MCP-registration flattener forbids divergent defaults across the shared
      // `dryRun` field (prune_worktrees / merge_orchestrate / prune_stale_workflows
      // all declare it `.optional()` with no default); the default is applied in
      // handleSerializeMerge instead.
      dryRun: z.boolean().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    // Descriptive only (NOT the control point — the handler applies the dry-run
    // default). On the default dry-run NOTHING is emitted; both lease events fire
    // only on an apply run (dryRun:false).
    autoEmits: [
      { event: 'worktree.merge_requested', condition: 'conditional', description: 'The lease CLAIM (single-writer per integrationRef) — apply run only (dryRun:false)' },
      { event: 'worktree.merge_executed', condition: 'conditional', description: 'The lease RELEASE (plain keyed append) — apply run only (dryRun:false)' },
    ],
    // Multi-step serialized merge (wait → claim → compose merge_orchestrate →
    // release) is the canonical long-running verb — advisory Tasks-augmented
    // dispatch, mirroring merge_orchestrate.
    dispatch: { taskSuitable: true, taskTtlSuggestionMs: 60_000 },
    // Mutates shared state (the integration branch + working tree, via the
    // composed merge_orchestrate) from the main worktree — the strictest
    // mutating trust tier. Mirrors merge_orchestrate so the resolver mints the
    // same fs:write + shell:exec capabilities.
    posture: 'shared-mutating',
    outputSchema: withCappedShape(SerializeMergeOutputSchema),
    annotations: COMPENSABLE_REMOTE,
  },
  // ─── Cutover promotion path (#1739) ───────────────────────────────────────
  // The two verbs that consult the six-condition cutover gate over ONE local
  // store's durable shadow substrate (`workflow/admission/cutover-gate.ts` +
  // `evidence-reader.ts`). INV-5d: actions on exarchos_orchestrate, not a new
  // visible tool.
  {
    name: 'cutover_readiness',
    description:
      'Assess the six-condition cutover gate against this store: fold every <featureId>/admission-shadow sidecar stream (admission.shadow-attempt + admission.disagreement-disposition) plus the live shadow sink and observer health, and return the full CutoverGateReport with every unmet condition named individually. Read-only — appends nothing, writes nothing. An empty store yields NO evidence (unmet conditions), never clean evidence. Use for: checking how far the store is from flipping enforcement off the legacy HSM guard path. Do NOT use for: recording a rollout decision (use cutover_decide).',
    schema: z.object({}),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.cutover_readiness'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'cutover_decide',
    description:
      "Event-source the enforcement rollout decision (operator-only, T-03 pattern: the ambient dispatch authorization must carry role 'operator' with a mutating posture — a delegated agent is denied). Runs the identical six-condition assessment to cutover_readiness, ALWAYS appends an admission.rollout-decision fact (outcome derived from the evidence: approve-enforcement or continue-shadow), and appends admission.enforcement-enabled ONLY when the gate is satisfied — an unsatisfied gate returns a typed CUTOVER_GATE_NOT_SATISFIED error naming the unmet conditions. Both facts land on the reserved exarchos-admission stream under natural-identity idempotency keys. Use for: recording the governance decision to flip (or keep shadowing). Do NOT use for: a side-effect-free readiness check (use cutover_readiness).",
    schema: z.object({}),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    // Mutates shared governance state (the store-wide enforcement posture) —
    // the strictest mutating trust tier, so the resolver gate rejects
    // read-only / task-isolated callers BEFORE the handler's operator check.
    posture: 'shared-mutating',
    autoEmits: [
      { event: 'admission.rollout-decision', condition: 'always' },
      { event: 'admission.enforcement-enabled', condition: 'conditional', description: 'Only when every cutover-gate condition is satisfied' },
    ],
    outputSchema: vacuityWaiver('exarchos_orchestrate.cutover_decide'),
    annotations: LOCAL_MUTATION,
  },
  makeDescribeAction('exarchos_orchestrate.describe'),
];

// ─── Composite Tool: exarchos_view ──────────────────────────────────────────

const viewActions: readonly BuiltinToolAction[] = [
  {
    name: 'pipeline',
    description: "Aggregated view of active workflows with stack positions, repo-scoped by default to the caller's repo (excludes completed/cancelled unless includeCompleted=true). Returns ≤ 10 compact entries; data.page carries {total, offset, limit, hasMore} and data.scope/data.unscopedTotal report the effective scope and the pre-scope count so hidden rows are perceivable. Pass scope='all' to span every repo, an explicit repoRoot to scope to another repo, or detail=true for the full per-task map.",
    schema: z.object({
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
      includeCompleted: z.boolean().optional(),
      // DR-1 — schema-level flag so the CLI flag auto-emits. Default entries
      // omit the per-task `tasksById` map; `detail: true` restores it.
      detail: z.boolean().optional(),
      // DR-6 — repo-scope inputs, schema-declared so the CLI flags auto-emit.
      // `repoRoot` scopes to an arbitrary repo (normalized before compare);
      // `scope` forces 'all' (unfiltered) or 'repo' (requires a resolvable key).
      repoRoot: z.string().optional(),
      // DR-3 (task 007) — `scope` migrated onto the shared `schema-fields.ts`
      // shape so `pipeline` and `ps` declare ONE `scope` definition on this tool
      // (no flattener collision). The shared shape is the UNION
      // `['repo','all','workflow','worktree']`; `pipeline` acts ONLY on the
      // `{repo, all}` subset and REJECTS the `ps`-only members (`workflow`/
      // `worktree`) at the handler with a structured `INVALID_INPUT` (mirroring
      // how `ps` rejects the pipeline-only `repo` member) — never a silent
      // coerce to unscoped (see the subset guard in `projections/views/tools.ts`).
      scope: lifecycleScopeField.optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    cli: {
      alias: 'ls',
      examples: ['exarchos vw ls'],
    },
    outputSchema: vacuityWaiver('exarchos_view.pipeline'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'tasks',
    description: 'Task detail view with filtering and projection',
    schema: z.object({
      workflowId: z.string().optional(),
      filter: coercedRecord().optional(),
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
      fields: coercedStringArray().optional(),
      // DR-8 (Task 013) — schema-declared so the CLI flag auto-emits; the
      // compact-by-default fold + `detail:true` full-row restore land in the
      // handler under Task 013.
      detail: z.boolean().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    cli: {
      flags: { workflowId: { alias: 'w' }, limit: { alias: 'l' } },
      examples: ['exarchos vw tasks -w my-feature'],
    },
    outputSchema: vacuityWaiver('exarchos_view.tasks'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'workflow_status',
    description: 'Workflow phase, task counts, and metadata',
    schema: z.object({
      workflowId: z.string().optional(),
      // DR-8 (Task 013) — list/inventory paging + detail inputs, schema-
      // declared so the CLI flags auto-emit; the `page` metadata + `detail:true`
      // fold land in the handler under Task 013.
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
      detail: z.boolean().optional(),
      // #1555 — optional bounded-fold (as-of/time-travel) read over a single
      // stream. Same single-source `AsOfSchema` as `get`. The bounded read
      // bypasses the hwm cache (see views/tools.ts) so the projection folds
      // only `events[0..N]`. `pipeline` is intentionally excluded: its
      // cross-stream aggregation has no single `(timestamp, sequence)` axis
      // to bound coherently.
      asOf: AsOfSchema.optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    cli: {
      flags: { workflowId: { alias: 'w' } },
      examples: [
        'exarchos vw workflow_status -w my-feature',
        'exarchos vw workflow_status -w my-feature --as-of \'{"untilSequence":3}\'',
      ],
    },
    outputSchema: vacuityWaiver('exarchos_view.workflow_status'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'stack_status',
    description: 'Get current stack positions from events',
    schema: z.object({
      streamId: z.string().optional(),
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
      // DR-8 (Task 013) — `detail:true` full-row restore; handler rides Task 013.
      detail: z.boolean().optional(),
    }),
    phases: STACK_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.stack_status'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'stack_place',
    description: 'Record a stack position for a task',
    schema: z.object({
      streamId: z.string().min(1),
      position: coercedNonnegativeInt(),
      taskId: z.string().min(1),
      branch: z.string().optional(),
      prUrl: z.string().optional(),
    }),
    phases: STACK_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.stack_place'),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'telemetry',
    description: 'Get telemetry metrics with per-tool performance data and optimization hints',
    schema: z.object({
      compact: z.boolean().optional(),
      tool: z.string().optional(),
      sort: z.enum(['tokens', 'invocations', 'duration']).optional(),
      limit: coercedPositiveInt().optional(),
      // DR-8 (Task 024) — offset paging + detail inputs on the analytic view
      // batch, schema-declared so the CLI flags auto-emit; the `page`/`scope`
      // metadata + `detail:true` fold land in the handler under Task 024.
      offset: coercedNonnegativeInt().optional(),
      detail: z.boolean().optional(),
      // Wave 5 (#1437) — correlation tuple filters scope the telemetry
      // rollup to a single dispatch boundary. Honored at the backend layer
      // (indexed columns / post-fetch JS filter); INV-1 keeps payload as
      // truth, mirrored to the indexed columns.
      ...CORRELATION_TUPLE_FILTER_SHAPE,
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    // PR3/T10 (#1364) — typed envelope advertises the per-tool
    // `actionErrors` + `actionErrorBreakdown` fields (post Wave 0 carrier
    // composition).
    // Task 022 (DR-1/DR-8): union the capped-shape fallback into the typed
    // telemetry `data` so a summarized/capped telemetry response validates
    // against its own registered contract (D.5 totality).
    outputSchema: withCappedShape(TelemetryViewOutputSchema),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'team_performance',
    description: 'Team performance metrics from delegation events',
    schema: z.object({
      workflowId: z.string().optional(),
      // DR-8 (Task 013) — list/inventory paging + detail; handler rides Task 013.
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
      detail: z.boolean().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.team_performance'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'delegation_timeline',
    description: 'Delegation timeline with bottleneck detection',
    schema: z.object({
      workflowId: z.string().optional(),
      // DR-8 (Task 013) — list/inventory paging + detail; handler rides Task 013.
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
      detail: z.boolean().optional(),
      // Wave 5 (#1437) — correlation tuple filters scope the projection
      // fold to a single dispatch boundary.
      ...CORRELATION_TUPLE_FILTER_SHAPE,
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.delegation_timeline'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'code_quality',
    description: 'Code quality metrics with gate pass rates, skill attribution, and regression detection',
    schema: z.object({
      workflowId: z.string().optional(),
      skill: z.string().optional(),
      gate: z.string().optional(),
      limit: coercedPositiveInt().optional(),
      // DR-8 (Task 024) — offset paging + detail on the analytic view batch;
      // handler rides Task 024.
      offset: coercedNonnegativeInt().optional(),
      detail: z.boolean().optional(),
      // Wave 5 (#1437) — correlation tuple filters scope the projection
      // fold to a single dispatch boundary.
      ...CORRELATION_TUPLE_FILTER_SHAPE,
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.code_quality'),
    annotations: READ_ONLY_LOCAL,
  },
  // Wave 5 (#1437) — Group B telemetry view actions. These actions were
  // previously dispatched via `exarchos_view` through composite.ts but had
  // no entry in TOOL_REGISTRY's `viewActions`, so per-action schema
  // validation (DR-5) and describe-handler introspection both skipped them.
  // Registering them here brings them under the dispatch-validation contract
  // AND surfaces their correlation-filter slots through `describe(actions)`.
  {
    name: 'eval_results',
    description: 'Evaluation suite results with per-skill pass/fail rates and regression flags',
    schema: z.object({
      workflowId: z.string().optional(),
      skill: z.string().optional(),
      limit: coercedPositiveInt().optional(),
      // DR-8 (Task 024) — offset paging + detail on the analytic view batch;
      // handler rides Task 024.
      offset: coercedNonnegativeInt().optional(),
      detail: z.boolean().optional(),
      // Wave 5 (#1437) — correlation tuple filters scope the projection
      // fold to a single dispatch boundary.
      ...CORRELATION_TUPLE_FILTER_SHAPE,
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.eval_results'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'quality_correlation',
    description: 'Per-skill correlation of code-quality gate pass rates with eval scores',
    schema: z.object({
      workflowId: z.string().optional(),
      // DR-8 (Task 024) — paging + detail on the analytic view batch;
      // handler rides Task 024.
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
      detail: z.boolean().optional(),
      // Wave 5 (#1437) — correlation tuple filters scope BOTH underlying
      // projection folds (CQ + ER) to a single dispatch boundary so the
      // joined output stays internally consistent.
      ...CORRELATION_TUPLE_FILTER_SHAPE,
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.quality_correlation'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'quality_attribution',
    description: 'Attribute quality outcomes across a dimension (skill / model / gate / prompt-version)',
    schema: z.object({
      workflowId: z.string().optional(),
      dimension: z.enum(['skill', 'model', 'gate', 'prompt-version']).optional(),
      skill: z.string().optional(),
      timeRange: z
        .object({
          start: z.string(),
          end: z.string(),
        })
        .optional(),
      // DR-8 (Task 024) — paging + detail on the analytic view batch;
      // handler rides Task 024.
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
      detail: z.boolean().optional(),
      // Wave 5 (#1437) — correlation tuple filters scope BOTH underlying
      // projection folds (CQ + ER) to a single dispatch boundary.
      ...CORRELATION_TUPLE_FILTER_SHAPE,
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.quality_attribution'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'delegation_readiness',
    description: 'Check delegation readiness: plan approval, quality gates, and worktree status. Pass `tasks` to scope readiness to the active wave instead of every historical assignment (WFQ-002).',
    schema: z.object({
      workflowId: z.string().optional(),
      tasks: coercedStringArray()
        .optional()
        .describe("Active wave's task IDs; scopes expected/ready/blockers to exactly this set"),
      detail: z.boolean().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.delegation_readiness'),
    annotations: READ_ONLY_LOCAL,
  },
  // T1 (#1446 residue) — three view actions dispatched through
  // `projections/views/composite.ts` but previously absent from TOOL_REGISTRY.viewActions.
  // Without the registry entry, per-action Zod validation at
  // `dispatch/core/dispatch.ts:801` is silently skipped (DR-5 hole) and
  // `exarchos_view describe` cannot surface their schemas. Registering them
  // here closes both gaps. Schemas mirror the args the composite.ts handlers
  // route today (see `projections/views/composite.ts` cases for each action).
  {
    name: 'session_provenance',
    description: 'Per-session provenance roll-up (tokens, tools, cost attribution) — query by sessionId or workflowId, optionally narrowed by metric',
    schema: z.object({
      sessionId: z.string().optional(),
      workflowId: z.string().optional(),
      metric: z.string().optional(),
      // No correlation-tuple filter slots: the underlying handler
      // (`handleViewSessionProvenance`) does not receive the event store.
      // The session-provenance projection reads `stateDir` only, so there
      // is no event-store query for the tuple filters to scope.
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.session_provenance'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'provenance',
    description: 'Design-to-task provenance: per-requirement coverage and orphan-task detection from the design.linked / task.assigned event chain',
    schema: z.object({
      workflowId: z.string().optional(),
      // Underlying handler (`handleViewProvenance`) queries the event store
      // via `queryDeltaEvents`, so the correlation-tuple filter surface
      // mirrors the Wave 5 (#1437) telemetry-view contract — slots are
      // optional and pass through the cache-bypassing filtered fold path
      // when present.
      ...CORRELATION_TUPLE_FILTER_SHAPE,
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.provenance'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'synthesis_readiness',
    description: 'Check synthesis readiness: task completion, reviews, tests, and typecheck status',
    schema: z.object({
      workflowId: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.synthesis_readiness'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'shepherd_status',
    description: 'PR shepherd status: CI, comments, unresolved findings, and iteration tracking',
    schema: z.object({
      workflowId: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.shepherd_status'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'convergence',
    description: 'Per-dimension gate convergence status (D1-D5) from gate.executed events',
    schema: z.object({
      workflowId: z.string().optional(),
      // DR-8 (Task 024) — paging + detail on the analytic view batch;
      // handler rides Task 024.
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
      detail: z.boolean().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.convergence'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'gate_reliability',
    description:
      'Diagnostic gate reliability: per-gate false-positive rate and verdict provenance from admission evidence/contradiction events (no admission authority)',
    schema: z.object({
      workflowId: z.string().optional(),
      detail: z.boolean().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.gate_reliability'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'quality_hints',
    description: 'Generate quality improvement hints from code quality view',
    schema: z.object({
      workflowId: z.string().optional().describe('Workflow ID to generate hints for'),
      skill: z.string().optional().describe('Filter hints by skill name'),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.quality_hints'),
    annotations: READ_ONLY_LOCAL,
  },
  // DR-7 (T-20) — effective invariant catalog export. Surfaces the merged +
  // override-clamped + projected invariant set for a given SDLC context via
  // the single core fn `resolveEffectiveCatalog` (INV-2: one payload, many
  // facades). The CLI `--json` form routes the same handler.
  // SEAM (#1275): expose this same payload as
  // resources/exarchos-invariants/effective when MCP Resources land. Register
  // NO `resources/*` today.
  {
    name: 'invariants_effective',
    description:
      'Effective invariant catalog (merged dev + user catalogs, overrides clamped to each floor, projected to the given phase/workflow) — the resolveEffectiveCatalog payload (DR-7)',
    schema: z.object({
      phase: z.string().describe('SDLC phase to project for (e.g. ideate, plan, delegate)'),
      workflowType: z
        .string()
        .describe('Workflow kind to project for (e.g. feature, debug, discovery)'),
      repoRoot: z
        .string()
        .optional()
        .describe('Repo root for .exarchos.yml + dev-catalog resolution; defaults to cwd'),
      touchedFiles: coercedStringArray()
        .optional()
        .describe('Files the current task touches (delegate-phase projection narrowing)'),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.invariants_effective'),
    annotations: READ_ONLY_LOCAL,
  },
  // ─── Worktree-lifecycle view (WLM foundation, task 008) ───────────────────
  // The read leg of the worktree actions: folds the `worktrees` stream through
  // the `worktrees@v1` projection. Pure read — no adopt, no git probe, no
  // append — so it sits on the wholesale-read-only exarchos_view tool.
  {
    name: 'worktrees',
    surface: 'worktree',
    description:
      'List the governed worktree set — the live worktrees@v1 projection (each entry: worktreeId, path, featureId, lifecycle state, owner pid/start-time). Read-only; emits no events. DR-3 bounded output: omitting limit caps the item count deterministically and, if the capped page would still blow the output-token budget, returns a counts-by-state summary + first page instead of per-item detail; narrow with limit/offset. Use for: inspecting which worktrees are governed and their reservation/orphan state. Do NOT use for: claiming or freeing a worktree (use acquire_worktree / release_worktree); the in-flight merge/prune liveness set (use ps).',
    schema: z.object({
      // Reuse pipeline's EXACT coerced base field types (coercedPositiveInt /
      // coercedNonnegativeInt) so the MCP-registration flattener sees no divergent
      // shape for the shared `limit` / `offset` field names (DR-3).
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: withCappedShape(WorktreesOutputSchema),
    annotations: READ_ONLY_LOCAL,
  },
  // ─── Worktree-lifecycle liveness reads (WLM operational core, DR-4) ────────
  // The `ps` / `wait` leg over the singleton `worktrees` stream: `ps` surfaces
  // the live `inFlightMerges` set, `wait` blocks (caller-bounded) on a serialized
  // merge reaching its terminal. `ps probe:true` runs the on-demand DR-5 orphan
  // probe and emits worktree.released / worktree.orphan_detected — a conditional
  // idempotent heal. Annotation honesty: `wait` is genuinely read-only, but `ps`
  // has that conditional write path, so it is annotated `local-mutation` /
  // `idempotent` (NOT readOnly) — re-running converges (the heals are
  // idempotent), it just is not a zero-append read.
  {
    name: 'ps',
    surface: 'worktree',
    description:
      "Scope-parameterized process-plane lister composing three folds (DR-3). scope:'all' (DEFAULT) returns a workflows section (every tracked workflow: featureId, workflowType, phase, status, age) PLUS an operations section (every IN-FLIGHT liveness instance across merge/launch/mutation/prune — a started-without-terminal pair, surface-generic). scope:'workflow' returns the workflows section only; filter it with status/phase/workflowType and all:true to include terminal workflows. scope:'worktree' preserves the WLM-6 worktree capabilities: the worktrees@v1 inFlightMerges/launches/inFlightPrunes fold, and probe:true (valid ONLY in this scope) runs the on-demand DR-5 process probe emitting worktree.released / worktree.orphan_detected + reconciling dead holders. probe on a non-worktree scope is INVALID_INPUT. Idempotent: a pure read except scope:'worktree' probe:true, whose heals re-converge. Use for: a snapshot of what workflows exist and what operations are in flight. Do NOT use for: the governed worktree set (use worktrees); blocking until a condition holds (use wait).",
    schema: z.object({
      // DR-3 (task 007) — the process-plane axis. Imported from the shared
      // schema-fields SoT (widened to the union `['repo','all','workflow',
      // 'worktree']` so `pipeline` and `ps` share ONE `scope` definition on this
      // tool). `ps` accepts the `workflow|worktree|all` subset and rejects `repo`
      // at the handler; default `all`.
      scope: lifecycleScopeField.optional(),
      // Worktree-scope-only: the on-demand DR-5 process probe. Rejected (INVALID_INPUT)
      // for any non-worktree scope at the handler.
      probe: z.boolean().optional(),
      // Workflows-section filters (scope workflow|all). Base types imported from
      // the DR-8 schema-fields SoT so the flattened registration cannot drift them:
      // `phase`/`workflowType` collide with invariants_effective (both z.string());
      // `status` is new; `all` is a new boolean; `limit` reuses the shared coerced int.
      status: lifecycleStatusField.optional(),
      phase: lifecyclePhaseField.optional(),
      workflowType: lifecycleWorkflowTypeField.optional(),
      all: lifecycleAllField.optional(),
      limit: lifecycleLimitField.optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    // DR-7 (task-015): promote `ps` to a TOP-LEVEL CLI verb (`exarchos ps`)
    // alongside its `vw ps` subcommand form. Both dispatch through the ONE
    // `registerActionCommand` path (same Zod schema, no divergent parsing).
    cli: { topLevel: 'ps' },
    outputSchema: withCappedShape(PsOutputSchema),
    // `ps scope:'worktree' probe:true` can append worktree.released /
    // worktree.orphan_detected, so the action is NOT readOnly. The heals are
    // idempotent (re-running a probe over an already-reconciled set emits nothing)
    // and non-destructive → idempotent local-mutation. Every non-probe scope path
    // is a pure read; the conservative annotation covers the sole write path.
    // `wait` / `worktrees` stay genuinely READ_ONLY_LOCAL.
    annotations: LOCAL_MUTATION_IDEMPOTENT,
  },
  {
    name: 'wait',
    surface: 'worktree',
    description:
      "Block until an event-log predicate holds; PURE CONSUMER — emits NO events, never hangs (structured WAIT_TIMEOUT on expiry). Feature-scoped (needs featureId, pick one): phase resolves on entering the target phase (already-passed ⇒ immediate; a failed/cancelled terminal first ⇒ WAIT_FAILED); status resolves on the requested terminal (completed/failed/cancelled; a DIFFERENT terminal ⇒ WAIT_FAILED); operation <surface> is the S-6 predicate for feature-scoped surfaces (merge, mutation), resolving when the unpaired executing_started gains its registry terminal by instance key (none in flight ⇒ immediate; launch/prune ⇒ INVALID_INPUT → use until). Worktree scope: until:'merge' (default) awaits the serialized merge on integrationRef, until:'idle' awaits prune-idle; timeoutMs bounds it. Use for: gating on a phase/status/operation/merge/idle condition. Do NOT use for: a snapshot (use ps/inspect); running a merge (use serialize_merge).",
    schema: z.object({
      // Feature-scoped predicate target. Required by every feature-scoped
      // predicate (phase/status/operation); the worktree `until` scope ignores it.
      featureId: featureIdSchema.optional(),
      // DR-8 shared field shapes — imported from the schema-fields SoT so the
      // flattened exarchos_view registration cannot drift these names' base types
      // across lifecycle verbs. `phase` collides with invariants_effective.phase
      // (both z.string()); `status`/`operation` are new to exarchos_view.
      phase: lifecyclePhaseField.optional(),
      status: lifecycleStatusField.optional(),
      operation: lifecycleOperationField.optional(),
      // Optional: required only in the worktree until:'merge' mode (the handler
      // rejects a missing ref there). until:'idle' does not consult it. Base
      // type (ZodString) is unchanged, so the MCP-registration flattener sees no
      // divergent shape vs serialize_merge's required integrationRef (optionality
      // drift is allowed; base-type/enum/default drift is not).
      integrationRef: z.string().min(1).optional(),
      // Worktree-scope selector (WLM-6, absorbed). 'merge' polls the serialized-
      // merge terminal; 'idle' polls until the prune liveness pair clears. New
      // field name — no other action declares `until`, so no field-collision at
      // the flattener. NB: `wait` declares NO `scope` field at all — the worktree
      // scope axis rides `until` (the feature scope rides `phase`/`status`/
      // `operation`). (The shared `scopeField` is the 4-member union since task
      // 007; `wait` simply does not use it.)
      until: z.enum(['merge', 'idle']).optional(),
      // Bounded-wait budget. Same base type (ZodNumber) as serialize_merge /
      // doctor `timeoutMs` so the MCP-registration flattener sees no divergent
      // shape for the shared `timeoutMs` field name.
      timeoutMs: z.number().int().positive().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    // DR-7 (task-015): promote `wait` to a TOP-LEVEL CLI verb (`exarchos wait`)
    // alongside its `vw wait` subcommand form (one registerActionCommand path).
    cli: { topLevel: 'wait' },
    outputSchema: withCappedShape(WaitOutputSchema),
    // Pure read: appends nothing on every path → readOnlyHint + idempotentHint
    // (the MCP-annotation hints derive from `readOnly`/`idempotent` here). DR-5
    // revises #1316 Q7 — the log records domain facts, not observations of them.
    annotations: READ_ONLY_LOCAL,
  },
  // ─── Worktree-lifecycle single-workflow projection (DR-4) ─────────────────
  // The `inspect` read leg of the lifecycle verbs: folds ONE feature stream and
  // projects state (via the canonical event-store-first `resolveWorkflowState` —
  // SQLite is the only source of truth), recent events + the correlation tuple,
  // artifacts, and task progress. Pure read — appends nothing on any path — so it
  // sits on the wholesale-read-only exarchos_view tool as an ACTION (INV-5d: NO
  // new visible tool; the visible composite count stays 4). A cold probe of an
  // unknown featureId returns `workflowExists:false` and emits ZERO events (the
  // CB-2 no-phantom-stream guarantee). The CLI verb re-map (`inspect`→`describe`)
  // is task-015; the `--follow` streaming behavior is task-009 — the `follow`
  // field is schema-declared here (imported from the DR-8 SoT) so its CLI flag
  // auto-emits ahead of that handler work.
  {
    name: 'inspect',
    description:
      'Project a single workflow in one read: state (phase / workflowType / timestamps via the canonical event-store-first resolveWorkflowState — SQLite is the only source of truth, NEVER .state.json presence), the recent event tail + the latest dispatch correlation tuple, the artifact map, and task progress (roster + counts-by-status). Read-only; emits no events. Cold-probe safe: an unknown/never-init\'d featureId returns workflowExists:false and appends nothing (no phantom stream). Bound the event tail with limit (the full state/artifacts/tasks are always complete). Use for: a one-call status snapshot of a specific workflow. Do NOT use for: the cross-workflow pipeline roll-up (use pipeline); mutating or advancing a workflow (use exarchos_workflow).',
    schema: z.object({
      featureId: featureIdSchema,
      // DR-8 shared shapes (imported from the SoT so the flattened exarchos_view
      // registration cannot drift these field names' base types across verbs).
      // `limit` bounds the recent-event tail; `follow` is reserved for task-009's
      // `--follow` streaming (schema-declared now so its CLI flag auto-emits).
      limit: lifecycleLimitField.optional(),
      follow: followField.optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    cli: {
      // DR-7 (task-015): promote `inspect` to the TOP-LEVEL `describe` verb — the
      // workflow-PROJECTION describe (`exarchos describe -f my-feature`). The
      // top-level NAME intentionally differs from the action name: the schema-
      // introspection `describe` is a per-tool ACTION subcommand (`vw describe`,
      // `wf describe`), NEVER a top-level command, so `exarchos describe` (→ the
      // `inspect` action) does not collide with it. The task-014 hoist-loop guard
      // re-checks the full top-level namespace at build time and confirms this.
      topLevel: 'describe',
      flags: { featureId: { alias: 'f' } },
      examples: [
        'exarchos vw inspect -f my-feature',
        'exarchos describe -f my-feature',
      ],
    },
    // Typed-output totality (DR-1): union the generic capped-fallback shape so
    // the schema admits BOTH the baseline projection AND a dispatch-core-capped
    // {summary,counts,firstPage} envelope, keeping it total over emittable shapes.
    outputSchema: withCappedShape(InspectOutputSchema),
    annotations: READ_ONLY_LOCAL,
  },
  // ─── Worktree-lifecycle diagnostic bundle (DR-6) ──────────────────────────
  // The `export` WRITE leg of the lifecycle verbs (the last verb): writes a
  // portable zip bundle (events.jsonl / state.json / metadata.json / artifacts/)
  // of one workflow to a path OUTSIDE `.exarchos/`. Unlike the pure-read `ps` /
  // `wait` / `inspect` legs it has an unconditional external side effect (a file
  // write), so it declares the `task-isolated` posture (the capability resolver
  // mints fs:write from it, containing the blast radius to the caller's
  // worktree) and an openWorld annotation (writes outside the managed store).
  // It still rides `exarchos_view` as an ACTION (INV-5d — no new visible tool;
  // the composite count stays 4), like `ps`'s conditional probe-write path.
  // The write is journaled as the INV-13 export.requested → export.executed
  // pair, the storage idempotency key is derived from a logical key (INV-8), a
  // crashed pair is completed without duplicating the intent, and a cold probe
  // of an unknown featureId writes nothing + emits zero events. The CLI verb
  // promotion (`export`→top-level) is task-015.
  {
    name: 'export',
    description:
      "Write a portable diagnostic zip bundle of ONE workflow to disk: events.jsonl (the domain event stream, one JSON event/line), state.json (fold(events.jsonl) via the canonical projection — replaying events.jsonl reconstructs it), metadata.json (featureId / eventCount / phase / workflowType / artifacts + missingArtifacts), and artifacts/ (every referenced artifact FILE that exists; missing references are tolerated and listed). Default destination ./<featureId>-export.zip; override with output. Writes to a path OUTSIDE .exarchos/ (openWorld) and journals the INV-13 export.requested → export.executed pair around the write, so a crash between the two is completed WITHOUT duplicating the intent and a fresh invocation mints a new pair (INV-8). Cold-probe safe: an unknown featureId returns workflowExists:false, writes no zip and emits no events. Use for: capturing a self-contained, replayable snapshot of a workflow for diagnosis or handoff. Do NOT use for: a live status snapshot (use inspect); advancing or mutating the workflow (use exarchos_workflow).",
    schema: z.object({
      featureId: featureIdSchema,
      // DR-8 shared shape — imported from the schema-fields SoT (z.string(), a
      // destination FILE PATH, not a table|json format enum) so the flattened
      // exarchos_view registration cannot drift the `output` field's base type.
      output: lifecycleOutputField.optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    // #1305 — task-isolated trust tier: the resolver mints fs:write for the
    // bundle write, contained to the caller's worktree. The last worktree verb.
    posture: 'task-isolated',
    cli: {
      // DR-7 (task-015): promote `export` to a TOP-LEVEL CLI verb
      // (`exarchos export`) alongside its `vw export` subcommand form.
      topLevel: 'export',
      flags: { featureId: { alias: 'f' }, output: { alias: 'o' } },
      examples: [
        'exarchos vw export -f my-feature -o ./my-feature-export.zip',
        'exarchos export -f my-feature -o ./my-feature-export.zip',
      ],
    },
    // Typed-output totality (DR-1): union the generic capped-fallback shape so
    // the schema admits BOTH the bundle-write result AND a dispatch-core-capped
    // envelope.
    outputSchema: withCappedShape(ExportOutputSchema),
    // openWorldHint: true — writes a file outside the managed store.
    annotations: LOCAL_MUTATION_OPEN_WORLD,
  },
  makeDescribeAction('exarchos_view.describe'),
];

// ─── Composite Tool: exarchos_sync ──────────────────────────────────────────

const syncActions: readonly BuiltinToolAction[] = [
  {
    name: 'now',
    description: 'Trigger immediate sync with remote',
    schema: z.object({}),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_sync.now'),
    annotations: LOCAL_MUTATION_IDEMPOTENT,
  },
];

// ─── Tool Registry ──────────────────────────────────────────────────────────

// DR-4 (task 060) — the type on THIS constant is the registry's door. Declared
// `readonly BuiltinCompositeTool[]`, so every action reaching the registry must
// carry a `DeclaredOutputSchema`: the out-of-registry escape does not typecheck
// here, and neither does a `readonly ToolAction[]` array smuggled in beside the
// five below. It stays assignable to `readonly CompositeTool[]`, so no consumer
// changed.
export const TOOL_REGISTRY: readonly BuiltinCompositeTool[] = [
  {
    name: 'exarchos_workflow',
    description: 'Workflow lifecycle management — init, read, update, cancel, cleanup, checkpoint, reconcile, and rehydrate workflows',
    actions: workflowActions,
    cli: { alias: 'wf' },
    slimDescription: 'Workflow lifecycle management. Use describe(actions) for schemas.\n\nActions: init, get, update, transition, cancel, cleanup, reconcile, checkpoint, rehydrate',
  },
  {
    name: 'exarchos_event',
    description: 'Event sourcing — append and query events in streams',
    actions: eventActions,
    cli: { alias: 'ev' },
    slimDescription: 'Event sourcing — append and query events. Use describe(actions) for action schemas, describe(eventTypes) for event data schemas.\n\nActions: append, query, batch_append',
  },
  {
    name: 'exarchos_orchestrate',
    description: 'Task coordination — claim, complete, and fail tasks',
    actions: orchestrateActions,
    cli: { alias: 'orch' },
    slimDescription: 'Task coordination, quality gates, validation actions, and VCS operations. Use describe(actions) for schemas.\n\nActions: task_claim, task_complete, task_fail, review_triage, prepare_delegation, prepare_synthesis, assess_stack, check_static_analysis, check_integration_suite, check_security_scan, check_context_economy, check_operational_resilience, check_workflow_determinism, check_review_verdict, check_convergence, check_provenance_chain, check_design_completeness, check_plan_coverage, check_post_merge, check_task_decomposition, check_event_emissions, extract_task, review_diff, verify_worktree, select_debug_track, investigation_timer, check_coverage_thresholds, assess_refactor_scope, check_pr_comments, validate_pr_body, validate_pr_stack, debug_review_gate, extract_fix_tasks, generate_traceability, spec_coverage_check, verify_worktree_baseline, setup_worktree, verify_delegation_saga, post_delegation_check, reconcile_state, pre_synthesis_check, runbook, agent_spec, onboard, doctor, create_pr, merge_pr, check_ci, list_prs, get_pr_comments, add_pr_comment, create_issue, merge_orchestrate, check_invariant_conformance, acquire_worktree, release_worktree, prune_worktrees, serialize_merge',
  },
  {
    name: 'exarchos_view',
    description: 'CQRS materialized views — pipeline, tasks, workflow status, stack, and telemetry',
    actions: viewActions,
    cli: { alias: 'vw' },
    slimDescription: 'CQRS materialized views for pipeline, tasks, and telemetry. Use describe(actions) for schemas.\n\nActions: pipeline, tasks, workflow_status, stack_status, stack_place, telemetry, team_performance, delegation_timeline, code_quality, eval_results, quality_correlation, quality_attribution, quality_hints, delegation_readiness, synthesis_readiness, shepherd_status, convergence, session_provenance, provenance, invariants_effective, worktrees, ps, wait',
  },
  {
    name: 'exarchos_sync',
    description: 'Remote synchronization — trigger immediate sync (planned)',
    actions: syncActions,
    cli: { alias: 'sy' },
    hidden: true,
    slimDescription: 'Remote synchronization. Use describe(actions) for schemas.\n\nActions: now',
  },
];

// ─── Registration-time Invariant Loop (Wave 0 task C.3) ────────────────
//
// Runs at module load so any built-in action that drifts away from the
// `outputSchema` + `annotations` contract fails the import (DIM-3 fail-
// closed at startup). Custom tools registered via `registerCustomTool`
// are not covered here — that path validates per-action at call time
// through `validateAction` once `register.ts` is wired (Wave 0 follow-up).
for (const tool of TOOL_REGISTRY) {
  for (const action of tool.actions) {
    validateAction(action, tool.name);
  }
}

// ─── Built-in Tool Names ────────────────────────────────────────────────────

const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_REGISTRY.map((t) => t.name),
);

// ─── Dynamic Tool Registration (DEPRECATED — superseded by v3.0 #1258) ─────
//
// The `registerCustomTool` / `setCustomToolActionHandler` /
// `unregisterCustomTool` surface plus the `exarchos.config.ts` `tools:`
// block is the pre-SDK extension scaffolding for declaring custom MCP
// composite tools at runtime. It is superseded by the Workflow Builder
// SDK (epic #1258) shipping in v3.0, which becomes the single authoring
// surface for workflows AND custom tools. The closed-form `hsm-
// definitions.ts` / `playbooks.ts` registries are deleted in that
// milestone for the same DIM-5 hygiene reason — the SDK is the single
// source of truth.
//
// There are no known active consumers of this surface. CodeRabbit MAJOR
// on PR #1369 flagged that `registerCustomTool` doesn't run actions
// through `validateAction`, leaving missing `outputSchema`/`annotations`
// to surface as runtime crashes far from the registration site. Rather
// than tighten the contract (which would touch test fixtures and ship a
// pseudo-breaking-change to an API with no consumers), we mark the
// entire surface `@deprecated` here and schedule its removal alongside
// #1258 in v3.0.

const customTools: CompositeTool[] = [];

/** Maps `toolName -> actionName -> handler` for custom tool dispatch. */
const customToolHandlers = new Map<string, Map<string, CustomToolActionHandler>>();

export type CustomToolActionHandler = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * Register a custom composite tool. Throws if the name collides with a
 * built-in tool or an already-registered custom tool.
 *
 * @deprecated since v2.10.0 — this surface is removed in v3.0.0 in favor
 * of the Workflow Builder SDK (epic #1258), which becomes the single
 * authoring path for custom workflows and tools. New extension code
 * should target the v3.0 SDK instead.
 */
export function registerCustomTool(tool: CompositeTool): void {
  if (BUILTIN_TOOL_NAMES.has(tool.name)) {
    throw new Error(
      `Cannot register custom tool "${tool.name}": collides with built-in tool name`,
    );
  }
  if (customTools.some((t) => t.name === tool.name)) {
    throw new Error(
      `Cannot register custom tool "${tool.name}": already registered as a custom tool`,
    );
  }
  // Custom tools are intentionally NOT run through `validateAction` here.
  // The whole surface is `@deprecated` for v3.0 removal per #1258, so
  // hardening the contract here would ship a pseudo-breaking-change for
  // an API with no consumers (CodeRabbit PR #1369 MAJOR, resolved by
  // deprecation rather than tightening).
  customTools.push(tool);
}

/**
 * Store a handler function for a custom tool action.
 * Called during config-driven registration to wire handlers for dispatch.
 *
 * @deprecated since v2.10.0 — removed in v3.0.0 per #1258. See
 * {@link registerCustomTool}.
 */
export function setCustomToolActionHandler(
  toolName: string,
  actionName: string,
  handler: CustomToolActionHandler,
): void {
  let actionMap = customToolHandlers.get(toolName);
  if (!actionMap) {
    actionMap = new Map();
    customToolHandlers.set(toolName, actionMap);
  }
  actionMap.set(actionName, handler);
}

/**
 * Retrieve the handler for a custom tool action.
 * Returns undefined if the tool or action is not registered.
 *
 * @deprecated since v2.10.0 — removed in v3.0.0 per #1258. See
 * {@link registerCustomTool}.
 */
export function getCustomToolActionHandler(
  toolName: string,
  actionName: string,
): CustomToolActionHandler | undefined {
  return customToolHandlers.get(toolName)?.get(actionName);
}

/**
 * Check if a custom tool has any registered handlers.
 *
 * @deprecated since v2.10.0 — removed in v3.0.0 per #1258. See
 * {@link registerCustomTool}.
 */
export function hasCustomToolHandlers(toolName: string): boolean {
  const actionMap = customToolHandlers.get(toolName);
  return actionMap !== undefined && actionMap.size > 0;
}

/**
 * Unregister a custom composite tool by name. Throws if the name is a
 * built-in tool or not registered as a custom tool.
 *
 * @deprecated since v2.10.0 — removed in v3.0.0 per #1258. See
 * {@link registerCustomTool}.
 */
export function unregisterCustomTool(name: string): void {
  if (BUILTIN_TOOL_NAMES.has(name)) {
    throw new Error(
      `Cannot unregister built-in tool "${name}"`,
    );
  }
  const index = customTools.findIndex((t) => t.name === name);
  if (index === -1) {
    throw new Error(
      `Cannot unregister tool "${name}": not registered as a custom tool`,
    );
  }
  customTools.splice(index, 1);
  customToolHandlers.delete(name);
}

/**
 * Returns the full registry: built-in TOOL_REGISTRY + custom tools.
 */
export function getFullRegistry(): readonly CompositeTool[] {
  if (customTools.length === 0) return TOOL_REGISTRY;
  return [...TOOL_REGISTRY, ...customTools];
}

/**
 * Clear all registered custom tools. Used for test cleanup.
 */
export function clearCustomTools(): void {
  customTools.length = 0;
  customToolHandlers.clear();
}

/**
 * Find a specific action within a tool in the full registry (built-in + custom).
 * Returns undefined if the tool or action is not found.
 */
export function findActionInRegistry(toolName: string, actionName: string): ToolAction | undefined {
  const tool = getFullRegistry().find(t => t.name === toolName);
  return tool?.actions.find(a => a.name === actionName);
}

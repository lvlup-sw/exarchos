// ─── The Exarchos tool registry — the DECLARATION AUTHORITY ──────────────────
//
// AUTHORITY DIRECTION (resolved). This module is the single place an Exarchos
// action is DECLARED. Every other description of the action surface is a
// PROJECTION of these declarations, never a second declaration:
//
//   registry/  ──▶  adapters/mcp.ts        (tools/list: buildRegistrationSchema
//              │                            + buildToolDescription + annotations)
//              ├──▶  core/dispatch.ts       (routing + per-action .safeParse)
//              ├──▶  describe/handler.ts    (the `describe` action clients read)
//              ├──▶  adapters/cli.ts        (the CLI verb tree)
//              └──▶  contract/compiler/meta-model.ts
//                          └──▶ compile() ──▶ descriptors / schemas / proof fixtures
//
// The running server consumes the LEFT-hand projections. It does NOT consume a
// `compile()` descriptor — the compiled contract is an artifact about the
// server, not the thing the server runs on. Inverting that (so the descriptor
// IS the runtime surface) is not done; it stays open. Until it lands, do not
// describe the compiler as "the authority": adding an action here and nowhere
// else is correct and sufficient; adding one to the meta-model alone ships
// nothing.
//
// WHAT GUARDS THE PROJECTION. Because meta-model.ts derives from these
// declarations, a guard that compares the two is a tautology and is blind to a
// wrong meta-model. The drift guard that is NOT blind lives in
// `contract/compiler/runtime-authority.ts`: it audits the meta-model against
// the runtime projections listed above — a differential between two independent
// projections of these declarations. Its limits are stated in that file's
// header and are real: it catches a wrong PROJECTION (a `derive*Policy` reading
// the wrong field, an entry bound to the wrong action, a field the strict wire
// would reject), and it CANNOT catch a wrong DECLARATION here — an action
// annotated `readOnly: true` whose handler mutates the tree is invisible to it,
// because every projection reads the same (wrong) declaration.
//
// ── How this directory is arranged ──────────────────────────────────────────
//
// The declarations were one 4,587-line module. They are now split along the
// seams that were already implicit in it: the descriptive vocabulary an action
// carries (`hints`, `gate-metadata`, `annotations`, `types`), the machinery
// that projects declarations into schemas and descriptions (`schema-builders`,
// `describe-actions`, `output-schemas`, `phases`), the action lists themselves
// grouped per composite tool under `actions/`, and the assembled registry
// (`tools`) with its runtime extension surface (`custom-tools`).
//
// The split is a reorganization, not a redefinition: the assembled
// `TOOL_REGISTRY` names the same tools carrying the same actions. The
// recorded action snapshot checks that set after sorting. Declaration
// order is a separate pin: describe and CLI help walk the declaration
// array, so a family reorder would be silent if only the sorted set
// were compared.
// ────────────────────────────────────────────────────────────────────────────

export { coercedRecord, coercedPositiveInt, coercedNonnegativeInt, coercedStringArray, coercedIntArray } from '../coerce.js';

// The capped-shape constructors live with the brand they mint, and are
// re-exported here so their long-standing import path keeps working for the
// economy-enforcement and contract-compiler consumers.
export { CappedDataSchema, withCappedShape } from '../output-schema-declaration.js';

export type {
  CliActionHints,
  CliToolHints,
  DispatchHints,
  EconomyHints,
} from './hints.js';
export {
  DEFAULT_ECONOMY_BUDGET_TOKENS,
  DESCRIBE_ECONOMY_BUDGET_TOKENS,
  EVENT_DESCRIBE_ECONOMY_BUDGET_TOKENS,
  RUNBOOK_ECONOMY_BUDGET_TOKENS,
  resolveEconomyBudget,
} from './hints.js';

export type {
  GateMetadata,
  AutoEmission,
  ReservedEventAppendRegistration,
} from './gate-metadata.js';
export {
  RESERVED_EVENT_APPEND_REGISTRY,
  getReservedEventAppendRegistration,
} from './gate-metadata.js';

export type { ActionAnnotations } from './annotations.js';
export { ActionAnnotationsSchema, validateAnnotations, validateAction } from './annotations.js';

export type {
  ActionContract,
  ActionContractErrorCode,
  ActionEmission,
  ActionPostcondition,
  ActionRequirement,
  ActionResource,
  DeclaredSet,
  ExecutionAuthority,
  HostObligation,
  ReplayPolicy,
} from './action-contract.js';
export {
  ACTION_RESOURCE_KINDS,
  ActionContractError,
  AGENT_SPAWN_CAPABILITY,
  HOST_OBLIGATIONS,
  actionContractCanonicalBytes,
  contractEmissionsOf,
  declared,
  none,
  normalizeActionContract,
  withActionContract,
} from './action-contract.js';

export type {
  ToolAction,
  ContractedToolAction,
  CompositeTool,
  BuiltinToolAction,
  BuiltinActionDraft,
  BuiltinCompositeTool,
  ExtensionToolAction,
  ExtensionActionDraft,
  ExtensionCompositeTool,
} from './types.js';

export { buildCompositeSchema, buildRegistrationSchema, buildToolDescription } from './schema-builders.js';

export { ALL_PHASES } from './phases.js';

export {
  MetaDeprecationSchema,
  WorkflowSetOutputSchema,
  WorkflowTransitionOutputSchema,
  WorkflowUpdateOutputSchema,
  TelemetryViewOutputSchema,
} from './output-schemas.js';

export { TOOL_REGISTRY } from './tools.js';

export type { CustomToolActionHandler } from './custom-tools.js';
export {
  registerCustomTool,
  setCustomToolActionHandler,
  getCustomToolActionHandler,
  hasCustomToolHandlers,
  unregisterCustomTool,
  getFullRegistry,
  clearCustomTools,
  findActionInRegistry,
} from './custom-tools.js';

// The compile-time proof aliases are re-exported so `tsc` keeps checking them
// from the module that owns the declaration surface they constrain.
export type {
  _OutputSchemaNewActionDeclaringVacuousFailsCompile,
  _OutputSchemaNewActionDeclaringVacuousIsNotRegistered,
  _OutputSchemaNewActionCannotBeWaived,
  _OutputSchemaRegistryActionUsingExtensionEscapeFailsCompile,
  _OutputSchemaExtensionActionIsNotABuiltinDeclaration,
  _OutputSchemaRegistryDoorRejectsUnnarrowedTools,
  _OutputSchemaCappedShapeSatisfiesTheField,
  _OutputSchemaWaiverSatisfiesTheField,
  _OutputSchemaExtensionEscapeSatisfiesTheExtensionField,
  _OutputSchemaBuiltinActionIsAToolAction,
  _OutputSchemaExtensionActionIsAToolAction,
  _OutputSchemaExtensionToolIsACompositeTool,
  _ActionContractOmittedFromToolActionFailsCompile,
  _ActionContractOmittedFromBuiltinActionFailsCompile,
  _ActionContractOmittedFromExtensionActionFailsCompile,
  _ActionContractSatisfiesContractedToolAction,
} from './type-assertions.js';

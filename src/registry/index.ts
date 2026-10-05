/**
 * The Exarchos tool registry: the one place that declares each action. The MCP adapter, dispatch,
 * `describe`, the CLI verb tree, and the contract meta-model are projections of these declarations.
 * The running server uses the runtime projections, not a `compile()` descriptor. Thus a new
 * action needs only a declaration here.
 *
 * `contract/compiler/runtime-authority.ts` compares the meta-model with the runtime projections.
 * It catches a wrong projection but not a wrong declaration here, because each projection reads
 * the same declaration.
 *
 * The capped-shape constructors and the compile-time proof aliases are re-exported here. Thus the
 * old import path still works, and `tsc` checks the aliases from this module.
 */

export { coercedRecord, coercedPositiveInt, coercedNonnegativeInt, coercedStringArray, coercedIntArray } from '../coerce.js';

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
  contractEnsuredEventsOf,
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

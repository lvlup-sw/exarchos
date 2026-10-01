/**
 * Audits the compiler meta-model against the shipped runtime surface. `TOOL_REGISTRY` declares
 * each action, and `meta-model.ts` projects it. A guard that compares the meta-model with the
 * registry in the same way that it derives it always passes.
 *
 * So this module observes the functions that the running server calls: `buildRegistrationSchema`,
 * `buildToolDescription`, and `handleDescribe`. A wrong projection or a wrong action binding shows
 * as a finding. Coherence findings check the meta-model only against its own rules, and are weaker.
 *
 * The audit cannot catch a wrong declaration, because both sides read the same `ToolAction`. It
 * also does not cover dimensions that no runtime consumer reads, such as the authorization hints
 * and `presentation`. Findings are sorted, and no clock, path, or locale affects them.
 */

import {
  TOOL_REGISTRY,
  actionContractCanonicalBytes,
  buildRegistrationSchema,
  buildToolDescription,
  type ActionContract,
  type CompositeTool,
} from '../../registry.js';
import { zodToJsonSchema } from '../../utils/json-schema.js';
import { handleDescribe } from '../../describe/handler.js';
import { canonicalizeText } from '../authority-digest.js';
import { canonicalJson } from '../request-context.js';
import { sortedUnique, type ActionMetaModel, type MetaModel } from './meta-model.js';

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
}

function asStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((v) => typeof v === 'string') ? (value as readonly string[]) : null;
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A gate, normalized to the shape the meta-model's authorization policy uses. */
export interface ObservedGate {
  readonly blocking: boolean;
  readonly dimension: string | null;
  readonly gateClass: string | null;
}

/** One auto-emission, normalized to the meta-model's `{ event, condition }`. */
export interface ObservedAutoEmit {
  readonly event: string;
  readonly condition: string;
}

/**
 * What the shipped `describe` surface says about one action. Each field comes from a real
 * `handleDescribe` response and has the shape of the meta-model claim.
 */
export interface ObservedAction {
  readonly tool: string;
  readonly action: string;
  readonly description: string;
  /** Canonical JSON of `describe`'s `schema` (the action's input schema). */
  readonly inputSchemaJson: string;
  /** Canonical JSON of `describe`'s `outputSchemaJson`. */
  readonly outputSchemaJson: string;
  readonly roles: readonly string[];
  readonly phases: readonly string[];
  readonly gate: ObservedGate | null;
  readonly autoEmits: readonly ObservedAutoEmit[];
  readonly deprecated: boolean;
  readonly taskSuitable: boolean;
  readonly taskTtlSuggestionMs: number | null;
  readonly economyBudgetTokens: number;
  /** Normalized action contract as describe published it, or null when absent. */
  readonly actionContract: Readonly<Record<string, unknown>> | null;
  /** Canonical bytes digest describe published alongside the contract. */
  readonly actionContractDigest: string | null;
  /** The compact contract view. It can omit prose, but it must keep each dimension and the digest. */
  readonly actionContractCompact: Readonly<Record<string, unknown>> | null;
}

/** What the shipped MCP registration surface says about ONE composite tool. */
export interface ObservedTool {
  readonly tool: string;
  /** True when `adapters/mcp.ts` advertises this tool over `tools/list`. */
  readonly advertisedOverMcp: boolean;
  /** The action names the registered STRICT schema's discriminator accepts. */
  readonly advertisedActions: readonly string[];
  /** Property names published as the tool's `inputSchema.properties`. */
  readonly wireInputProperties: readonly string[];
  /** The exact `tools/list` description string, line-ending canonicalized. */
  readonly wireDescription: string;
  /** Behavioral probe: does the strict wire schema accept `{ action }`? */
  readonly acceptsAction: (action: string) => boolean;
  /**
   * Behavioral probe: which of `fields` does the strict wire schema reject as
   * unrecognized when sent alongside `action`? A rejected field means a client
   * that follows the compiled contract gets a validation error from the real
   * server.
   */
  readonly rejectsFields: (action: string, fields: readonly string[]) => readonly string[];
  readonly actions: ReadonlyMap<string, ObservedAction>;
}

export interface RuntimeSurface {
  readonly tools: ReadonlyMap<string, ObservedTool>;
}

function observeGate(value: unknown): ObservedGate | null {
  const raw = asRecord(value);
  if (raw === null) return null;
  return {
    blocking: raw.blocking === true,
    dimension: typeof raw.dimension === 'string' ? raw.dimension : null,
    gateClass: typeof raw.gateClass === 'string' ? raw.gateClass : null,
  };
}

function observeAutoEmits(value: unknown): readonly ObservedAutoEmit[] {
  if (!Array.isArray(value)) return [];
  const emits: ObservedAutoEmit[] = [];
  for (const item of value) {
    const raw = asRecord(item);
    if (raw === null) continue;
    if (typeof raw.event !== 'string' || typeof raw.condition !== 'string') continue;
    emits.push({ event: raw.event, condition: raw.condition });
  }
  return emits.sort((a, b) => byString(a.event, b.event) || byString(a.condition, b.condition));
}

function observeAction(
  tool: string,
  action: string,
  raw: Readonly<Record<string, unknown>>,
): ObservedAction {
  const dispatch = asRecord(raw.dispatch);
  return {
    tool,
    action,
    description: canonicalizeText(typeof raw.description === 'string' ? raw.description : ''),
    inputSchemaJson: canonicalJson(raw.schema ?? null),
    outputSchemaJson: canonicalJson(raw.outputSchemaJson ?? null),
    roles: [...(asStringArray(raw.roles) ?? [])].sort(byString),
    phases: [...(asStringArray(raw.phases) ?? [])].sort(byString),
    gate: observeGate(raw.gate),
    autoEmits: observeAutoEmits(raw.autoEmits),
    deprecated: raw.deprecated === true,
    taskSuitable: dispatch?.taskSuitable === true,
    taskTtlSuggestionMs:
      typeof dispatch?.taskTtlSuggestionMs === 'number' ? dispatch.taskTtlSuggestionMs : null,
    economyBudgetTokens:
      typeof raw.economyBudgetTokens === 'number' ? raw.economyBudgetTokens : Number.NaN,
    actionContract: asRecord(raw.actionContract),
    actionContractDigest: typeof raw.actionContractDigest === 'string' ? raw.actionContractDigest : null,
    actionContractCompact: asRecord(raw.actionContractCompact),
  };
}

/** A sentinel no registry action can be named, used to make the wire enumerate itself. */
const ENUM_PROBE_ACTION = '\u0000__runtime_authority_enum_probe__';

/**
 * Asks the strict registration schema which action names it accepts. It sends a name that cannot
 * exist and reads the enum from the `invalid_value` issue. Thus the answer comes from the schema
 * that the MCP adapter registers, not from the registry.
 */
function readAdvertisedActions(
  parseAction: (action: string) => { readonly issues: readonly unknown[] } | null,
): readonly string[] {
  const outcome = parseAction(ENUM_PROBE_ACTION);
  if (outcome === null) return [];
  for (const issue of outcome.issues) {
    const raw = asRecord(issue);
    if (raw === null) continue;
    const path = asStringArray(raw.path);
    if (path === null || path.length !== 1 || path[0] !== 'action') continue;
    const values = asStringArray(raw.values);
    if (values !== null) return [...values].sort(byString);
  }
  return [];
}

/**
 * Observes the live runtime surface. It is async because it calls the shipped `describe` handler,
 * which is async.
 */
export async function observeRuntimeSurface(
  registry: readonly CompositeTool[] = TOOL_REGISTRY,
): Promise<RuntimeSurface> {
  const tools = new Map<string, ObservedTool>();

  for (const tool of registry) {
    const registration = buildRegistrationSchema(tool.actions);

    const parseAction = (
      action: string,
      extra: Readonly<Record<string, unknown>> = {},
    ): { readonly issues: readonly unknown[] } | null => {
      const outcome = registration.safeParse({ action, ...extra });
      return outcome.success ? null : { issues: outcome.error.issues };
    };

    const acceptsAction = (action: string): boolean => {
      const outcome = parseAction(action);
      if (outcome === null) return true;
      return !outcome.issues.some((issue) => {
        const raw = asRecord(issue);
        const path = raw === null ? null : asStringArray(raw.path);
        return path !== null && path.length === 1 && path[0] === 'action';
      });
    };

    const rejectsFields = (action: string, fields: readonly string[]): readonly string[] => {
      if (fields.length === 0) return [];
      const probe: Record<string, unknown> = {};
      for (const field of fields) probe[field] = undefined;
      const outcome = parseAction(action, probe);
      if (outcome === null) return [];
      const rejected: string[] = [];
      for (const issue of outcome.issues) {
        const raw = asRecord(issue);
        if (raw === null || raw.code !== 'unrecognized_keys') continue;
        rejected.push(...(asStringArray(raw.keys) ?? []));
      }
      return sortedUnique(rejected);
    };

    const published = asRecord(zodToJsonSchema(registration));
    const wireInputProperties = Object.keys(asRecord(published?.properties) ?? {}).sort(byString);

    const actions = new Map<string, ObservedAction>();
    const described = await handleDescribe(
      { actions: tool.actions.map((a) => a.name) },
      tool.actions,
    );
    const describedData = described.success ? asRecord(described.data) : null;
    if (describedData !== null) {
      for (const [name, entry] of Object.entries(describedData)) {
        const raw = asRecord(entry);
        if (raw === null) continue;
        actions.set(name, observeAction(tool.name, name, raw));
      }
    }

    tools.set(tool.name, {
      tool: tool.name,
      advertisedOverMcp: tool.hidden !== true,
      advertisedActions: readAdvertisedActions((action) => parseAction(action)),
      wireInputProperties,
      wireDescription: canonicalizeText(buildToolDescription(tool)),
      acceptsAction,
      rejectsFields,
      actions,
    });
  }

  return { tools };
}

export const META_MODEL_FINDING_KINDS = [
  'wire-action-unadvertised',
  'wire-action-unmodelled',
  'wire-field-rejected',
  'wire-field-unmodelled',
  'wire-signature-divergence',
  'runtime-policy-divergence',
  'contract-dimension-dropped',
  'policy-incoherence',
] as const;
export type MetaModelFindingKind = (typeof META_MODEL_FINDING_KINDS)[number];

/**
 * The weight of a finding. A `runtime-differential` finding comes from a projection outside
 * `meta-model.ts`. An `internal-coherence` finding comes from hand-authored rules over the
 * meta-model, and is weaker.
 */
export type FindingProvenance = 'runtime-differential' | 'internal-coherence';

export function findingProvenance(kind: MetaModelFindingKind): FindingProvenance {
  return kind === 'policy-incoherence' ? 'internal-coherence' : 'runtime-differential';
}

export interface MetaModelFinding {
  readonly kind: MetaModelFindingKind;
  readonly provenance: FindingProvenance;
  readonly actionId: string;
  /** Dotted path to the offending meta-model field. */
  readonly field: string;
  /** What the runtime authority (or the invariant) says. */
  readonly expected: string;
  /** What the meta-model claims. */
  readonly actual: string;
  readonly message: string;
}

function finding(
  kind: MetaModelFindingKind,
  actionId: string,
  field: string,
  expected: string,
  actual: string,
  message: string,
): MetaModelFinding {
  return { kind, provenance: findingProvenance(kind), actionId, field, expected, actual, message };
}

function sortFindings(findings: readonly MetaModelFinding[]): readonly MetaModelFinding[] {
  const key = (f: MetaModelFinding): string =>
    `${f.actionId}\u0000${f.kind}\u0000${f.field}\u0000${f.message}`;
  return [...findings].sort((a, b) => byString(key(a), key(b)));
}

interface SchemaFacts {
  readonly properties: readonly string[];
  readonly required: ReadonlySet<string>;
  readonly defaulted: ReadonlySet<string>;
}

function schemaFacts(schema: unknown): SchemaFacts {
  const raw = asRecord(schema);
  const properties = asRecord(raw?.properties) ?? {};
  const defaulted = new Set<string>();
  for (const [key, value] of Object.entries(properties)) {
    const prop = asRecord(value);
    if (prop !== null && 'default' in prop) defaulted.add(key);
  }
  return {
    properties: Object.keys(properties),
    required: new Set(asStringArray(raw?.required) ?? []),
    defaulted,
  };
}

/**
 * Rebuilds the `- name(params): description` line of `buildToolDescription` from the meta-model
 * claims only. The wire marks a parameter optional from Zod `isOptional()`. Here a parameter is
 * optional when it is absent from JSON Schema `required` or has a `default`. The two encodings
 * differ, so the check is a real differential.
 */
export function expectedSignatureLine(entry: ActionMetaModel): string {
  const facts = schemaFacts(entry.inputSchema);
  const params = facts.properties.map((key) =>
    facts.required.has(key) && !facts.defaulted.has(key) ? key : `${key}?`,
  );
  return `- ${entry.action}(${params.join(', ')}): ${entry.description}`;
}

const OBSERVED_CONTRACT_DIMENSIONS = [
  'requires',
  'ensures',
  'needs',
  'touches',
  'executionAuthority',
  'replay',
  'emissions',
] as const;

function modelledActionContract(entry: ActionMetaModel): ActionContract | undefined {
  return entry.actionContract ?? entry.policy.actionContract;
}

function droppedDimensionFinding(
  actionId: string,
  field: string,
  expected: string,
  actual: string,
  message: string,
): MetaModelFinding {
  return finding('contract-dimension-dropped', actionId, field, expected, actual, message);
}

function auditActionContract(
  entry: ActionMetaModel,
  observed: ObservedAction,
): readonly MetaModelFinding[] {
  const findings: MetaModelFinding[] = [];
  const id = entry.actionId;
  const modelled = modelledActionContract(entry);
  const described = observed.actionContract;

  if (modelled === undefined && described === null) return findings;

  if (modelled !== undefined && described === null) {
    findings.push(
      droppedDimensionFinding(
        id,
        'actionContract',
        '<described by the shipped describe surface>',
        '<absent>',
        `action '${id}' has an action contract in the meta-model, but the shipped describe surface dropped it`,
      ),
    );
    return findings;
  }

  if (modelled === undefined && described !== null) {
    findings.push(
      droppedDimensionFinding(
        id,
        'actionContract',
        '<absent from the meta-model>',
        '<described by the shipped describe surface>',
        `action '${id}' is described with an action contract that the meta-model dropped`,
      ),
    );
    return findings;
  }

  if (modelled === undefined || described === null) return findings;

  for (const dimension of OBSERVED_CONTRACT_DIMENSIONS) {
    const modelledHas = dimension in modelled;
    const describedHas = dimension in described;
    if (!modelledHas || !describedHas) {
      const missingFrom = !modelledHas && !describedHas
        ? 'both the meta-model and the shipped describe surface'
        : !modelledHas
          ? 'the meta-model'
          : 'the shipped describe surface';
      findings.push(
        droppedDimensionFinding(
          id,
          `actionContract.${dimension}`,
          dimension,
          '<absent>',
          `action '${id}' dropped action-contract dimension '${dimension}' from ${missingFrom}`,
        ),
      );
      continue;
    }
    const expected = canonicalJson(described[dimension]);
    const actual = canonicalJson(modelled[dimension]);
    if (expected === actual) continue;
    findings.push(
      finding(
        'runtime-policy-divergence',
        id,
        `actionContract.${dimension}`,
        expected,
        actual,
        `action '${id}' action-contract dimension '${dimension}': the shipped describe surface reports ${expected}, the meta-model claims ${actual}`,
      ),
    );
  }

  const expectedDigest = actionContractCanonicalBytes(modelled);
  if (observed.actionContractDigest === null) {
    findings.push(
      droppedDimensionFinding(
        id,
        'actionContractDigest',
        expectedDigest,
        '<absent>',
        `action '${id}' dropped the action-contract digest from the shipped describe surface`,
      ),
    );
  } else if (observed.actionContractDigest !== expectedDigest) {
    findings.push(
      finding(
        'runtime-policy-divergence',
        id,
        'actionContractDigest',
        expectedDigest,
        observed.actionContractDigest,
        `action '${id}' action-contract digest: the shipped describe surface reports ${observed.actionContractDigest}, the meta-model claims ${expectedDigest}`,
      ),
    );
  }

  const compact = observed.actionContractCompact;
  if (compact === null) return findings;

  for (const dimension of OBSERVED_CONTRACT_DIMENSIONS) {
    if (dimension in compact) continue;
    findings.push(
      droppedDimensionFinding(
        id,
        `actionContractCompact.${dimension}`,
        dimension,
        '<absent>',
        `action '${id}' dropped action-contract dimension '${dimension}' from the compact describe view`,
      ),
    );
  }
  if (typeof compact.digest !== 'string' || compact.digest.length === 0) {
    findings.push(
      droppedDimensionFinding(
        id,
        'actionContractCompact.digest',
        expectedDigest,
        '<absent>',
        `action '${id}' dropped the action-contract digest from the compact describe view`,
      ),
    );
  }

  return findings;
}

function auditAgainstDescribe(
  entry: ActionMetaModel,
  observed: ObservedAction,
): readonly MetaModelFinding[] {
  const findings: MetaModelFinding[] = [];
  const id = entry.actionId;
  const diverges = (
    field: string,
    expected: string,
    actual: string,
    what: string,
  ): void => {
    if (expected === actual) return;
    findings.push(
      finding(
        'runtime-policy-divergence',
        id,
        field,
        expected,
        actual,
        `action '${id}' ${what}: the shipped describe surface reports ${expected}, the meta-model claims ${actual}`,
      ),
    );
  };

  diverges('description', observed.description, entry.description, 'description');
  diverges(
    'inputSchema',
    observed.inputSchemaJson,
    canonicalJson(entry.inputSchema),
    'input schema',
  );
  diverges(
    'outputSchema',
    observed.outputSchemaJson,
    canonicalJson(entry.outputSchema),
    'output schema',
  );
  diverges(
    'policy.authorization.roles',
    canonicalJson(observed.roles),
    canonicalJson(entry.policy.authorization.roles),
    'role set',
  );
  diverges(
    'policy.authorization.phases',
    canonicalJson(observed.phases),
    canonicalJson([...entry.policy.authorization.phases].sort(byString)),
    'phase set',
  );
  diverges(
    'policy.authorization.gate',
    canonicalJson(observed.gate),
    canonicalJson(entry.policy.authorization.gate),
    'gate metadata',
  );
  diverges(
    'policy.evidence.autoEmits',
    canonicalJson(observed.autoEmits),
    canonicalJson(entry.policy.evidence.autoEmits),
    'auto-emission set',
  );
  diverges(
    'policy.execution.deprecated',
    canonicalJson(observed.deprecated),
    canonicalJson(entry.policy.execution.deprecated),
    'deprecation flag',
  );
  diverges(
    'policy.compatibility.deprecated',
    canonicalJson(observed.deprecated),
    canonicalJson(entry.policy.compatibility.deprecated),
    'deprecation flag',
  );
  diverges(
    'policy.task.taskAugmentable',
    canonicalJson(observed.taskSuitable),
    canonicalJson(entry.policy.task.taskAugmentable),
    'task-suitability',
  );
  diverges(
    'policy.task.ttlSuggestionMs',
    canonicalJson(observed.taskTtlSuggestionMs),
    canonicalJson(entry.policy.task.ttlSuggestionMs),
    'task TTL suggestion',
  );
  diverges(
    'policy.economy.budgetTokens',
    canonicalJson(observed.economyBudgetTokens),
    canonicalJson(entry.policy.economy.budgetTokens),
    'effective economy budget',
  );

  findings.push(...auditActionContract(entry, observed));

  return findings;
}

/**
 * Checks hand-authored rules for the dimensions that no runtime consumer reads. For example,
 * `cache.cacheable` means read-only and idempotent, and `WAIT_TIMEOUT` appears exactly when the
 * action is task-bound. A `derive*Policy` that reads a different field breaks a rule.
 */
function auditCoherence(entry: ActionMetaModel): readonly MetaModelFinding[] {
  const findings: MetaModelFinding[] = [];
  const id = entry.actionId;
  const p = entry.policy;

  const rule = (field: string, expected: unknown, actual: unknown, semantics: string): void => {
    const e = canonicalJson(expected);
    const a = canonicalJson(actual);
    if (e === a) return;
    findings.push(
      finding(
        'policy-incoherence',
        id,
        field,
        e,
        a,
        `action '${id}' violates the meta-model invariant "${semantics}": expected ${e}, got ${a}`,
      ),
    );
  };

  rule('policy.effect.mutates', !p.authorization.readOnly, p.effect.mutates, 'mutates ⇔ not read-only');
  rule(
    'policy.effect.compensable',
    p.authorization.safety === 'compensable',
    p.effect.compensable,
    'compensable ⇔ safety is compensable',
  );
  rule(
    'policy.effect.openWorld',
    p.authorization.openWorld,
    p.effect.openWorld,
    'effect open-world mirrors the authorization hint',
  );
  rule(
    'policy.cache.cacheable',
    p.authorization.readOnly && p.authorization.idempotent,
    p.cache.cacheable,
    'cacheable ⇔ read-only and idempotent',
  );
  rule(
    'policy.cancellation.cancellable',
    p.execution.longRunning || p.task.taskAugmentable,
    p.cancellation.cancellable,
    'cancellable ⇔ long-running or task-augmentable',
  );
  rule(
    'policy.cancellation.idempotentReplay',
    p.authorization.idempotent,
    p.cancellation.idempotentReplay,
    'idempotent replay mirrors the idempotency hint',
  );
  rule(
    'policy.presentation.compactByDefault',
    p.economy.compactByDefault,
    p.presentation.compactByDefault,
    'presentation compact-by-default mirrors the economy policy',
  );
  rule(
    'errorCodes[task-layer]',
    p.task.taskAugmentable || p.execution.longRunning,
    entry.errorCodes.includes('WAIT_TIMEOUT'),
    'task-layer error codes are reachable exactly when the action is task-bound',
  );

  return findings;
}

/**
 * Audits a meta-model against the observed runtime surface. It is pure, returns the findings
 * sorted, and does not throw.
 *
 * For each entry it checks the wire discriminator, the strict field schema, the `tools/list`
 * signature line, the `describe` policy, and coherence. Then it reports actions and fields that the
 * wire publishes but the meta-model omits. An empty result does not prove the declarations correct.
 */
export function auditMetaModel(
  metaModel: MetaModel,
  surface: RuntimeSurface,
): readonly MetaModelFinding[] {
  const findings: MetaModelFinding[] = [];
  const modelledByTool = new Map<string, Set<string>>();
  const modelledFieldsByTool = new Map<string, Set<string>>();

  for (const entry of metaModel.actions) {
    const id = entry.actionId;
    const tool = surface.tools.get(entry.tool);

    if (tool === undefined) {
      findings.push(
        finding(
          'wire-action-unadvertised',
          id,
          'tool',
          '<a tool the running server registers>',
          entry.tool,
          `action '${id}' names tool '${entry.tool}', which the running server does not register`,
        ),
      );
      continue;
    }

    const names = modelledByTool.get(entry.tool) ?? new Set<string>();
    names.add(entry.action);
    modelledByTool.set(entry.tool, names);

    const facts = schemaFacts(entry.inputSchema);
    const fields = modelledFieldsByTool.get(entry.tool) ?? new Set<string>(['action']);
    for (const property of facts.properties) fields.add(property);
    modelledFieldsByTool.set(entry.tool, fields);

    if (!tool.acceptsAction(entry.action)) {
      findings.push(
        finding(
          'wire-action-unadvertised',
          id,
          'action',
          canonicalJson(tool.advertisedActions),
          entry.action,
          `action '${id}' is not accepted by the registered discriminator for tool '${entry.tool}' — a client following the compiled contract would be rejected by the real server`,
        ),
      );
      continue;
    }

    for (const rejected of tool.rejectsFields(entry.action, facts.properties)) {
      findings.push(
        finding(
          'wire-field-rejected',
          id,
          `inputSchema.properties.${rejected}`,
          '<accepted by the registered strict schema>',
          rejected,
          `action '${id}' advertises input field '${rejected}', which the registered strict schema for tool '${entry.tool}' rejects as unrecognized`,
        ),
      );
    }

    const expectedLine = expectedSignatureLine(entry);
    if (!tool.wireDescription.includes(expectedLine)) {
      findings.push(
        finding(
          'wire-signature-divergence',
          id,
          'inputSchema/description',
          '<a matching signature line in the tools/list description>',
          expectedLine,
          `action '${id}' does not match any signature line the running server publishes for tool '${entry.tool}'; the contract would advertise "${expectedLine}"`,
        ),
      );
    }

    const observed = tool.actions.get(entry.action);
    if (observed === undefined) {
      findings.push(
        finding(
          'wire-action-unadvertised',
          id,
          'action',
          '<described by the shipped describe surface>',
          entry.action,
          `action '${id}' is not described by the shipped describe surface for tool '${entry.tool}'`,
        ),
      );
    } else {
      findings.push(...auditAgainstDescribe(entry, observed));
    }

    findings.push(...auditCoherence(entry));
  }

  for (const tool of surface.tools.values()) {
    const modelled = modelledByTool.get(tool.tool) ?? new Set<string>();
    for (const advertised of tool.advertisedActions) {
      if (modelled.has(advertised)) continue;
      findings.push(
        finding(
          'wire-action-unmodelled',
          `${tool.tool}.${advertised}`,
          'actions',
          advertised,
          '<absent from the meta-model>',
          `tool '${tool.tool}' advertises action '${advertised}' over the wire, but the meta-model has no entry for it`,
        ),
      );
    }
    const modelledFields = modelledFieldsByTool.get(tool.tool) ?? new Set<string>(['action']);
    for (const property of tool.wireInputProperties) {
      if (modelledFields.has(property)) continue;
      findings.push(
        finding(
          'wire-field-unmodelled',
          `${tool.tool}.<tool>`,
          `inputSchema.properties.${property}`,
          property,
          '<absent from every entry of this tool>',
          `tool '${tool.tool}' publishes input property '${property}', which no meta-model entry for that tool advertises`,
        ),
      );
    }
  }

  return sortFindings(findings);
}

/** Convenience: observe the live surface and audit `metaModel` against it. */
export async function auditMetaModelAgainstRuntime(
  metaModel: MetaModel,
  registry: readonly CompositeTool[] = TOOL_REGISTRY,
): Promise<readonly MetaModelFinding[]> {
  return auditMetaModel(metaModel, await observeRuntimeSurface(registry));
}

export const CONTRACT_DRIFT_KINDS = ['wrong-meta-model', 'stale-baseline'] as const;
export type ContractDriftKind = (typeof CONTRACT_DRIFT_KINDS)[number];

/** Remedy for a baseline that no longer matches a fresh compile. */
export const REGENERATE_BASELINE_REMEDY =
  'stale baseline — regenerate the checked-in proof fixtures: `npx tsx src/contract/compiler/generate.ts`, then review the diff';

/** Remedy for a meta-model that disagrees with the shipped runtime surface. */
export const FIX_META_MODEL_REMEDY =
  'wrong meta-model — the compiler input disagrees with the shipped runtime surface; fix the projection in contract/compiler/meta-model.ts (or the registry declaration it projects). Regenerating the baseline will NOT clear this';

export interface ContractDriftVerdict {
  readonly ok: boolean;
  /** The conditions that hold. It is empty when the contract is clean. */
  readonly kinds: readonly ContractDriftKind[];
  readonly findings: readonly MetaModelFinding[];
  readonly baselineMatchesFreshCompile: boolean;
  /** One remedy per condition, in `kinds` order. Distinct per condition. */
  readonly remedies: readonly string[];
  readonly report: string;
}

/**
 * Separates a stale baseline from a wrong meta-model. A wrong meta-model usually makes the
 * baseline stale too, so a baseline mismatch alone is ambiguous. The findings resolve it, because a
 * regenerated baseline does not clear them.
 */
export function classifyContractDrift(input: {
  readonly findings: readonly MetaModelFinding[];
  readonly baselineMatchesFreshCompile: boolean;
}): ContractDriftVerdict {
  const kinds: ContractDriftKind[] = [];
  const remedies: string[] = [];

  if (input.findings.length > 0) {
    kinds.push('wrong-meta-model');
    remedies.push(FIX_META_MODEL_REMEDY);
  }
  if (!input.baselineMatchesFreshCompile) {
    kinds.push('stale-baseline');
    remedies.push(REGENERATE_BASELINE_REMEDY);
  }

  const ok = kinds.length === 0;
  const report = ok
    ? 'contract drift OK — the meta-model agrees with the shipped runtime surface and the checked-in baseline matches a fresh compile'
    : `contract drift DETECTED — ${kinds.join(' + ')}\n` +
      remedies.map((r) => `  remedy: ${r}`).join('\n') +
      (input.findings.length > 0
        ? `\n${input.findings
            .map((f) => `  [${f.kind}/${f.provenance}] ${f.actionId} ${f.field}: ${f.message}`)
            .join('\n')}`
        : '');

  return {
    ok,
    kinds,
    findings: input.findings,
    baselineMatchesFreshCompile: input.baselineMatchesFreshCompile,
    remedies,
    report,
  };
}

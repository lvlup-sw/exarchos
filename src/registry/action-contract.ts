import { isBuiltInEventType } from '../events/schemas.js';
import { CAPABILITY_KEYS, type Capability } from '../runtime/agents/capabilities.js';
import { PLAN_DEPTH_GATE_NAMES } from '../workflow/plan-depth-policy.js';
import type { ResolvedGate } from '../workflow/phase-kind.js';
import { VERIFICATION_GATE_NAMES } from '../workflow/verification-policy.js';
import type { AutoEmissionRole } from './gate-metadata.js';

export const ACTION_RESOURCE_KINDS = ['stream', 'path', 'worktree', 'git-ref'] as const;
export type ActionResourceKind = (typeof ACTION_RESOURCE_KINDS)[number];

export const HOST_OBLIGATIONS = [
  'agent-spawn',
  'human-approval',
  'interactive-authentication',
  'host-ui',
] as const;
export type HostObligation = (typeof HOST_OBLIGATIONS)[number];

export const SYNTHESIS_LEGS = [
  'task-completion',
  'tests',
  'typecheck',
  'document',
  'stack',
] as const;
export type SynthesisLegName = (typeof SYNTHESIS_LEGS)[number];

export const POSTCONDITION_SOURCES = ['durable-evidence', 'event-append'] as const;
export const POSTCONDITION_WHEN = ['success', 'failure', 'always'] as const;
export const EXECUTION_FRAMES = ['single-machine'] as const;
export const AGENT_SPAWN_CAPABILITY = 'subagent:spawn' as const;

export type DeclaredSet<T> =
  | { readonly kind: 'declared'; readonly values: readonly [T, ...T[]] }
  | { readonly kind: 'none'; readonly because: string };

export interface ActionResource {
  readonly kind: ActionResourceKind;
  readonly selector: string;
}

export type ActionRequirement =
  | ResolvedGate
  | { readonly kind: 'approvals'; readonly minimum: number }
  | { readonly kind: 'corroboration'; readonly minimum: number };

export type ActionPostcondition =
  | {
      readonly source: 'durable-evidence';
      readonly when: (typeof POSTCONDITION_WHEN)[number];
      readonly evidenceType: string;
    }
  | {
      readonly source: 'event-append';
      readonly when: (typeof POSTCONDITION_WHEN)[number];
      readonly event: string;
    };

export interface ActionEmission {
  readonly event: string;
  readonly condition: 'always' | 'conditional';
  readonly owner: string;
  readonly role: AutoEmissionRole;
  readonly recoveryExpiresAt?: string;
  readonly description?: string;
}

export type ExecutionAuthority =
  | { readonly kind: 'local' }
  | { readonly kind: 'host'; readonly obligation: HostObligation };

export type ReplayPolicy =
  | { readonly kind: 'safe-repeat' }
  | { readonly kind: 'claim-required'; readonly scope: 'stream-subject-request' }
  | { readonly kind: 'reject-replay'; readonly because: string };

export interface ActionContract {
  readonly requires: DeclaredSet<ActionRequirement>;
  readonly ensures: DeclaredSet<ActionPostcondition>;
  readonly needs: DeclaredSet<Capability>;
  readonly touches: {
    readonly frame: 'single-machine';
    readonly resources: DeclaredSet<ActionResource>;
  };
  readonly executionAuthority: ExecutionAuthority;
  readonly replay: ReplayPolicy;
  readonly emissions: DeclaredSet<ActionEmission>;
}

export type ActionContractErrorCode =
  | 'EMPTY_DECLARED_SET'
  | 'BLANK_ABSTENTION'
  | 'FREEZE_TIME_REQUIREMENT_ID'
  | 'UNKNOWN_RESOURCE_KIND'
  | 'EMPTY_RESOURCE_SELECTOR'
  | 'UNKNOWN_CAPABILITY'
  | 'AGENT_SPAWN_REQUIRES_SUBAGENT_SPAWN'
  | 'LOCAL_AND_HOST_MUTUALLY_EXCLUSIVE'
  | 'UNKNOWN_HOST_OBLIGATION'
  | 'UNKNOWN_EVENT'
  | 'INVALID_EMISSION'
  | 'INVALID_REQUIREMENT'
  | 'INVALID_POSTCONDITION'
  | 'INVALID_REPLAY'
  | 'INVALID_TOUCHES'
  | 'INVALID_FRAME'
  | 'REPLAY_ANNOTATION_DISAGREEMENT'
  | 'MISSING_DIMENSION';

export class ActionContractError extends Error {
  readonly code: ActionContractErrorCode;

  constructor(code: ActionContractErrorCode, message: string) {
    super(message);
    this.name = 'ActionContractError';
    this.code = code;
  }
}

export interface NormalizeActionContractOptions {
  readonly annotations?: { readonly idempotent: boolean };
  readonly now?: Date;
}

const LADDER_GATES = new Set<string>(VERIFICATION_GATE_NAMES);
const PLAN_GATES = new Set<string>(PLAN_DEPTH_GATE_NAMES);
const SYNTHESIS_GATE_SET = new Set<string>(SYNTHESIS_LEGS);
const RESOURCE_KIND_SET = new Set<string>(ACTION_RESOURCE_KINDS);
const HOST_OBLIGATION_SET = new Set<string>(HOST_OBLIGATIONS);
const POSTCONDITION_SOURCE_SET = new Set<string>(POSTCONDITION_SOURCES);
const POSTCONDITION_WHEN_SET = new Set<string>(POSTCONDITION_WHEN);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function requireNonEmptyReason(because: unknown, dimension: string): string {
  if (typeof because !== 'string' || because.trim().length === 0) {
    throw new ActionContractError(
      'BLANK_ABSTENTION',
      `${dimension} abstention requires a non-empty because`,
    );
  }
  return because.trim();
}

function rejectFreezeTimeRequirementId(value: unknown): void {
  if (typeof value === 'string') {
    throw new ActionContractError(
      'FREEZE_TIME_REQUIREMENT_ID',
      'requires must be obligation discriminants, not freeze-time requirement ids',
    );
  }
  if (isRecord(value) && 'requirementId' in value) {
    throw new ActionContractError(
      'FREEZE_TIME_REQUIREMENT_ID',
      'requires must be obligation discriminants, not freeze-time requirement ids',
    );
  }
}

function normalizeDeclaredSet<T>(
  value: unknown,
  dimension: string,
  normalizeValue: (item: unknown, index: number) => T,
  compare: (left: T, right: T) => number,
  keyOf: (item: T) => string,
): DeclaredSet<T> {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new ActionContractError('MISSING_DIMENSION', `${dimension} must be a declared set or reasoned none`);
  }
  if (value.kind === 'none') {
    return { kind: 'none', because: requireNonEmptyReason(value.because, dimension) };
  }
  if (value.kind !== 'declared') {
    throw new ActionContractError('MISSING_DIMENSION', `${dimension} must be a declared set or reasoned none`);
  }
  if (!Array.isArray(value.values) || value.values.length === 0) {
    throw new ActionContractError(
      'EMPTY_DECLARED_SET',
      `${dimension} declared values must be a non-empty array`,
    );
  }
  const normalized = value.values.map((item, index) => normalizeValue(item, index));
  const unique = new Map<string, T>();
  for (const item of normalized) {
    unique.set(keyOf(item), item);
  }
  const values = [...unique.values()].sort(compare);
  if (values.length === 0) {
    throw new ActionContractError(
      'EMPTY_DECLARED_SET',
      `${dimension} declared values must be a non-empty array`,
    );
  }
  return { kind: 'declared', values: values as [T, ...T[]] };
}

function requirementKey(requirement: ActionRequirement): string {
  if ('family' in requirement) {
    return `gate:${requirement.family}:${requirement.gate}`;
  }
  return `${requirement.kind}:${requirement.minimum}`;
}

function compareRequirements(left: ActionRequirement, right: ActionRequirement): number {
  return requirementKey(left).localeCompare(requirementKey(right));
}

function normalizeRequirement(value: unknown): ActionRequirement {
  rejectFreezeTimeRequirementId(value);
  if (!isRecord(value)) {
    throw new ActionContractError('INVALID_REQUIREMENT', 'requirement must be an obligation discriminant');
  }
  if (value.kind === 'approvals' || value.kind === 'corroboration') {
    if (typeof value.minimum !== 'number' || !Number.isInteger(value.minimum) || value.minimum < 1) {
      throw new ActionContractError(
        'INVALID_REQUIREMENT',
        `${value.kind} minimum must be a positive integer`,
      );
    }
    if (value.kind === 'corroboration' && value.minimum < 2) {
      throw new ActionContractError(
        'INVALID_REQUIREMENT',
        'corroboration minimum must be at least 2',
      );
    }
    return { kind: value.kind, minimum: value.minimum };
  }
  if (
    value.family === 'ladder' ||
    value.family === 'plan' ||
    value.family === 'review' ||
    value.family === 'synthesis'
  ) {
    if (!nonEmptyString(value.gate)) {
      throw new ActionContractError('INVALID_REQUIREMENT', 'resolved gate must name a non-empty gate');
    }
    const gate = value.gate.trim();
    if (value.family === 'ladder' && !LADDER_GATES.has(gate)) {
      throw new ActionContractError('INVALID_REQUIREMENT', `unknown ladder gate '${gate}'`);
    }
    if (value.family === 'plan' && !PLAN_GATES.has(gate)) {
      throw new ActionContractError('INVALID_REQUIREMENT', `unknown plan gate '${gate}'`);
    }
    if (value.family === 'synthesis' && !SYNTHESIS_GATE_SET.has(gate)) {
      throw new ActionContractError('INVALID_REQUIREMENT', `unknown synthesis leg '${gate}'`);
    }
    return { family: value.family, gate } as ResolvedGate;
  }
  throw new ActionContractError(
    'INVALID_REQUIREMENT',
    'requirement must be a resolved gate or an approvals/corroboration minimum',
  );
}

function postconditionKey(postcondition: ActionPostcondition): string {
  if (postcondition.source === 'durable-evidence') {
    return `durable-evidence:${postcondition.when}:${postcondition.evidenceType}`;
  }
  return `event-append:${postcondition.when}:${postcondition.event}`;
}

function comparePostconditions(left: ActionPostcondition, right: ActionPostcondition): number {
  return postconditionKey(left).localeCompare(postconditionKey(right));
}

function normalizePostcondition(value: unknown): ActionPostcondition {
  if (!isRecord(value) || typeof value.source !== 'string' || !POSTCONDITION_SOURCE_SET.has(value.source)) {
    throw new ActionContractError(
      'INVALID_POSTCONDITION',
      'ensure source must be durable-evidence or event-append',
    );
  }
  if (typeof value.when !== 'string' || !POSTCONDITION_WHEN_SET.has(value.when)) {
    throw new ActionContractError(
      'INVALID_POSTCONDITION',
      'ensure when must be success, failure, or always',
    );
  }
  const when = value.when as ActionPostcondition['when'];
  if (value.source === 'durable-evidence') {
    if (!nonEmptyString(value.evidenceType)) {
      throw new ActionContractError('INVALID_POSTCONDITION', 'durable-evidence ensure needs a non-empty evidenceType');
    }
    return { source: 'durable-evidence', when, evidenceType: value.evidenceType.trim() };
  }
  if (!nonEmptyString(value.event)) {
    throw new ActionContractError('INVALID_POSTCONDITION', 'event-append ensure needs a non-empty event');
  }
  const event = value.event.trim();
  if (!isBuiltInEventType(event)) {
    throw new ActionContractError('UNKNOWN_EVENT', `ensure event '${event}' is not in the emission catalog`);
  }
  return { source: 'event-append', when, event };
}

function normalizeCapability(value: unknown): Capability {
  if (typeof value !== 'string' || !CAPABILITY_KEYS.has(value as Capability)) {
    throw new ActionContractError(
      'UNKNOWN_CAPABILITY',
      `needs must use the closed capability vocabulary; '${String(value)}' is unknown`,
    );
  }
  return value as Capability;
}

function resourceKey(resource: ActionResource): string {
  return `${resource.kind}:${resource.selector}`;
}

function compareResources(left: ActionResource, right: ActionResource): number {
  return resourceKey(left).localeCompare(resourceKey(right));
}

function normalizeResource(value: unknown): ActionResource {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new ActionContractError('UNKNOWN_RESOURCE_KIND', 'resource must declare a kind and selector');
  }
  if (!RESOURCE_KIND_SET.has(value.kind)) {
    throw new ActionContractError(
      'UNKNOWN_RESOURCE_KIND',
      `resource kind '${value.kind}' is not stream, path, worktree, or git-ref`,
    );
  }
  if (!nonEmptyString(value.selector)) {
    throw new ActionContractError('EMPTY_RESOURCE_SELECTOR', 'resource selector must be a non-empty string');
  }
  return { kind: value.kind as ActionResourceKind, selector: value.selector.trim() };
}

function emissionKey(emission: ActionEmission): string {
  return `${emission.event}:${emission.role}:${emission.condition}:${emission.owner}`;
}

function compareEmissions(left: ActionEmission, right: ActionEmission): number {
  return emissionKey(left).localeCompare(emissionKey(right));
}

function normalizeEmission(value: unknown, now: Date): ActionEmission {
  if (!isRecord(value)) {
    throw new ActionContractError('INVALID_EMISSION', 'emission must be an object');
  }
  if (!nonEmptyString(value.event)) {
    throw new ActionContractError('INVALID_EMISSION', 'emission event must be a non-empty catalog name');
  }
  const event = value.event.trim();
  if (!isBuiltInEventType(event)) {
    throw new ActionContractError('UNKNOWN_EVENT', `emission event '${event}' is not in the emission catalog`);
  }
  if (value.condition !== 'always' && value.condition !== 'conditional') {
    throw new ActionContractError('INVALID_EMISSION', 'emission condition must be always or conditional');
  }
  if (!nonEmptyString(value.owner)) {
    throw new ActionContractError('INVALID_EMISSION', 'emission owner must be a non-empty string');
  }
  if (value.role !== 'primary' && value.role !== 'recovery') {
    throw new ActionContractError('INVALID_EMISSION', 'emission role must be primary or recovery');
  }
  const description = nonEmptyString(value.description) ? value.description.trim() : undefined;
  if (value.role === 'primary') {
    if (value.recoveryExpiresAt !== undefined) {
      throw new ActionContractError('INVALID_EMISSION', 'primary emissions must not carry recoveryExpiresAt');
    }
    return {
      event,
      condition: value.condition,
      owner: value.owner.trim(),
      role: 'primary',
      ...(description === undefined ? {} : { description }),
    };
  }
  if (!nonEmptyString(value.recoveryExpiresAt)) {
    throw new ActionContractError('INVALID_EMISSION', 'recovery emissions require a future recoveryExpiresAt');
  }
  const expiry = new Date(value.recoveryExpiresAt);
  if (Number.isNaN(expiry.getTime())) {
    throw new ActionContractError(
      'INVALID_EMISSION',
      `recoveryExpiresAt '${value.recoveryExpiresAt}' is not a valid timestamp`,
    );
  }
  if (expiry.getTime() <= now.getTime()) {
    throw new ActionContractError(
      'INVALID_EMISSION',
      `recovery edge for '${event}' expired at ${value.recoveryExpiresAt}`,
    );
  }
  return {
    event,
    condition: value.condition,
    owner: value.owner.trim(),
    role: 'recovery',
    recoveryExpiresAt: value.recoveryExpiresAt.trim(),
    ...(description === undefined ? {} : { description }),
  };
}

function normalizeTouches(value: unknown): ActionContract['touches'] {
  if (!isRecord(value)) {
    throw new ActionContractError('INVALID_TOUCHES', 'touches must declare frame and resources');
  }
  if (value.frame !== 'single-machine') {
    throw new ActionContractError('INVALID_FRAME', 'touches.frame must be single-machine');
  }
  return {
    frame: 'single-machine',
    resources: normalizeDeclaredSet(
      value.resources,
      'touches.resources',
      (item) => normalizeResource(item),
      compareResources,
      resourceKey,
    ),
  };
}

function normalizeExecutionAuthority(value: unknown): ExecutionAuthority {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new ActionContractError(
      'LOCAL_AND_HOST_MUTUALLY_EXCLUSIVE',
      'executionAuthority must be local or host',
    );
  }
  if (value.kind === 'local') {
    if ('obligation' in value && value.obligation !== undefined) {
      throw new ActionContractError(
        'LOCAL_AND_HOST_MUTUALLY_EXCLUSIVE',
        'a local action cannot also claim a host obligation',
      );
    }
    return { kind: 'local' };
  }
  if (value.kind === 'host') {
    if (typeof value.obligation !== 'string' || !HOST_OBLIGATION_SET.has(value.obligation)) {
      throw new ActionContractError(
        'UNKNOWN_HOST_OBLIGATION',
        `host obligation '${String(value.obligation)}' is not in the closed host set`,
      );
    }
    return { kind: 'host', obligation: value.obligation as HostObligation };
  }
  throw new ActionContractError(
    'LOCAL_AND_HOST_MUTUALLY_EXCLUSIVE',
    'executionAuthority must be local or host, not both or neither',
  );
}

function normalizeReplay(value: unknown): ReplayPolicy {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new ActionContractError('INVALID_REPLAY', 'replay must be safe-repeat, claim-required, or reject-replay');
  }
  if (value.kind === 'safe-repeat') {
    return { kind: 'safe-repeat' };
  }
  if (value.kind === 'claim-required') {
    if (value.scope !== 'stream-subject-request') {
      throw new ActionContractError(
        'INVALID_REPLAY',
        'claim-required replay must use stream-subject-request scope',
      );
    }
    return { kind: 'claim-required', scope: 'stream-subject-request' };
  }
  if (value.kind === 'reject-replay') {
    return { kind: 'reject-replay', because: requireNonEmptyReason(value.because, 'replay') };
  }
  throw new ActionContractError('INVALID_REPLAY', 'replay must be safe-repeat, claim-required, or reject-replay');
}

function assertReplayAnnotationCoherence(
  replay: ReplayPolicy,
  annotations: { readonly idempotent: boolean } | undefined,
): void {
  if (annotations === undefined) {
    return;
  }
  if (replay.kind === 'safe-repeat' && annotations.idempotent !== true) {
    throw new ActionContractError(
      'REPLAY_ANNOTATION_DISAGREEMENT',
      'safe-repeat replay requires annotations.idempotent to be true',
    );
  }
  if (replay.kind !== 'safe-repeat' && annotations.idempotent === true) {
    throw new ActionContractError(
      'REPLAY_ANNOTATION_DISAGREEMENT',
      `${replay.kind} replay cannot claim annotations.idempotent`,
    );
  }
}

function assertAgentSpawnCapability(
  authority: ExecutionAuthority,
  needs: DeclaredSet<Capability>,
): void {
  if (authority.kind !== 'host' || authority.obligation !== 'agent-spawn') {
    return;
  }
  const hasSpawn =
    needs.kind === 'declared' && needs.values.includes(AGENT_SPAWN_CAPABILITY);
  if (!hasSpawn) {
    throw new ActionContractError(
      'AGENT_SPAWN_REQUIRES_SUBAGENT_SPAWN',
      'agent-spawn host obligation requires needs to declare subagent:spawn',
    );
  }
}

export function none(because: string): { readonly kind: 'none'; readonly because: string } {
  return { kind: 'none', because: requireNonEmptyReason(because, 'dimension') };
}

export function declared<T>(first: T, ...rest: readonly T[]): { readonly kind: 'declared'; readonly values: readonly [T, ...T[]] } {
  return { kind: 'declared', values: [first, ...rest] };
}

export function actionContractCanonicalBytes(contract: ActionContract): string {
  return JSON.stringify(contract);
}

export function normalizeActionContract(
  input: unknown,
  options: NormalizeActionContractOptions = {},
): ActionContract {
  if (!isRecord(input)) {
    throw new ActionContractError('MISSING_DIMENSION', 'actionContract must be an object');
  }
  const now = options.now ?? new Date();
  const requires = normalizeDeclaredSet(
    input.requires,
    'requires',
    (item) => normalizeRequirement(item),
    compareRequirements,
    requirementKey,
  );
  const ensures = normalizeDeclaredSet(
    input.ensures,
    'ensures',
    (item) => normalizePostcondition(item),
    comparePostconditions,
    postconditionKey,
  );
  const needs = normalizeDeclaredSet(
    input.needs,
    'needs',
    (item) => normalizeCapability(item),
    (left, right) => left.localeCompare(right),
    (capability) => capability,
  );
  const touches = normalizeTouches(input.touches);
  const executionAuthority = normalizeExecutionAuthority(input.executionAuthority);
  const replay = normalizeReplay(input.replay);
  const emissions = normalizeDeclaredSet(
    input.emissions,
    'emissions',
    (item) => normalizeEmission(item, now),
    compareEmissions,
    emissionKey,
  );
  assertAgentSpawnCapability(executionAuthority, needs);
  assertReplayAnnotationCoherence(replay, options.annotations);
  return {
    requires,
    ensures,
    needs,
    touches,
    executionAuthority,
    replay,
    emissions,
  };
}

export function withActionContract<T extends object>(
  action: T,
  contract: unknown,
  options: NormalizeActionContractOptions = {},
): T & { readonly actionContract: ActionContract } {
  return {
    ...action,
    actionContract: normalizeActionContract(contract, options),
  };
}

/**
 * ActionId-scoped closure over a declared action contract and its projections.
 *
 * The evaluator reports whether one action's contract is total: every dimension
 * is present or reasoned-absent, every reference is live, recovery edges have
 * not expired, and advertised / executed / projected copies still match the
 * declaration. It does not choose phase verbs and it does not mint tools or
 * capabilities — those vocabularies stay closed.
 *
 * Findings are collected then sorted, so subject order cannot change the
 * verdict. Zero subjects is an empty denominator and never closes.
 */

import { isBuiltInEventType } from '../events/schemas.js';
import { ACTION_RESOURCE_KINDS, HOST_OBLIGATIONS } from '../registry.js';
import { CAPABILITY_KEYS } from '../runtime/agents/capabilities.js';
import { canonicalJson } from './request-context.js';

export const ACTION_CONTRACT_CLOSURE_DIMENSIONS = [
  'requires',
  'ensures',
  'needs',
  'touches',
  'executionAuthority',
  'replay',
  'emissions',
] as const;

export type ActionContractClosureDimension =
  (typeof ACTION_CONTRACT_CLOSURE_DIMENSIONS)[number];

export const ACTION_CONTRACT_CLOSURE_CODES = [
  'OMITTED_DIMENSION',
  'BLANK_ABSTENTION',
  'STALE_REFERENCE',
  'ROLE_EXPIRY_CONFLICT',
  'ORPHAN_PROJECTION',
  'PROJECTION_DRIFT',
  'EMPTY_DENOMINATOR',
  'PARITY_DISAGREEMENT',
] as const;

export type ActionContractClosureCode = (typeof ACTION_CONTRACT_CLOSURE_CODES)[number];

export interface ActionContractClosureFinding {
  readonly code: ActionContractClosureCode;
  readonly actionId: string;
  readonly dimension?: string;
  readonly message: string;
}

export interface ActionContractProjectionInput {
  readonly name: string;
  readonly contract?: unknown;
}

export interface ActionContractClosureSubject {
  readonly actionId: string;
  readonly contract?: unknown;
  readonly projections?: readonly ActionContractProjectionInput[];
  readonly advertised?: unknown;
  readonly executed?: unknown;
}

export interface ActionContractClosureInput {
  readonly subjects: readonly ActionContractClosureSubject[];
  readonly now?: Date;
  readonly knownEvents?: ReadonlySet<string>;
  readonly knownCapabilities?: ReadonlySet<string>;
}

export interface ActionContractClosureResult {
  readonly closed: boolean;
  readonly subjectCount: number;
  readonly findings: readonly ActionContractClosureFinding[];
}

const RESOURCE_KIND_SET = new Set<string>(ACTION_RESOURCE_KINDS);
const HOST_OBLIGATION_SET = new Set<string>(HOST_OBLIGATIONS);
const REQUIREMENT_FAMILIES = new Set(['ladder', 'plan', 'review', 'synthesis']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function finding(
  code: ActionContractClosureCode,
  actionId: string,
  message: string,
  dimension?: string,
): ActionContractClosureFinding {
  return dimension === undefined ? { code, actionId, message } : { code, actionId, dimension, message };
}

function compareFindings(left: ActionContractClosureFinding, right: ActionContractClosureFinding): number {
  return (
    left.code.localeCompare(right.code) ||
    left.actionId.localeCompare(right.actionId) ||
    (left.dimension ?? '').localeCompare(right.dimension ?? '') ||
    left.message.localeCompare(right.message)
  );
}

function findingKey(item: ActionContractClosureFinding): string {
  return `${item.code}\0${item.actionId}\0${item.dimension ?? ''}\0${item.message}`;
}

function sortFindings(
  findings: readonly ActionContractClosureFinding[],
): readonly ActionContractClosureFinding[] {
  const unique = new Map<string, ActionContractClosureFinding>();
  for (const item of findings) {
    unique.set(findingKey(item), item);
  }
  return [...unique.values()].sort(compareFindings);
}

function eventKnown(event: string, known: ReadonlySet<string> | undefined): boolean {
  return known === undefined ? isBuiltInEventType(event) : known.has(event);
}

function capabilityKnown(capability: string, known: ReadonlySet<string> | undefined): boolean {
  return known === undefined ? CAPABILITY_KEYS.has(capability as never) : known.has(capability);
}

function inspectDeclaredSet(
  value: unknown,
  actionId: string,
  dimension: string,
  inspectItem: (item: unknown, index: number) => void,
  findings: ActionContractClosureFinding[],
): void {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    findings.push(
      finding(
        'OMITTED_DIMENSION',
        actionId,
        `action '${actionId}' omitted contract dimension '${dimension}'`,
        dimension,
      ),
    );
    return;
  }
  if (value.kind === 'none') {
    if (!nonEmptyString(value.because)) {
      findings.push(
        finding(
          'BLANK_ABSTENTION',
          actionId,
          `action '${actionId}' abstained from '${dimension}' without a non-empty because`,
          dimension,
        ),
      );
    }
    return;
  }
  if (value.kind !== 'declared' || !Array.isArray(value.values) || value.values.length === 0) {
    findings.push(
      finding(
        'OMITTED_DIMENSION',
        actionId,
        `action '${actionId}' omitted contract dimension '${dimension}'`,
        dimension,
      ),
    );
    return;
  }
  value.values.forEach((item, index) => inspectItem(item, index));
}

function inspectRequirement(
  value: unknown,
  actionId: string,
  findings: ActionContractClosureFinding[],
): void {
  if (typeof value === 'string' || (isRecord(value) && 'requirementId' in value)) {
    findings.push(
      finding(
        'STALE_REFERENCE',
        actionId,
        `action '${actionId}' requires a freeze-time requirement id instead of an obligation discriminant`,
        'requires',
      ),
    );
    return;
  }
  if (!isRecord(value)) {
    findings.push(
      finding(
        'STALE_REFERENCE',
        actionId,
        `action '${actionId}' requires a value that is not an obligation discriminant`,
        'requires',
      ),
    );
    return;
  }
  if (value.kind === 'approvals' || value.kind === 'corroboration') {
    if (typeof value.minimum !== 'number' || !Number.isInteger(value.minimum) || value.minimum < 1) {
      findings.push(
        finding(
          'STALE_REFERENCE',
          actionId,
          `action '${actionId}' requires ${value.kind} with a stale minimum`,
          'requires',
        ),
      );
    }
    return;
  }
  if (typeof value.family === 'string' && REQUIREMENT_FAMILIES.has(value.family)) {
    if (!nonEmptyString(value.gate)) {
      findings.push(
        finding(
          'STALE_REFERENCE',
          actionId,
          `action '${actionId}' requires a gate without a live name`,
          'requires',
        ),
      );
    }
    return;
  }
  findings.push(
    finding(
      'STALE_REFERENCE',
      actionId,
      `action '${actionId}' requires an obligation the closed vocabulary does not name`,
      'requires',
    ),
  );
}

function inspectPostcondition(
  value: unknown,
  actionId: string,
  knownEvents: ReadonlySet<string> | undefined,
  findings: ActionContractClosureFinding[],
): void {
  if (!isRecord(value) || typeof value.source !== 'string') {
    findings.push(
      finding(
        'STALE_REFERENCE',
        actionId,
        `action '${actionId}' ensures a postcondition that is not a known source`,
        'ensures',
      ),
    );
    return;
  }
  if (value.source === 'event-append') {
    if (!nonEmptyString(value.event) || !eventKnown(value.event, knownEvents)) {
      findings.push(
        finding(
          'STALE_REFERENCE',
          actionId,
          `action '${actionId}' ensures event '${String(value.event)}' which is not in the catalog`,
          'ensures',
        ),
      );
    }
  }
}

function inspectResource(value: unknown, actionId: string, findings: ActionContractClosureFinding[]): void {
  if (!isRecord(value) || typeof value.kind !== 'string' || !RESOURCE_KIND_SET.has(value.kind)) {
    findings.push(
      finding(
        'STALE_REFERENCE',
        actionId,
        `action '${actionId}' touches a resource kind that is not in the closed set`,
        'touches',
      ),
    );
  }
}

function inspectEmission(
  value: unknown,
  actionId: string,
  now: Date,
  knownEvents: ReadonlySet<string> | undefined,
  findings: ActionContractClosureFinding[],
): void {
  if (!isRecord(value)) {
    findings.push(
      finding(
        'STALE_REFERENCE',
        actionId,
        `action '${actionId}' emits a value that is not an emission`,
        'emissions',
      ),
    );
    return;
  }
  if (!nonEmptyString(value.event) || !eventKnown(value.event, knownEvents)) {
    findings.push(
      finding(
        'STALE_REFERENCE',
        actionId,
        `action '${actionId}' emits '${String(value.event)}' which is not in the catalog`,
        'emissions',
      ),
    );
  }
  if (value.role === 'primary') {
    if (value.recoveryExpiresAt !== undefined) {
      findings.push(
        finding(
          'ROLE_EXPIRY_CONFLICT',
          actionId,
          `action '${actionId}' gives a primary emission a recovery expiry`,
          'emissions',
        ),
      );
    }
    return;
  }
  if (value.role === 'recovery') {
    if (!nonEmptyString(value.recoveryExpiresAt)) {
      findings.push(
        finding(
          'ROLE_EXPIRY_CONFLICT',
          actionId,
          `action '${actionId}' recovery emission is missing a future recoveryExpiresAt`,
          'emissions',
        ),
      );
      return;
    }
    const expiry = new Date(value.recoveryExpiresAt);
    if (Number.isNaN(expiry.getTime()) || expiry.getTime() <= now.getTime()) {
      findings.push(
        finding(
          'ROLE_EXPIRY_CONFLICT',
          actionId,
          `action '${actionId}' recovery emission expired at ${value.recoveryExpiresAt}`,
          'emissions',
        ),
      );
    }
    return;
  }
  findings.push(
    finding(
      'STALE_REFERENCE',
      actionId,
      `action '${actionId}' emits with a role that is not primary or recovery`,
      'emissions',
    ),
  );
}

function inspectExecutionAuthority(
  value: unknown,
  actionId: string,
  findings: ActionContractClosureFinding[],
): void {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    findings.push(
      finding(
        'OMITTED_DIMENSION',
        actionId,
        `action '${actionId}' omitted contract dimension 'executionAuthority'`,
        'executionAuthority',
      ),
    );
    return;
  }
  if (value.kind === 'local') return;
  if (value.kind === 'host') {
    if (typeof value.obligation !== 'string' || !HOST_OBLIGATION_SET.has(value.obligation)) {
      findings.push(
        finding(
          'STALE_REFERENCE',
          actionId,
          `action '${actionId}' claims host obligation '${String(value.obligation)}' which is not in the closed host set`,
          'executionAuthority',
        ),
      );
    }
    return;
  }
  findings.push(
    finding(
      'STALE_REFERENCE',
      actionId,
      `action '${actionId}' executionAuthority '${value.kind}' is not local or host`,
      'executionAuthority',
    ),
  );
}

function inspectReplay(value: unknown, actionId: string, findings: ActionContractClosureFinding[]): void {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    findings.push(
      finding(
        'OMITTED_DIMENSION',
        actionId,
        `action '${actionId}' omitted contract dimension 'replay'`,
        'replay',
      ),
    );
    return;
  }
  if (value.kind === 'safe-repeat' || value.kind === 'claim-required') return;
  if (value.kind === 'reject-replay') {
    if (!nonEmptyString(value.because)) {
      findings.push(
        finding(
          'BLANK_ABSTENTION',
          actionId,
          `action '${actionId}' abstained from replay without a non-empty because`,
          'replay',
        ),
      );
    }
    return;
  }
  findings.push(
    finding(
      'STALE_REFERENCE',
      actionId,
      `action '${actionId}' replay '${value.kind}' is not a live replay policy`,
      'replay',
    ),
  );
}

function inspectTouches(value: unknown, actionId: string, findings: ActionContractClosureFinding[]): void {
  if (!isRecord(value)) {
    findings.push(
      finding(
        'OMITTED_DIMENSION',
        actionId,
        `action '${actionId}' omitted contract dimension 'touches'`,
        'touches',
      ),
    );
    return;
  }
  if (value.frame !== 'single-machine') {
    findings.push(
      finding(
        'STALE_REFERENCE',
        actionId,
        `action '${actionId}' touches frame '${String(value.frame)}' which is not single-machine`,
        'touches',
      ),
    );
  }
  inspectDeclaredSet(
    value.resources,
    actionId,
    'touches.resources',
    (item) => inspectResource(item, actionId, findings),
    findings,
  );
}

function inspectContract(
  contract: unknown,
  actionId: string,
  now: Date,
  knownEvents: ReadonlySet<string> | undefined,
  knownCapabilities: ReadonlySet<string> | undefined,
  findings: ActionContractClosureFinding[],
): void {
  if (!isRecord(contract)) {
    for (const dimension of ACTION_CONTRACT_CLOSURE_DIMENSIONS) {
      findings.push(
        finding(
          'OMITTED_DIMENSION',
          actionId,
          `action '${actionId}' omitted contract dimension '${dimension}'`,
          dimension,
        ),
      );
    }
    return;
  }

  for (const dimension of ACTION_CONTRACT_CLOSURE_DIMENSIONS) {
    if (dimension in contract) continue;
    findings.push(
      finding(
        'OMITTED_DIMENSION',
        actionId,
        `action '${actionId}' omitted contract dimension '${dimension}'`,
        dimension,
      ),
    );
  }

  if ('requires' in contract) {
    inspectDeclaredSet(
      contract.requires,
      actionId,
      'requires',
      (item) => inspectRequirement(item, actionId, findings),
      findings,
    );
  }
  if ('ensures' in contract) {
    inspectDeclaredSet(
      contract.ensures,
      actionId,
      'ensures',
      (item) => inspectPostcondition(item, actionId, knownEvents, findings),
      findings,
    );
  }
  if ('needs' in contract) {
    inspectDeclaredSet(
      contract.needs,
      actionId,
      'needs',
      (item) => {
        if (typeof item !== 'string' || !capabilityKnown(item, knownCapabilities)) {
          findings.push(
            finding(
              'STALE_REFERENCE',
              actionId,
              `action '${actionId}' needs capability '${String(item)}' which is not in the closed vocabulary`,
              'needs',
            ),
          );
        }
      },
      findings,
    );
  }
  if ('touches' in contract) {
    inspectTouches(contract.touches, actionId, findings);
  }
  if ('executionAuthority' in contract) {
    inspectExecutionAuthority(contract.executionAuthority, actionId, findings);
  }
  if ('replay' in contract) {
    inspectReplay(contract.replay, actionId, findings);
  }
  if ('emissions' in contract) {
    inspectDeclaredSet(
      contract.emissions,
      actionId,
      'emissions',
      (item) => inspectEmission(item, actionId, now, knownEvents, findings),
      findings,
    );
  }
}

function inspectProjections(
  subject: ActionContractClosureSubject,
  findings: ActionContractClosureFinding[],
): void {
  const projections = subject.projections ?? [];
  for (const projection of projections) {
    if (subject.contract === undefined) {
      findings.push(
        finding(
          'ORPHAN_PROJECTION',
          subject.actionId,
          `action '${subject.actionId}' projection '${projection.name}' has no declared contract`,
          projection.name,
        ),
      );
      continue;
    }
    if (projection.contract === undefined) {
      findings.push(
        finding(
          'PROJECTION_DRIFT',
          subject.actionId,
          `action '${subject.actionId}' projection '${projection.name}' dropped the declared contract`,
          projection.name,
        ),
      );
      continue;
    }
    if (canonicalJson(projection.contract) !== canonicalJson(subject.contract)) {
      findings.push(
        finding(
          'PROJECTION_DRIFT',
          subject.actionId,
          `action '${subject.actionId}' projection '${projection.name}' drifted from the declared contract`,
          projection.name,
        ),
      );
    }
  }
}

function inspectParity(subject: ActionContractClosureSubject, findings: ActionContractClosureFinding[]): void {
  if (subject.advertised === undefined && subject.executed === undefined) return;
  if (subject.advertised === undefined || subject.executed === undefined) {
    const present = subject.advertised === undefined ? 'executed' : 'advertised';
    findings.push(
      finding(
        'PARITY_DISAGREEMENT',
        subject.actionId,
        `action '${subject.actionId}' ${present} a contract the other surface did not`,
      ),
    );
    return;
  }
  if (canonicalJson(subject.advertised) !== canonicalJson(subject.executed)) {
    findings.push(
      finding(
        'PARITY_DISAGREEMENT',
        subject.actionId,
        `action '${subject.actionId}' advertised contract disagrees with the executed contract`,
      ),
    );
  }
}

/**
 * Evaluate ActionId-scoped contract closure. Pure and total: every input
 * yields a verdict, and equal subjects yield equal findings regardless of
 * the order they arrived in.
 */
export function evaluateActionContractClosure(
  input: ActionContractClosureInput,
): ActionContractClosureResult {
  const subjects = input.subjects;
  if (subjects.length === 0) {
    return {
      closed: false,
      subjectCount: 0,
      findings: [
        finding(
          'EMPTY_DENOMINATOR',
          '*',
          'action-contract closure over zero subjects proves nothing and cannot close',
        ),
      ],
    };
  }

  const now = input.now ?? new Date();
  const findings: ActionContractClosureFinding[] = [];
  const ordered = [...subjects].sort((left, right) => left.actionId.localeCompare(right.actionId));

  for (const subject of ordered) {
    inspectContract(subject.contract, subject.actionId, now, input.knownEvents, input.knownCapabilities, findings);
    inspectProjections(subject, findings);
    inspectParity(subject, findings);
  }

  const sorted = sortFindings(findings);
  return {
    closed: sorted.length === 0,
    subjectCount: subjects.length,
    findings: sorted,
  };
}

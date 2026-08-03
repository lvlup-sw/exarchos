import {
  AdmissionContradictionRecordedData,
  AdmissionEvidenceRecordedData,
  type AdmissionContradictionRecorded,
  type AdmissionEvidenceRecorded,
} from '../../event-store/schemas.js';
import type {
  AdmissionEvidenceV1,
  ContentDigestV1,
  EvidenceSubjectV1,
} from './types.js';

export type EvidenceSelectionDiagnosticCode =
  | 'MALFORMED_EVIDENCE'
  | 'DUPLICATE_EVIDENCE_ID'
  | 'MISSING_PREDECESSOR'
  | 'SCOPE_MISMATCH'
  | 'INCOMPATIBLE_POLICY_DIGEST'
  | 'CYCLIC_SUPERSESSION'
  | 'INVALID_PREDECESSOR'
  | 'MALFORMED_CONTRADICTION'
  | 'MISSING_CONTRADICTION_EVIDENCE'
  | 'CONTRADICTION_SCOPE_MISMATCH'
  /** Equivalent concurrent evidence collapsed onto one canonical active record. */
  | 'CONVERGED_EQUIVALENT_EVIDENCE';

export interface EvidenceSelectionDiagnostic {
  readonly code: EvidenceSelectionDiagnosticCode;
  readonly evidenceId?: string;
  readonly contradictionId?: string;
  readonly message: string;
}

export interface EvidenceSupersession {
  readonly evidenceId: string;
  readonly supersededByEvidenceId: string;
  /** Attribution is frozen on the superseding evidence record. */
  readonly producerId: string;
  readonly invocationId: string;
}

export interface EvidenceScope {
  readonly requirementId: string;
  readonly phaseAttemptId: string;
  readonly subject: EvidenceSubjectV1;
  readonly policyDigest: ContentDigestV1;
}

export type EvidenceStatement = 'satisfied' | 'unsatisfied' | 'indeterminate';

export type EvidenceContradiction =
  | (EvidenceScope & {
      readonly source: 'active-evidence';
      readonly evidenceIds: readonly string[];
      readonly statements: readonly EvidenceStatement[];
    })
  | (EvidenceScope & {
      readonly source: 'downstream-event';
      readonly contradictionId: string;
      readonly evidenceIds: readonly string[];
      readonly detectedAt: string;
    });

export interface EvidenceSelection {
  readonly activeEvidence: readonly AdmissionEvidenceRecorded[];
  readonly supersessions: readonly EvidenceSupersession[];
  readonly contradictions: readonly EvidenceContradiction[];
  readonly diagnostics: readonly EvidenceSelectionDiagnostic[];
}

export interface EvidenceSelectionInput {
  /** Unknown is intentional: projections must diagnose malformed historical facts. */
  readonly evidence: readonly unknown[];
  readonly contradictionEvents?: readonly unknown[];
}

function digestKey(digest: ContentDigestV1): string {
  return `${digest.algorithm}:${digest.value}`;
}

function subjectKey(subject: EvidenceSubjectV1): string {
  let identity: string;
  switch (subject.kind) {
    case 'workflow':
      identity = subject.workflowId;
      break;
    case 'phase-attempt':
      identity = subject.phaseAttemptId;
      break;
    case 'wave':
      identity = subject.waveId;
      break;
    case 'task':
      identity = subject.taskId;
      break;
    case 'commit':
      identity = subject.commitId;
      break;
    case 'diff':
      identity = subject.diffId;
      break;
    case 'artifact':
      identity = subject.artifactId;
      break;
  }
  return `${subject.kind}:${identity}:${digestKey(subject.digest)}`;
}

function scopeKey(evidence: AdmissionEvidenceV1): string {
  return [
    evidence.requirementId,
    subjectKey(evidence.subject),
    evidence.phaseAttemptId,
    digestKey(evidence.policyDigest),
  ].join('|');
}

function sameBaseScope(
  left: AdmissionEvidenceV1,
  right: AdmissionEvidenceV1,
): boolean {
  return (
    left.requirementId === right.requirementId &&
    left.phaseAttemptId === right.phaseAttemptId &&
    subjectKey(left.subject) === subjectKey(right.subject)
  );
}

function statementOf(evidence: AdmissionEvidenceV1): EvidenceStatement {
  if (evidence.kind === 'approval') {
    return evidence.verdict === 'approved' ? 'satisfied' : 'unsatisfied';
  }
  switch (evidence.verdict) {
    case 'pass':
      return 'satisfied';
    case 'fail':
      return 'unsatisfied';
    case 'indeterminate':
      return 'indeterminate';
  }
}

function inferId(input: unknown, field: string, nested?: string): string | undefined {
  if (input === null || typeof input !== 'object') return undefined;
  const container =
    nested === undefined
      ? input
      : (input as Record<string, unknown>)[nested];
  if (container === null || typeof container !== 'object') return undefined;
  const value = (container as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareDiagnostics(
  left: EvidenceSelectionDiagnostic,
  right: EvidenceSelectionDiagnostic,
): number {
  const leftKey = `${left.code}|${left.evidenceId ?? ''}|${left.contradictionId ?? ''}|${left.message}`;
  const rightKey = `${right.code}|${right.evidenceId ?? ''}|${right.contradictionId ?? ''}|${right.message}`;
  return compareText(leftKey, rightKey);
}

/**
 * Select active proof facts without clocks, mutable state, or replay order.
 *
 * Invalid chains are excluded and returned as diagnostics. The input arrays are
 * never mutated; callers retain the complete append-only history.
 */
export function selectEvidence(input: EvidenceSelectionInput): EvidenceSelection {
  const diagnostics: EvidenceSelectionDiagnostic[] = [];
  const parsedEvidence: AdmissionEvidenceRecorded[] = [];

  for (const candidate of input.evidence) {
    const parsed = AdmissionEvidenceRecordedData.safeParse(candidate);
    if (parsed.success) {
      parsedEvidence.push(parsed.data);
    } else {
      const evidenceId = inferId(candidate, 'evidenceId', 'evidence');
      diagnostics.push({
        code: 'MALFORMED_EVIDENCE',
        ...(evidenceId === undefined ? {} : { evidenceId }),
        message: 'evidence record does not satisfy the internal proof schema',
      });
    }
  }

  const recordsById = new Map<string, AdmissionEvidenceRecorded[]>();
  for (const record of parsedEvidence) {
    const id = record.evidence.evidenceId;
    const records = recordsById.get(id) ?? [];
    records.push(record);
    recordsById.set(id, records);
  }

  const invalid = new Set<string>();
  const uniqueById = new Map<string, AdmissionEvidenceRecorded>();
  for (const [id, records] of recordsById) {
    if (records.length !== 1) {
      invalid.add(id);
      diagnostics.push({
        code: 'DUPLICATE_EVIDENCE_ID',
        evidenceId: id,
        message: 'evidence identity occurs more than once',
      });
      continue;
    }
    const [only] = records;
    if (only !== undefined) uniqueById.set(id, only);
  }

  const predecessorById = new Map<string, string>();
  for (const [id, record] of uniqueById) {
    const predecessorId = record.supersedesEvidenceId;
    if (predecessorId === undefined) continue;
    predecessorById.set(id, predecessorId);

    const predecessor = uniqueById.get(predecessorId);
    if (predecessor === undefined || invalid.has(predecessorId)) {
      invalid.add(id);
      diagnostics.push({
        code: 'MISSING_PREDECESSOR',
        evidenceId: id,
        message: `declared predecessor ${predecessorId} is unavailable`,
      });
      continue;
    }
    if (!sameBaseScope(record.evidence, predecessor.evidence)) {
      invalid.add(id);
      diagnostics.push({
        code: 'SCOPE_MISMATCH',
        evidenceId: id,
        message: 'superseding evidence does not match predecessor requirement scope',
      });
      continue;
    }
    if (digestKey(record.evidence.policyDigest) !== digestKey(predecessor.evidence.policyDigest)) {
      invalid.add(id);
      diagnostics.push({
        code: 'INCOMPATIBLE_POLICY_DIGEST',
        evidenceId: id,
        message: 'superseding evidence uses a different policy digest',
      });
    }
  }

  const visitState = new Map<string, 'visiting' | 'visited'>();
  const stack: string[] = [];
  const cycleIds = new Set<string>();
  const visit = (id: string): void => {
    if (invalid.has(id) || visitState.get(id) === 'visited') return;
    if (visitState.get(id) === 'visiting') {
      const cycleStart = stack.indexOf(id);
      for (const cycleId of stack.slice(cycleStart)) cycleIds.add(cycleId);
      return;
    }

    visitState.set(id, 'visiting');
    stack.push(id);
    const predecessorId = predecessorById.get(id);
    if (predecessorId !== undefined && uniqueById.has(predecessorId)) {
      visit(predecessorId);
    }
    stack.pop();
    visitState.set(id, 'visited');
  };

  for (const id of [...uniqueById.keys()].sort()) visit(id);
  for (const id of [...cycleIds].sort()) {
    invalid.add(id);
    diagnostics.push({
      code: 'CYCLIC_SUPERSESSION',
      evidenceId: id,
      message: 'evidence participates in a supersession cycle',
    });
  }

  // A record cannot repair or bypass a malformed predecessor chain.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, predecessorId] of predecessorById) {
      if (!invalid.has(id) && invalid.has(predecessorId)) {
        invalid.add(id);
        changed = true;
        diagnostics.push({
          code: 'INVALID_PREDECESSOR',
          evidenceId: id,
          message: `declared predecessor ${predecessorId} is invalid`,
        });
      }
    }
  }

  const validRecords = [...uniqueById.entries()]
    .filter(([id]) => !invalid.has(id))
    .sort(([left], [right]) => compareText(left, right));
  const validById = new Map(validRecords);
  const supersededIds = new Set<string>();
  const supersessions: EvidenceSupersession[] = [];

  for (const [id, record] of validRecords) {
    const predecessorId = record.supersedesEvidenceId;
    if (predecessorId === undefined || !validById.has(predecessorId)) continue;
    supersededIds.add(predecessorId);
    supersessions.push({
      evidenceId: predecessorId,
      supersededByEvidenceId: id,
      producerId: record.evidence.producer.producerId,
      invocationId: record.evidence.producer.invocationId,
    });
  }

  supersessions.sort((left, right) =>
    compareText(
      `${left.evidenceId}|${left.supersededByEvidenceId}`,
      `${right.evidenceId}|${right.supersededByEvidenceId}`,
    ),
  );
  const activeEvidence = validRecords
    .filter(([id]) => !supersededIds.has(id))
    .map(([, record]) => record);

  const contradictions: EvidenceContradiction[] = [];
  const activeByScope = new Map<string, AdmissionEvidenceRecorded[]>();
  for (const record of activeEvidence) {
    const key = scopeKey(record.evidence);
    const scoped = activeByScope.get(key) ?? [];
    scoped.push(record);
    activeByScope.set(key, scoped);
  }

  // EFF-003 — equivalent concurrent operations converge on ONE canonical active
  // result. Two executions of the same logical gate under distinct operationIds
  // mint distinct evidenceIds, read history before either has appended, and both
  // land with no predecessor: neither supersedes the other, so the scope would
  // otherwise carry competing active chains.
  //
  // Convergence is the exact complement of the contradiction rule below. When a
  // scope's active records all make the SAME statement they agree, and admission
  // has one answer; keeping duplicates active would let an arbitrary one win by
  // arrival order. When they disagree, every record stays active and the
  // contradiction is reported — a disagreement must deny admission, never be
  // silently collapsed into whichever arrived first.
  //
  // The canonical record is the lowest evidenceId. `validRecords` is already
  // sorted by id, so the choice is independent of arrival order.
  const convergedIds = new Set<string>();

  for (const scoped of activeByScope.values()) {
    const statements = [
      ...new Set(scoped.map((record) => statementOf(record.evidence))),
    ].sort();
    if (statements.length < 2) {
      const [canonical, ...duplicates] = scoped;
      if (canonical !== undefined && duplicates.length > 0) {
        for (const duplicate of duplicates) {
          const duplicateId = duplicate.evidence.evidenceId;
          convergedIds.add(duplicateId);
          diagnostics.push({
            code: 'CONVERGED_EQUIVALENT_EVIDENCE',
            evidenceId: duplicateId,
            message:
              `equivalent concurrent evidence converged on canonical ` +
              `${canonical.evidence.evidenceId}`,
          });
        }
      }
      continue;
    }
    const [firstScoped] = scoped;
    if (firstScoped === undefined) continue;
    const first = firstScoped.evidence;
    contradictions.push({
      source: 'active-evidence',
      requirementId: first.requirementId,
      phaseAttemptId: first.phaseAttemptId,
      subject: first.subject,
      policyDigest: first.policyDigest,
      evidenceIds: scoped
        .map((record) => record.evidence.evidenceId)
        .sort(),
      statements,
    });
  }

  const canonicalActiveEvidence = activeEvidence.filter(
    (record) => !convergedIds.has(record.evidence.evidenceId),
  );

  for (const candidate of input.contradictionEvents ?? []) {
    const parsed = AdmissionContradictionRecordedData.safeParse(candidate);
    if (!parsed.success) {
      const contradictionId = inferId(candidate, 'contradictionId');
      diagnostics.push({
        code: 'MALFORMED_CONTRADICTION',
        ...(contradictionId === undefined ? {} : { contradictionId }),
        message: 'contradiction event does not satisfy the internal proof schema',
      });
      continue;
    }

    const contradiction = parsed.data;
    const evidenceIds = [...new Set(contradiction.evidenceIds)].sort();
    const referenced = evidenceIds.map((id) => validById.get(id));
    if (
      evidenceIds.length < 2 ||
      referenced.some((record) => record === undefined)
    ) {
      diagnostics.push({
        code: 'MISSING_CONTRADICTION_EVIDENCE',
        contradictionId: contradiction.contradictionId,
        message: 'contradiction references fewer than two available evidence records',
      });
      continue;
    }

    const records = referenced as AdmissionEvidenceRecorded[];
    const [firstRecord] = records;
    if (firstRecord === undefined) continue;
    const first = firstRecord.evidence;
    const eventScopeMatches = records.every(
      (record) =>
        record.evidence.requirementId === first.requirementId &&
        record.evidence.phaseAttemptId === contradiction.phaseAttemptId &&
        subjectKey(record.evidence.subject) === subjectKey(contradiction.subject) &&
        digestKey(record.evidence.policyDigest) ===
          digestKey(contradiction.policyDigest) &&
        record.evidence.policyId === contradiction.policyId,
    );
    if (
      !eventScopeMatches ||
      (contradiction.requirementId !== undefined &&
        contradiction.requirementId !== first.requirementId)
    ) {
      diagnostics.push({
        code: 'CONTRADICTION_SCOPE_MISMATCH',
        contradictionId: contradiction.contradictionId,
        message: 'contradiction evidence does not share the declared requirement scope',
      });
      continue;
    }

    contradictions.push({
      source: 'downstream-event',
      contradictionId: contradiction.contradictionId,
      requirementId: first.requirementId,
      phaseAttemptId: contradiction.phaseAttemptId,
      subject: contradiction.subject,
      policyDigest: contradiction.policyDigest,
      evidenceIds,
      detectedAt: contradiction.detectedAt,
    });
  }

  contradictions.sort((left, right) => {
    const leftId =
      left.source === 'downstream-event'
        ? `1|${left.contradictionId}`
        : `0|${left.requirementId}|${left.evidenceIds.join('|')}`;
    const rightId =
      right.source === 'downstream-event'
        ? `1|${right.contradictionId}`
        : `0|${right.requirementId}|${right.evidenceIds.join('|')}`;
    return compareText(leftId, rightId);
  });

  return Object.freeze({
    activeEvidence: Object.freeze(canonicalActiveEvidence),
    supersessions: Object.freeze(supersessions),
    contradictions: Object.freeze(contradictions),
    diagnostics: Object.freeze(diagnostics.sort(compareDiagnostics)),
  });
}

/**
 * The claim codec: the one normal form of a settlement claim, and each conversion of it.
 * `claimOfRequest` reads one request entry into the normal form.
 * `claimTraceOf` gives the stored trace of a claim, and `claimOfTrace` gives the claim of a stored trace.
 *
 * The request reader, the settlement bundle and the decision round convert a claim only here.
 * Thus a field that the normal form gains goes through each of them.
 * The stored schema is strict, so a field that it does not declare never reaches custody.
 *
 * A completed claim holds no status. A claim that an earlier build recorded thus keeps its bytes and its request digest.
 */

import { z } from 'zod';

import {
  CLAIM_STATUSES,
  INCOMPLETE_CLAIM_STATUSES,
  type SettlementClaim,
  type SettlementEvidence,
} from './adjudicate.js';

/** The most characters that the reason of a submitted claim holds. The bound is on the request only. */
export const MAX_CLAIM_REASON_LENGTH = 280;

const EvidenceTraceSchema = z.object({ kind: z.string().min(1), ref: z.string().min(1) }).strict();

/**
 * One claim as a settlement bundle stores it, which is the normal form that the request digest hashes.
 * `fields` is a record of `unknown` because the capsule declares the result shape.
 * `status` and `reason` are absent on a completed claim. The reason has no bound here.
 * The request bounds it, and a stored batch must always decode.
 */
export const ClaimTraceSchema = z
  .object({
    taskId: z.string().min(1),
    status: z.enum(INCOMPLETE_CLAIM_STATUSES).optional(),
    reason: z.string().min(1).optional(),
    fields: z.record(z.string(), z.unknown()),
    evidence: z.array(EvidenceTraceSchema),
  })
  .strict();

type ClaimTrace = z.infer<typeof ClaimTraceSchema>;

/**
 * The stored trace of one claim. The strict schema parses the claim, so the trace holds each field of the claim.
 * It throws on a field that the schema does not declare, and never drops one.
 */
export function claimTraceOf(claim: SettlementClaim): ClaimTrace {
  return ClaimTraceSchema.parse(claim);
}

/** The claim of one stored trace. The trace is already in the normal form, so the function copies no field by name. */
export function claimOfTrace(trace: ClaimTrace): SettlementClaim {
  return trace;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The evidence list of one request entry, or the reason for the refusal. An absent list is an empty list. */
function evidenceOfRequest(raw: unknown, at: string): SettlementEvidence[] | string {
  const entries = raw ?? [];
  if (!Array.isArray(entries)) return `${at} must be an array`;
  const evidence: SettlementEvidence[] = [];
  for (const [j, item] of entries.entries()) {
    if (!isRecord(item)) return `${at}[${j}] must be an object`;
    const kind = textOf(item, 'kind');
    const ref = textOf(item, 'ref');
    if (kind === undefined || ref === undefined) return `${at}[${j}] requires both kind and ref`;
    evidence.push({ kind, ref });
  }
  return evidence;
}

/**
 * Reads one entry of the request `claims` into the normal form, or returns the reason for the refusal.
 * `at` is the path of the entry. The status `completed` is the default, and the normal form does not hold it.
 * Thus a claim with that status and a claim with no status are one request.
 *
 * A claim with another status needs a reason, and it carries no field and no evidence.
 * A completed claim carries no reason. A refusal here is invalid input, not a finding.
 */
export function claimOfRequest(entry: unknown, at: string): SettlementClaim | string {
  if (!isRecord(entry)) return `${at} must be an object`;
  const taskId = textOf(entry, 'taskId');
  if (taskId === undefined) return `${at}.taskId is required`;
  const fields = entry.fields ?? {};
  if (!isRecord(fields)) return `${at}.fields must be an object of returned result fields`;
  const evidence = evidenceOfRequest(entry.evidence, `${at}.evidence`);
  if (typeof evidence === 'string') return evidence;

  const status = CLAIM_STATUSES.find((name) => name === entry.status);
  if (entry.status !== undefined && status === undefined) {
    return `${at}.status must be one of ${CLAIM_STATUSES.map((name) => `'${name}'`).join(', ')}`;
  }
  const reason = entry.reason;
  if (
    reason !== undefined &&
    (typeof reason !== 'string' || reason.length === 0 || reason.length > MAX_CLAIM_REASON_LENGTH)
  ) {
    return `${at}.reason must be text of 1 to ${MAX_CLAIM_REASON_LENGTH} characters`;
  }
  if (status === undefined || status === 'completed') {
    if (reason !== undefined) {
      return (
        `${at}.reason is given only with the status 'failed', 'blocked' or 'skipped'. ` +
        'A completed claim returns its result in `fields`'
      );
    }
    return { taskId, fields, evidence };
  }
  if (reason === undefined) {
    return `${at}.reason is required with the status '${status}': say why the task is not completed`;
  }
  if (Object.keys(fields).length > 0 || evidence.length > 0) {
    return (
      `${at} has the status '${status}', so it carries no fields and no evidence. ` +
      'Settlement verifies only a completed claim'
    );
  }
  return { taskId, status, reason, fields, evidence };
}

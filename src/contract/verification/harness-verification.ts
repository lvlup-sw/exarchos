/**
 * The closed request, check plan and evidence shapes of verification, with their canonical digests.
 * The local check executor binds a request and digests a check plan with them.
 * The separate verifier host is retired. Its stored request keys and evidence shapes keep their original read results.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

/** The host version that each stored evidence of the retired verifier names. */
const STORED_EVIDENCE_HOST_VERSION = 'exarchos-verifier/1';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().min(1).max(200);
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const VerificationSubject = z.object({
  streamId: name, phaseAttemptId: name, taskId: name, leafId: name, operationId: name,
  preparedDigest: digest, callerDigest: digest, segmentDigest: digest,
  configDigest: digest, profileDigest: digest, testSelectionDigest: digest,
  baseCommit: oid, headCommit: oid, blockerHeads: z.array(oid).max(64),
}).strict();
export type VerificationSubject = z.infer<typeof VerificationSubject>;
const requestTerms = z.object({
  version: z.literal(1), key: digest, resourceId: name, profileId: name, subject: VerificationSubject,
});

/** A phase operation names no task. A strict schema refuses each task field, so no task subject can stand in for it. */
export const PhaseVerificationSubject = z.object({
  scope: z.literal('phase'), streamId: name, phaseAttemptId: name,
  preparedDigest: digest, configDigest: digest, profileDigest: digest, testSelectionDigest: digest, headCommit: oid,
}).strict();
export type PhaseVerificationSubject = z.infer<typeof PhaseVerificationSubject>;
const phaseTerms = z.object({
  version: z.literal(1), key: digest, resourceId: name, profileId: name, subject: PhaseVerificationSubject,
});

/**
 * A checkout operation names an operator checkout and the exact head that the governor observed.
 * Stream, phase attempt and task only scope the request. A strict schema refuses each other task and phase field.
 * The subject never carries a profile digest, because its operator resource pins the profile.
 */
export const CheckoutVerificationSubject = z.object({
  scope: z.literal('checkout'), streamId: name.optional(), phaseAttemptId: name.optional(), taskId: name.optional(), headCommit: oid,
  profileDigest: z.never().optional(),
}).strict();
export type CheckoutVerificationSubject = z.infer<typeof CheckoutVerificationSubject>;
const checkoutTerms = z.object({
  version: z.literal(1), key: digest, resourceId: name, profileId: name, subject: CheckoutVerificationSubject,
});

/**
 * An integration operation names the integration ref, its observed tip and the accepted task heads of one settlement.
 * The tip is `headCommit`, as in the phase and checkout subjects, so the verifier builds and dirty-checks the tip image unchanged.
 * The accepted heads are sorted and unique. A strict schema refuses each task field, so no task subject can stand in for it.
 */
export const IntegrationVerificationSubject = z.object({
  scope: z.literal('integration'), streamId: name, phaseAttemptId: name, outerOperationId: name,
  ref: z.string().min(12).max(256).regex(/^refs\/heads\/[^\x00-\x20\x7f]+$/), headCommit: oid,
  preparedDigest: digest, configDigest: digest, profileDigest: digest,
  acceptedHeads: z.array(oid).max(64).refine(heads => heads.every((head, index) => index === 0 || (heads[index - 1] ?? '') < head)),
}).strict();
export type IntegrationVerificationSubject = z.infer<typeof IntegrationVerificationSubject>;

const selectedPath = z.string().min(1).max(300).refine(path =>
  !path.includes('\\') && !/[\x00-\x1f\x7f]/.test(path)
  && path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git'));
const selectionPaths = z.array(selectedPath).max(40).refine(paths => new Set(paths).size === paths.length);
export const AdequacySelection = z.object({
  tests: selectionPaths,
  sources: selectionPaths,
}).strict().refine(value => value.tests.every(path => !value.sources.includes(path)));
export type AdequacySelection = z.infer<typeof AdequacySelection>;

/** The task gate checks that one verifier operation runs against the exact head of a bound task. */
export const TASK_CHECK_OPERATIONS: readonly ['static-analysis', 'contract-drift', 'integration-suite'] = ['static-analysis', 'contract-drift', 'integration-suite'];
/** Every check operation. Only spec coverage takes a phase subject, and only the lifecycle check takes a checkout subject. */
export const HOSTED_CHECK_OPERATIONS: readonly [...typeof TASK_CHECK_OPERATIONS, 'spec-coverage', 'lifecycle'] = [...TASK_CHECK_OPERATIONS, 'spec-coverage', 'lifecycle'];
export type HostedCheckOperation = (typeof HOSTED_CHECK_OPERATIONS)[number];

/** Declared tests of one phase. The total path length keeps the echoed request far below the frame limit. */
export const SpecCoverageSelection = z.object({
  tests: z.array(selectedPath).min(1).max(128).refine(paths =>
    new Set(paths).size === paths.length && paths.reduce((total, path) => total + path.length, 0) <= 16384),
}).strict();
export type SpecCoverageSelection = z.infer<typeof SpecCoverageSelection>;

export const VerificationRequest = z.discriminatedUnion('operation', [
  requestTerms.extend({ operation: z.literal('probe') }).strict(),
  requestTerms.extend({ operation: z.literal('adequacy'), selection: AdequacySelection, commandDigest: digest }).strict(),
  requestTerms.extend({ operation: z.literal('static-analysis'), commandDigest: digest }).strict(),
  requestTerms.extend({ operation: z.literal('contract-drift'), commandDigest: digest }).strict(),
  requestTerms.extend({ operation: z.literal('integration-suite'), subject: z.union([VerificationSubject, IntegrationVerificationSubject]), commandDigest: digest }).strict(),
  phaseTerms.extend({ operation: z.literal('spec-coverage'), selection: SpecCoverageSelection, commandDigest: digest }).strict(),
  checkoutTerms.extend({ operation: z.literal('lifecycle'), commandDigest: digest }).strict(),
]);
export type VerificationRequest = z.infer<typeof VerificationRequest>;
/** Request terms before the key. Each member keeps its own operation and subject. */
export type VerificationRequestTerms = VerificationRequest extends infer Member
  ? Member extends VerificationRequest ? Omit<Member, 'key'> : never : never;
/**
 * The terms that key derivation reads. The subject kind selects the derivation, and the schema binds each kind to its operations.
 * A caller that spreads a request keeps this shape, so the helpers stay usable before a full schema parse.
 */
export interface VerificationKeyTerms {
  readonly operation: VerificationRequest['operation'];
  readonly subject: VerificationSubject | PhaseVerificationSubject | CheckoutVerificationSubject | IntegrationVerificationSubject;
  /** The operator resource. Only a checkout key and an integration key read it. */
  readonly resourceId?: string;
  /** The approved command digest. Only a checkout key and an integration key read it. */
  readonly commandDigest?: string;
}
/** A complete keyed carrier before its schema parse. Each consumer parses it before use. */
export type VerificationRequestCarrier = VerificationKeyTerms & { readonly key: string };

/** One approved leg. The verifier maps the argv to its own pinned executable and never runs a checkout program. */
export const CheckLeg = z.object({
  name, kind: z.enum(['command', 'dependency-cruiser', 'semgrep-taint', 'codegen', 'typecheck', 'diff', 'integration', 'probe']),
  argv: z.array(z.string().min(1).max(1024)).min(1).max(64),
  config: z.string().min(1).max(300).optional(),
}).strict();
export type CheckLeg = z.infer<typeof CheckLeg>;

/**
 * The reviewed typed scope of one check. Its digest binds the request to the operator command policy.
 * The source-revert adequacy probe runs only in the local executor, so only a local plan names `adequacy`.
 */
export const CheckPlan = z.object({
  operation: z.enum([...HOSTED_CHECK_OPERATIONS, 'adequacy']),
  legs: z.array(CheckLeg).max(20),
  report: z.enum(['exit-code', 'vitest-json']).optional(),
  files: z.enum(['as-arguments', 'after-separator', 'none']).optional(),
  firstParty: z.array(z.string().min(1).max(300)).max(64).optional(),
  /** A lifecycle check that stops after a failed test leg, as its local route stops. */
  onTestFailure: z.literal('stop').optional(),
}).strict();
export type CheckPlan = z.infer<typeof CheckPlan>;

/** Digest the closed check scope with the canonical encoding of the signed carrier. */
export function checkPlanDigest(plan: CheckPlan): string {
  return verificationValueDigest(CheckPlan.parse(plan));
}

/** True for a request that the check owner runs. */
export function isHostedCheckRequest(request: VerificationRequest): request is Extract<VerificationRequest, { operation: HostedCheckOperation }> {
  return request.operation !== 'probe' && request.operation !== 'adequacy';
}
export const ResourceIdentity = z.object({ path: z.string().min(1).max(4096), device: z.string(), inode: z.string() }).strict();
const ProbeOutcome = z.object({
  status: z.enum(['passed', 'failed', 'unsupported']), exitCode: z.number().int().nullable(),
  reason: z.string().max(200), stdoutBase64: z.string().max(5464), stderrBase64: z.string().max(5464),
}).strict();

export const AdequacyRun = z.object({
  kind: z.enum(['green', 'assertion-failure', 'no-tests', 'infrastructure', 'timeout', 'output-limit']),
  total: z.number().int().nonnegative().max(100000),
  passed: z.number().int().nonnegative().max(100000),
  failed: z.number().int().nonnegative().max(100000),
  outputDigest: digest, casesDigest: digest,
}).strict();
export type AdequacyRun = z.infer<typeof AdequacyRun>;

export const HostedAdequacyFacts = z.object({
  baseline: AdequacyRun.nullable(), reverted: AdequacyRun.nullable(),
  disposition: z.enum(['measured', 'no-tests', 'no-sources', 'infrastructure']),
  restored: z.literal(true), cleanHead: oid, childrenStopped: z.literal(true),
}).strict();
export type HostedAdequacyFacts = z.infer<typeof HostedAdequacyFacts>;

/** One bounded child result. The end names a timeout, an output overflow, a missing process or a signal. */
export const HostedCommandRun = z.object({
  end: z.enum(['exited', 'timeout', 'output-limit', 'unavailable', 'signal']),
  exitCode: z.number().int().nullable(),
  stdout: z.string().max(8192), stderr: z.string().max(4096), outputDigest: digest,
}).strict();
export type HostedCommandRun = z.infer<typeof HostedCommandRun>;

const legDetail = z.string().max(4096);
const processNoVerdict = z.enum(['missing-tool', 'did-not-start', 'signal', 'out-of-memory', 'output-limit']);
const boundaryNoVerdict = z.enum(['missing-tool', 'did-not-start', 'signal', 'out-of-memory', 'output-limit', 'no-source-root', 'zero-modules']);
/** A boundary leg that the verifier classified from its full report. Only the compact verdict crosses the frame. */
export const HostedBoundaryLeg = z.discriminatedUnion('adapter', [
  z.object({ adapter: z.literal('dependency-cruiser'), name, result: z.discriminatedUnion('status', [
    z.object({ status: z.literal('PASS'), cruised: z.number().int().positive(), detail: legDetail }).strict(),
    z.object({ status: z.literal('FAIL'), cause: z.enum(['violations', 'config-or-usage', 'project-config']), detail: legDetail }).strict(),
    z.object({ status: z.literal('NO_VERDICT'), cause: boundaryNoVerdict, detail: legDetail }).strict(),
    z.object({ status: z.literal('NOT_CONFIGURED'), detail: legDetail }).strict(),
  ]) }).strict(),
  z.object({ adapter: z.literal('semgrep-taint'), name, result: z.discriminatedUnion('status', [
    z.object({ status: z.literal('PASS') }).strict(),
    z.object({ status: z.literal('FAIL'), cause: z.enum(['findings', 'ruleset-or-usage', 'unknown-exit']), detail: legDetail }).strict(),
    z.object({ status: z.literal('NO_VERDICT'), cause: processNoVerdict, detail: legDetail }).strict(),
    z.object({ status: z.literal('NOT_CONFIGURED'), detail: legDetail }).strict(),
  ]) }).strict(),
]);
export type HostedBoundaryLeg = z.infer<typeof HostedBoundaryLeg>;

/** The suite report that the verifier reduced with the shared parser. The file list keeps a count of every file. */
export const ReducedSuiteReport = z.object({
  passed: z.boolean(), failedSuites: z.number().int().nonnegative(), failedTests: z.number().int().nonnegative(),
  loadFailures: z.number().int().nonnegative(), totalTests: z.number().int().nonnegative(), failCount: z.number().int().nonnegative(),
  loadFailureFiles: z.array(z.string().max(300)).max(20), loadFailureFileTotal: z.number().int().nonnegative(),
}).strict();
export type ReducedSuiteReport = z.infer<typeof ReducedSuiteReport>;

/** Compact signed facts of one check operation. */
export const HostedCheckFacts = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('static-analysis'), commands: z.array(HostedCommandRun).max(16), boundary: z.array(HostedBoundaryLeg).max(4) }).strict(),
  z.object({ operation: z.literal('contract-drift'), legs: z.array(z.object({ kind: z.enum(['codegen', 'typecheck', 'diff']), run: HostedCommandRun }).strict()).max(3) }).strict(),
  z.object({ operation: z.literal('integration-suite'), run: HostedCommandRun, report: ReducedSuiteReport.nullable() }).strict(),
  z.object({ operation: z.literal('spec-coverage'), runs: z.array(HostedCommandRun).max(128) }).strict(),
  z.object({ operation: z.literal('lifecycle'), legs: z.array(z.object({
    name, kind: z.enum(['command', 'typecheck']), run: HostedCommandRun,
  }).strict()).max(4) }).strict(),
]);
export type HostedCheckFacts = z.infer<typeof HostedCheckFacts>;

export const VerificationEvidence = z.object({
  version: z.literal(1), hostVersion: z.literal(STORED_EVIDENCE_HOST_VERSION), signerId: digest,
  request: VerificationRequest, requestDigest: digest, hostPolicyDigest: digest,
  resources: z.array(ResourceIdentity).min(1).max(3),
  completedAt: z.string().datetime(),
  outcome: z.union([ProbeOutcome, ProbeOutcome.extend({ adequacy: HostedAdequacyFacts }).strict(), ProbeOutcome.extend({ check: HostedCheckFacts }).strict()]),
}).strict().refine(evidence => (evidence.request.operation === 'adequacy') === ('adequacy' in evidence.outcome)
  && (isHostedCheckRequest(evidence.request)
    ? 'check' in evidence.outcome && evidence.outcome.check.operation === evidence.request.operation
    : !('check' in evidence.outcome)));
export type VerificationEvidence = z.infer<typeof VerificationEvidence>;
export const SignedVerification = z.object({ evidence: VerificationEvidence, signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict();
export type SignedVerification = z.infer<typeof SignedVerification>;

/** Canonical JSON sorts object keys recursively while preserving all array order. */
export function verificationJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalize);
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, normalize(x)]));
    return v;
  };
  return JSON.stringify(normalize(value));
}

/** Digest a closed value using the same canonical encoding as the signed carrier. */
export function verificationValueDigest(value: unknown): string {
  return createHash('sha256').update(verificationJson(value)).digest('hex');
}

/** Request identity includes every immutable field and the original operation key. */
export function verificationDigest(request: VerificationRequestCarrier): string {
  return createHash('sha256').update(verificationJson(VerificationRequest.parse(request))).digest('hex');
}

/**
 * A request key cannot be changed to re-execute the same authorized operation.
 * A task check names its leaf and no phase attempt, so a re-entered phase cannot replace the original request.
 * A phase operation names its stream, phase attempt and operation.
 */
export function verificationOperation(request: VerificationKeyTerms): string {
  const { subject } = request;
  if ('scope' in subject && subject.scope === 'integration') {
    const { resourceId, commandDigest } = checkoutKeyTerms(request);
    return verificationValueDigest({ operation: request.operation, subject, resourceId, commandDigest });
  }
  if ('scope' in subject && subject.scope === 'checkout') {
    const { resourceId, commandDigest } = checkoutKeyTerms(request);
    return verificationValueDigest({ operation: request.operation, subject, resourceId, commandDigest });
  }
  if ('scope' in subject) {
    const { streamId, phaseAttemptId } = subject;
    return verificationValueDigest({ streamId, phaseAttemptId, operation: request.operation });
  }
  const { streamId, phaseAttemptId, taskId, leafId, operationId } = subject;
  const execution = request.operation === 'probe'
    ? { streamId, phaseAttemptId, taskId, leafId, operationId }
    : { streamId, taskId, leafId, operationId, operation: request.operation };
  return verificationValueDigest(execution);
}

/** The resource and command of a checkout or integration key. A key of either kind without them refuses. */
function checkoutKeyTerms(request: VerificationKeyTerms): { readonly resourceId: string; readonly commandDigest: string } {
  const { resourceId, commandDigest } = request;
  if (resourceId === undefined || commandDigest === undefined) throw new Error('A checkout or integration key binds its resource and command');
  return { resourceId, commandDigest };
}

/**
 * Claim keys bind the original operation and segment while durable operation uniqueness prevents alias replay. A phase key binds the prepared identity.
 * A checkout key binds the operation, subject, resource, head and command digest. A new head gives a new key, and the same head reads the original.
 * An integration key binds the same terms. Its operation binds each subject field, so a new tip in one phase attempt gets its own claim.
 */
export function verificationKey(request: VerificationKeyTerms): string {
  const { subject } = request;
  if ('scope' in subject && (subject.scope === 'checkout' || subject.scope === 'integration')) {
    const { resourceId, commandDigest } = checkoutKeyTerms(request);
    return createHash('sha256').update(verificationJson({
      operation: verificationOperation(request), resource: resourceId, head: subject.headCommit, command: commandDigest,
    })).digest('hex');
  }
  const bound = 'scope' in subject
    ? { operation: verificationOperation(request), prepared: subject.preparedDigest }
    : { operation: verificationOperation(request), segment: subject.segmentDigest };
  return createHash('sha256').update(verificationJson(bound)).digest('hex');
}

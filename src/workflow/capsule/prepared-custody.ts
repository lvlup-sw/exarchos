/** Shared custody reads bind stored plans to their prepared rows. Legacy named lookup remains separate from strict latest authority. */
import type { z } from 'zod';
import type { TaskVerificationCoordinateSchema } from '../../contract/capsule/exarchos-capsule.js';
import { capsuleDigest, contentDigest } from '../../contract/capsule/capsule-digest.js';
import { decodePreparedBundle, type PreparedBundleV1 } from '../../contract/capsule/prepared-bundle.js';
import type { RunBundleStore } from '../../events/bundle/run-bundle-store.js';
import { WorkflowPreparedData, type WorkflowPrepared } from '../../events/schemas.js';
import { compileDecideDefinition } from '../decide/edges.js';
import { checkDefinitionDocument, type ExarchosDefinition } from '../definitions/extension.js';
import { readDesignRecord } from '../design-record/read.js';
import type { DesignRecordSnapshot } from '../design-record/schema.js';
import { validateDesignRecord } from '../design-record/validate.js';

export interface PreparedAuthorityRow {
  readonly streamId: string;
  readonly sequence: number;
  readonly type: string;
  readonly schemaVersion?: string;
  readonly data?: unknown;
}

/** The token binds the selected record. The read tail records context, not custody identity. */
export interface PreparedAuthoritySelection {
  readonly streamId: string;
  readonly sequence: number;
  readonly tail: number;
  readonly identity: string;
  readonly record: WorkflowPrepared;
  readonly kind: 'typed' | 'legacy';
}

export type PreparedAuthority = PreparedBundleV1 & {
  readonly selection: PreparedAuthoritySelection;
  readonly pinnedDefinition?: ExarchosDefinition;
  readonly skipPhases?: readonly string[];
} & ({ readonly kind: 'typed'; readonly snapshot: DesignRecordSnapshot } | { readonly kind: 'legacy' });

/** A malformed marker is an integrity error even when a newer record looks valid. */
function markerOf(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null || !Object.hasOwn(data, 'planRecordDigest')) return undefined;
  const marker: unknown = Reflect.get(data, 'planRecordDigest');
  if (typeof marker !== 'string' || !/^[a-f0-9]{64}$/.test(marker)) throw new Error('Invalid prepared plan marker');
  return marker;
}

/** Select the highest sequence without skipping damaged rows or downgrading a typed stream. */
export function selectPreparedAuthority(
  rows: readonly PreparedAuthorityRow[], streamId: string,
): PreparedAuthoritySelection | undefined {
  const prepared = rows.filter(row => row.type === 'workflow.prepared').sort((a, b) => a.sequence - b.sequence);
  let typed = false;
  let selected: PreparedAuthoritySelection | undefined;
  const tail = rows.reduce((value, row) => Math.max(value, row.sequence), 0);
  for (const row of prepared) {
    if (row.streamId !== streamId || row.schemaVersion !== '1.0' || !Number.isSafeInteger(row.sequence) || row.sequence < 1) {
      throw new Error('Invalid prepared row envelope');
    }
    if (selected?.sequence === row.sequence) throw new Error('Duplicate prepared row sequence');
    const marker = markerOf(row.data);
    if (typed && marker === undefined) throw new Error('Prepared plan marker cannot be removed');
    typed ||= marker !== undefined;
    const record = WorkflowPreparedData.parse(row.data);
    if (record.workflowId !== streamId) throw new Error('Prepared row workflow identity mismatch');
    selected = { streamId, sequence: row.sequence, tail, identity: contentDigest(row), record, kind: typed ? 'typed' : 'legacy' };
  }
  return selected;
}

/** A changed prepared row requires new custody outside the transaction. Fresh completion rows do not invalidate immutable custody. */
export function recheckPreparedAuthority(selection: PreparedAuthoritySelection, rows: readonly PreparedAuthorityRow[]): boolean {
  try {
    const current = selectPreparedAuthority(rows, selection.streamId);
    return current !== undefined && current.identity === selection.identity && current.kind === selection.kind;
  } catch {
    return false;
  }
}

/** Validate full definitions when present. Older kernel-only pins retain their unsupported transition route. */
function definitionOf(bundle: PreparedBundleV1, record: WorkflowPrepared): ExarchosDefinition | undefined {
  if (bundle.definition.name !== record.workflowType && bundle.definition.name !== `exarchos.${record.workflowType}`) {
    throw new Error('Prepared workflow type does not match its definition');
  }
  const required = record.planRecordDigest !== undefined || /^exarchos-prepare-(?:[7-9]|[1-9][0-9]+)$/.test(record.compilerVersion);
  const full = Object.hasOwn(bundle.definition, 'exarchos');
  if (!full && !required) return undefined;
  const checked = checkDefinitionDocument(bundle.definition, () => []);
  if (!checked.ok) throw new Error(`Invalid prepared definition: ${JSON.stringify(checked.findings)}`);
  const skips = bundle.capsule.settlementContract.skipPhases;
  if (required && skips === undefined) throw new Error('Prepared capsule is missing its frozen skip policy');
  compileDecideDefinition(record.workflowType, checked.definition, skips);
  return checked.definition;
}

/** Bind identities and validate every authored task before any completion overlay. */
export function verifyPreparedCustody(selection: PreparedAuthoritySelection, bundle: PreparedBundleV1): PreparedAuthority {
  const { record } = selection;
  const { capsule, definition } = bundle;
  const id = capsule.identity;
  const digest = contentDigest(definition);
  if (record.workflowId !== selection.streamId || id.workflowId !== record.workflowId
    || id.capsuleVersion !== record.capsuleVersion || id.definitionVersion !== record.definitionVersion
    || id.designVersion !== record.designVersion || capsule.provenance.compilerVersion !== record.compilerVersion
    || capsule.graph.tasks.length !== record.taskCount || capsuleDigest(capsule) !== record.capsuleDigest
    || digest !== id.definitionVersion) throw new Error('Prepared custody identity mismatch');
  const pinnedDefinition = definitionOf(bundle, record);
  const skipPhases = capsule.settlementContract.skipPhases;
  const common = { ...bundle, selection, ...(pinnedDefinition ? { pinnedDefinition } : {}), ...(skipPhases !== undefined ? { skipPhases } : {}) };
  if (selection.kind === 'legacy') {
    if (bundle.designRecord !== undefined) throw new Error('Stored design record has no prepared plan marker');
    return { ...common, kind: 'legacy' };
  }
  if (bundle.designRecord === undefined) throw new Error('Typed custody is missing its design record');
  const sources = capsule.provenance.sources.filter(source => source.sourceId === 'design-record');
  if (sources.length !== 1 || sources[0]?.digest !== record.planRecordDigest) throw new Error('Invalid design-record source binding');
  const read = readDesignRecord(Buffer.from(bundle.designRecord.text, 'utf8'), bundle.designRecord.reference);
  if (read.kind !== 'typed') throw new Error('Stored design record is not a valid typed plan');
  if (read.snapshot.digest !== record.planRecordDigest) throw new Error('Stored design record digest mismatch');
  const validation = validateDesignRecord(read.snapshot);
  if (!validation.passed) throw new Error(`Invalid whole plan: ${JSON.stringify(validation.findings)}`);
  return { ...common, kind: 'typed', snapshot: read.snapshot };
}

/** Load immutable custody before the commit. Missing or corrupt bytes never select an older authority. */
export async function loadPreparedCustody(
  selection: PreparedAuthoritySelection, bundleStore: Pick<RunBundleStore, 'resolve'>,
): Promise<PreparedAuthority> {
  const ref = selection.record.bundleRefs[0];
  if (ref === undefined) throw new Error('Prepared authority is missing its custody reference');
  return verifyPreparedCustody(selection, decodePreparedBundle(await bundleStore.resolve(ref.digest)));
}

/** Legacy named lookup checks capsule and definition digests. Missing references return undefined, while missing or corrupt bytes throw. */
export async function capsuleOfRecord(
  record: WorkflowPrepared,
  bundleStore: Pick<RunBundleStore, 'resolve'>,
): Promise<PreparedBundleV1 | undefined> {
  const ref = record.bundleRefs[0];
  if (ref === undefined) return undefined;
  const decoded = decodePreparedBundle(await bundleStore.resolve(ref.digest));
  const actual = capsuleDigest(decoded.capsule);
  if (actual !== record.capsuleDigest) {
    throw new Error(
      `the prepared capsule v${record.capsuleVersion} on '${record.workflowId}' is in custody under a digest its ` +
        `record did not pin (record ${record.capsuleDigest}, bytes ${actual})`,
    );
  }
  const definitionDigest = contentDigest(decoded.definition);
  if (definitionDigest !== decoded.capsule.identity.definitionVersion) {
    throw new Error(
      `the prepared capsule v${record.capsuleVersion} on '${record.workflowId}' names definition ` +
        `${decoded.capsule.identity.definitionVersion} and its bundle carries ${definitionDigest}`,
    );
  }
  return decoded;
}

/** Execution terms exclude source offsets so unrelated plan edits preserve eligible standing. */
export function preparedTaskTerms(capsule: PreparedBundleV1['capsule'], snapshot: DesignRecordSnapshot, taskId: string): unknown {
  const task = snapshot.tasks.find(entry => entry.id === taskId);
  if (task === undefined) return undefined;
  const { span: _span, ...terms } = task;
  const node = capsule.graph.tasks.find(entry => entry.taskId === taskId);
  return { terms, definitionVersion: capsule.identity.definitionVersion, stage: node?.stage, stepId: node?.stepId,
    verificationMode: capsule.settlementContract.verificationMode, skipPhases: capsule.settlementContract.skipPhases,
    verification: capsule.settlementContract.taskVerification?.[taskId], result: capsule.contracts.taskResults[taskId],
    scope: capsule.settlementContract.scope, profile: capsule.settlementContract.verificationProfile };
}

/** The immutable segment identity is shared by accepted and provisional blocker references. */
type SelectedSegment = Pick<z.infer<typeof TaskVerificationCoordinateSchema>['blockers'][number],
  'taskId' | 'headCommit' | 'segmentOperationId' | 'segmentRecord' | 'runBundle' | 'completionSequence' | 'staticAnalysisSequence'>;

/** Compares segment identity without changing a provisional reference after its outer acceptance. */
function selectedSegmentKey(proof: SelectedSegment): string {
  return contentDigest({ taskId: proof.taskId, headCommit: proof.headCommit, segmentOperationId: proof.segmentOperationId,
    segmentRecord: proof.segmentRecord, runBundle: proof.runBundle, completionSequence: proof.completionSequence,
    staticAnalysisSequence: proof.staticAnalysisSequence });
}

/** Removes proofs whose original blockers differ from current selections, including their descendants. */
export function currentStandingProofs<T extends SelectedSegment & { readonly coordinate: { readonly blockers: readonly SelectedSegment[] } }>(
  proofs: ReadonlyMap<string, T>,
): Map<string, T> {
  const current = new Map(proofs);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [taskId, proof] of current) {
      if (proof.coordinate.blockers.every(blocker => {
        const selected = current.get(blocker.taskId);
        return selected !== undefined && selectedSegmentKey(selected) === selectedSegmentKey(blocker);
      })) continue;
      current.delete(taskId); changed = true;
    }
  }
  return current;
}

/**
 * The preview reads a copied fixture and leaves its bytes unchanged. Outcomes are literal circuit-limit verdicts.
 * @oracle-sources: ../../../tools/audit/core/guard-input-audit.ts, literal row fixtures and byte snapshots in this file
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import { auditGuardInputs } from '../../../tools/audit/core/guard-input-audit.js';
import { makeTempDir, rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rmrfAsync(dir); });

/** Audits only copied rows, with a document at review and failed review evidence on both sides. */
async function preview(cycles: number) {
  const dir = makeTempDir('preview-outcomes-');
  dirs.push(dir);
  const rows: WorkflowEvent[] = [];
  const add = (type: string, data: Record<string, unknown>) => rows.push({
    type, data, sequence: rows.length + 1, streamId: 'preview', timestamp: '2026-11-13T00:00:00.000Z', schemaVersion: '1.0',
  });
  add('workflow.started', { featureId: 'preview', workflowType: 'feature' });
  add('workflow.transition', { from: 'plan', to: 'review', trigger: 'fixture', featureId: 'preview' });
  add('workflow.compound-entry', { compoundStateId: 'implementation', featureId: 'preview' });
  add('state.patched', { featureId: 'preview', fields: ['reviews'], patch: { reviews: { bugbot: { status: 'failed' } } } });
  for (let count = 1; count <= cycles; count += 1) add('workflow.fix-cycle', { compoundStateId: 'implementation', count, featureId: 'preview' });
  const source = path.join(dir, 'source.json');
  const copy = path.join(dir, 'copy.json');
  writeFileSync(source, JSON.stringify(rows));
  copyFileSync(source, copy);
  const before = readFileSync(copy);
  const copied: WorkflowEvent[] = JSON.parse(before.toString());
  const report = await auditGuardInputs({
    listStates: () => [{ featureId: 'preview', state: { _esVersion: 2, workflowType: 'feature', phase: 'review', reviews: { bugbot: { status: 'failed' } } } }],
    listStreams: () => ['preview'],
    queryEvents: () => copied,
  }, { preview: true });
  expect(readFileSync(copy)).toEqual(before);
  expect(readFileSync(source)).toEqual(before);
  return report.preview?.[0]?.edges.find((edge) => edge.to === 'delegate');
}

describe('prospective guard audit outcomes', () => {
  it.each([3, 4])('GuardInputAudit_Preview_AnExhaustedFixCycle_IsDeniedOnBothSides (%i)', async (cycles) => {
    expect(await preview(cycles)).toEqual({ transitionId: 'review->delegate', to: 'delegate', legacy: 'deny', decide: 'deny', change: 'same', keys: [] });
  });

  it('GuardInputAudit_Preview_ABelowLimitFixCycle_IsAllowedOnBothSides', async () => {
    expect(await preview(2)).toEqual({ transitionId: 'review->delegate', to: 'delegate', legacy: 'allow', decide: 'allow', change: 'same', keys: [] });
  });
});

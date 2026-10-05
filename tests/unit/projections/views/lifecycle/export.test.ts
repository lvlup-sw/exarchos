// Tests for the `export` lifecycle verb. Each test uses a real `EventStore` and
// a temporary directory. A test of the bundle content reads the written zip back
// from disk. The property test alone calls `buildExportBundle` and writes no zip.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fc } from '@fast-check/vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as yauzl from 'yauzl';
import type { Readable } from 'node:stream';

import { EventStore } from '../../../../../src/events/store.js';
import { rmrfAsync } from '../../../../../tools/test-helpers/temp-dir.js';
import type { DispatchContext } from '../../../../../src/dispatch/core/dispatch.js';
import type { WorkflowEvent } from '../../../../../src/events/schemas.js';
import { workflowStateProjection } from '../../../../../src/projections/views/workflow-state-projection.js';
import { resolveWorkflowState } from '../../../../../src/verbs/resolve-state.js';
import { handleViewExport, ExportOutputSchema } from '../../../../../src/projections/views/lifecycle/export.js';
import { handleView } from '../../../../../src/projections/views/composite.js';

let tempDir: string;
let eventStore: EventStore;
let ctx: DispatchContext;

/**
 * The handler resolves the default output path and each artifact reference against `cwd`. As a
 * result, every file stays in the temporary directory.
 */
beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'export-test-'));
  eventStore = new EventStore(tempDir);
  await eventStore.initialize();
  ctx = { stateDir: tempDir, eventStore, enableTelemetry: false, cwd: tempDir };
});

afterEach(async () => {
  await eventStore.close?.();
  await rmrfAsync(tempDir);
});

/** Seeds a feature workflow with one completed task. `artifacts` adds paths through a `state.patched` event. */
async function seedWorkflow(
  streamId: string,
  artifacts?: Record<string, string>,
): Promise<void> {
  await eventStore.append(streamId, {
    type: 'workflow.started',
    data: { featureId: streamId, workflowType: 'feature' },
  });
  await eventStore.append(streamId, { type: 'workflow.transition', data: { to: 'delegate' } });
  if (artifacts) {
    const patch: Record<string, string> = {};
    for (const [k, v] of Object.entries(artifacts)) patch[`artifacts.${k}`] = v;
    await eventStore.append(streamId, {
      type: 'state.patched',
      data: { featureId: streamId, patch },
    });
  }
  await eventStore.append(streamId, {
    type: 'task.assigned',
    data: { taskId: 't1', title: 'Build handler', branch: 'feat/t1' },
  });
  await eventStore.append(streamId, { type: 'task.completed', data: { taskId: 't1' } });
}

/** Read every entry of a zip buffer into a name → bytes map (yauzl, real reader). */
function readZipEntries(zipBytes: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(zipBytes, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err ?? new Error('no zipfile'));
      const out = new Map<string, Buffer>();
      zipfile.on('entry', (entry: yauzl.Entry) => {
        zipfile.openReadStream(entry, (e: Error | null, stream?: Readable) => {
          if (e || !stream) return reject(e ?? new Error('no read stream'));
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => {
            out.set(entry.fileName, Buffer.concat(chunks));
            zipfile.readEntry();
          });
          stream.on('error', reject);
        });
      });
      zipfile.on('end', () => resolve(out));
      zipfile.on('error', reject);
      zipfile.readEntry();
    });
  });
}

/** Fold an event list through the canonical projection (the "replay" leg). */
function foldEvents(events: readonly WorkflowEvent[]): unknown {
  let view = workflowStateProjection.init();
  for (const e of events) view = workflowStateProjection.apply(view, e);
  return view;
}

async function countByType(streamId: string, type: string): Promise<number> {
  const events = await eventStore.query(streamId);
  return events.filter((e) => e.type === type).length;
}

describe('export (DR-6 diagnostic bundle)', () => {
  /** The `export.*` events do not change the projection, so the bundled state also equals the live state. */
  it('Export_Bundle_ReplayEventsJsonlEqualsStateJson', async () => {
    const featureId = 'round-trip-feature';
    await seedWorkflow(featureId);

    const outputPath = path.join(tempDir, 'bundle.zip');
    const res = await handleViewExport({ featureId, output: outputPath }, ctx);
    expect(res.success).toBe(true);

    expect(fs.existsSync(outputPath)).toBe(true);
    const zipBytes = await fs.promises.readFile(outputPath);
    expect(zipBytes.subarray(0, 4).toString('hex')).toBe('504b0304');

    const entries = await readZipEntries(zipBytes);
    expect([...entries.keys()]).toEqual(
      expect.arrayContaining(['events.jsonl', 'state.json', 'metadata.json']),
    );

    const jsonl = entries.get('events.jsonl')!.toString('utf8');
    const replayedEvents = jsonl
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as WorkflowEvent);
    const replayedState = foldEvents(replayedEvents);
    const stateJson = JSON.parse(entries.get('state.json')!.toString('utf8'));

    expect(replayedState).toEqual(stateJson);

    const live = await resolveWorkflowState({ featureId, eventStore });
    expect('state' in live).toBe(true);
    if ('state' in live) expect(live.state).toEqual(stateJson);
  });

  /**
   * A second run uses a new logical key and appends a second pair. `findDanglingIntent` reads an
   * intent without a result as a crash. The test therefore checks that each intent has a lower
   * sequence than its result, and not only the pair counts.
   */
  it('Export_Success_AppendsExactlyRequestedExecutedPair', async () => {
    const featureId = 'pair-feature';
    await seedWorkflow(featureId);

    const first = await handleViewExport(
      { featureId, output: path.join(tempDir, 'a.zip') },
      ctx,
    );
    expect(first.success).toBe(true);
    expect(await countByType(featureId, 'export.requested')).toBe(1);
    expect(await countByType(featureId, 'export.executed')).toBe(1);

    const second = await handleViewExport(
      { featureId, output: path.join(tempDir, 'b.zip') },
      ctx,
    );
    expect(second.success).toBe(true);
    expect(await countByType(featureId, 'export.requested')).toBe(2);
    expect(await countByType(featureId, 'export.executed')).toBe(2);

    const events = await eventStore.query(featureId);
    const requestedKeys = events
      .filter((e) => e.type === 'export.requested')
      .map((e) => (e.data as { idempotencyKey: string }).idempotencyKey);
    expect(new Set(requestedKeys).size).toBe(2);

    const executedKeys = new Set(
      events
        .filter((e) => e.type === 'export.executed')
        .map((e) => (e.data as { idempotencyKey: string }).idempotencyKey),
    );
    for (const k of requestedKeys) expect(executedKeys.has(k)).toBe(true);

    for (const key of new Set(requestedKeys)) {
      const keyOf = (e: WorkflowEvent): string => (e.data as { idempotencyKey: string }).idempotencyKey;
      const requested = events.find((e) => e.type === 'export.requested' && keyOf(e) === key);
      const executed = events.find((e) => e.type === 'export.executed' && keyOf(e) === key);
      expect(requested).toBeDefined();
      expect(executed).toBeDefined();
      expect(requested!.sequence).toBeLessThan(executed!.sequence);
    }
  });

  /**
   * The test seeds an intent with the storage key that the handler derives, with no result and no zip.
   * The handler appends the intent again with that key, and the store keeps one intent. A later run
   * starts a new pair and skips the write, because the zip on disk already matches the bundle.
   */
  it('Export_CrashBetweenPair_PrecheckCompletesWithoutDuplicateIntent', async () => {
    const featureId = 'crash-feature';
    await seedWorkflow(featureId);
    const outputPath = path.join(tempDir, 'crash.zip');

    const crashedKey = 'crashed-logical-key';
    await eventStore.append(
      featureId,
      { type: 'export.requested', data: { featureId, outputPath, idempotencyKey: crashedKey } },
      { idempotencyKey: `export.requested:${crashedKey}` },
    );
    expect(await countByType(featureId, 'export.requested')).toBe(1);
    expect(await countByType(featureId, 'export.executed')).toBe(0);
    expect(fs.existsSync(outputPath)).toBe(false);

    const res = await handleViewExport({ featureId }, ctx);
    expect(res.success).toBe(true);
    const data = (res as { data: Record<string, unknown> }).data;
    expect(data.recovered).toBe(true);
    expect(data.outputPath).toBe(outputPath);
    expect(fs.existsSync(outputPath)).toBe(true);

    expect(await countByType(featureId, 'export.requested')).toBe(1);
    expect(await countByType(featureId, 'export.executed')).toBe(1);

    const events = await eventStore.query(featureId);
    const executed = events.find((e) => e.type === 'export.executed');
    expect((executed!.data as { idempotencyKey: string }).idempotencyKey).toBe(crashedKey);

    const again = await handleViewExport({ featureId, output: outputPath }, ctx);
    const againData = (again as { data: Record<string, unknown> }).data;
    expect(againData.recovered).toBe(false);
    expect(againData.bundleRewritten).toBe(false);
  });

  /** The `design` reference is a file that exists. The `plan` reference names no file. */
  it('Export_ArtifactsDir_IncludedAndMissingRefsListedInMetadata', async () => {
    const featureId = 'artifacts-feature';
    const designRel = 'docs/specs/design.md';
    const planRel = 'docs/specs/missing-plan.md';
    await mkdir(path.join(tempDir, 'docs', 'specs'), { recursive: true });
    await writeFile(path.join(tempDir, designRel), '# Design\ncontents', 'utf8');
    await seedWorkflow(featureId, { design: designRel, plan: planRel });

    const outputPath = path.join(tempDir, 'artifacts.zip');
    const res = await handleViewExport({ featureId, output: outputPath }, ctx);
    expect(res.success).toBe(true);
    const data = (res as { data: Record<string, unknown> }).data;

    expect(data.missingArtifacts).toEqual([planRel]);

    const entries = await readZipEntries(await fs.promises.readFile(outputPath));
    const names = [...entries.keys()];

    const designEntry = names.find((n) => n.startsWith('artifacts/design/'));
    expect(designEntry).toBeDefined();
    expect(entries.get(designEntry!)!.toString('utf8')).toBe('# Design\ncontents');

    expect(names.some((n) => n.startsWith('artifacts/plan/'))).toBe(false);

    const metadata = JSON.parse(entries.get('metadata.json')!.toString('utf8'));
    expect(metadata.missingArtifacts).toEqual([planRel]);
    expect(metadata.artifacts).toContain(designEntry);

    const events = await eventStore.query(featureId);
    const executed = events.find((e) => e.type === 'export.executed');
    expect((executed!.data as { missingArtifacts?: string[] }).missingArtifacts).toEqual([planRel]);
  });

  /**
   * The secret file exists outside the base directory. One reference reaches it through `..` and
   * one through an absolute path. The bundle must not hold the bytes of that file in any entry,
   * and both references count as missing.
   */
  it('Export_ArtifactRefEscapingBaseDir_RefusedByBothRoutesAndListedMissing', async () => {
    const featureId = 'traversal-feature';
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'export-outside-'));
    try {
      const secretAbs = path.join(outsideDir, 'secret.txt');
      await writeFile(secretAbs, 'TOP-SECRET-BYTES', 'utf8');

      const viaTraversal = path.relative(tempDir, secretAbs);
      expect(viaTraversal.startsWith('..')).toBe(true);
      await seedWorkflow(featureId, { viaTraversal, viaAbsolute: secretAbs });

      const outputPath = path.join(tempDir, 'traversal.zip');
      const res = await handleViewExport({ featureId, output: outputPath }, ctx);
      expect(res.success).toBe(true);

      const entries = await readZipEntries(await fs.promises.readFile(outputPath));
      const names = [...entries.keys()];
      expect(names.some((n) => n.startsWith('artifacts/viaTraversal/'))).toBe(false);
      expect(names.some((n) => n.startsWith('artifacts/viaAbsolute/'))).toBe(false);
      for (const buf of entries.values()) {
        expect(buf.toString('utf8')).not.toContain('TOP-SECRET-BYTES');
      }
      const data = (res as { data: Record<string, unknown> }).data;
      expect(data.missingArtifacts).toEqual(expect.arrayContaining([viaTraversal, secretAbs]));
    } finally {
      await rmrfAsync(outsideDir);
    }
  });

  /**
   * `path.posix.basename` does not split on `\`, so on Windows it returns the whole absolute path.
   * The entry name must come from the platform basename. On POSIX, both functions pass the test.
   */
  it('Export_AbsoluteInTreeArtifact_EntryNameIsPlatformBasenameNotWholePath', async () => {
    const featureId = 'abs-artifact-feature';
    await mkdir(path.join(tempDir, 'docs', 'specs'), { recursive: true });
    const absArtifact = path.join(tempDir, 'docs', 'specs', 'design.md');
    await writeFile(absArtifact, '# Abs\ncontents', 'utf8');
    await seedWorkflow(featureId, { design: absArtifact });

    const outputPath = path.join(tempDir, 'abs-artifact.zip');
    const res = await handleViewExport({ featureId, output: outputPath }, ctx);
    expect(res.success).toBe(true);

    const entries = await readZipEntries(await fs.promises.readFile(outputPath));
    const names = [...entries.keys()];
    expect(names).toContain('artifacts/design/design.md');
    expect(entries.get('artifacts/design/design.md')!.toString('utf8')).toBe('# Abs\ncontents');
    const designEntry = names.find((n) => n.startsWith('artifacts/design/'))!;
    expect(designEntry).not.toMatch(/[\\:]/);
  });

  /** The output path is an existing directory, which is not a valid destination file. */
  it('Export_InvalidOutputPath_SuggestedFixNoEvents', async () => {
    const featureId = 'invalid-path-feature';
    await seedWorkflow(featureId);
    const before = (await eventStore.query(featureId)).length;

    const res = await handleViewExport({ featureId, output: tempDir }, ctx);
    expect(res.success).toBe(false);
    const error = (res as { error: { code: string; suggestedFix?: unknown } }).error;
    expect(error.code).toBe('INVALID_OUTPUT_PATH');
    expect(error.suggestedFix).toBeDefined();

    const after = (await eventStore.query(featureId)).length;
    expect(after).toBe(before);
    expect(await countByType(featureId, 'export.requested')).toBe(0);
  });

  /** The store holds one other workflow, so the probe of the unknown featureId does not run on an empty store. */
  it('Export_UnknownFeatureId_ExpectedShapeNoZip', async () => {
    await seedWorkflow('some-other-feature');
    const unknown = 'never-initted-feature';
    const defaultOutput = path.join(tempDir, `${unknown}-export.zip`);

    const res = await handleViewExport({ featureId: unknown }, ctx);
    expect(res.success).toBe(true);
    const data = (res as { data: Record<string, unknown> }).data;
    expect(data.workflowExists).toBe(false);
    expect(data.exported).toBe(false);

    expect(fs.existsSync(defaultOutput)).toBe(false);
    expect((await eventStore.query(unknown)).length).toBe(0);
  });

  /** The call goes through `handleView`, so the schema parses the result in the real envelope. */
  it('Export_CompositeSeam_ValidatesAgainstRegisteredOutputSchema', async () => {
    const featureId = 'seam-feature';
    await seedWorkflow(featureId);
    const res = await handleView(
      { action: 'export', featureId, output: path.join(tempDir, 'seam.zip') },
      ctx,
    );
    expect(res.success).toBe(true);
    expect(
      ExportOutputSchema.safeParse(res).success,
      'export envelope must validate against its registered outputSchema',
    ).toBe(true);
  });

  /** For each generated event sequence, a replay of the `events.jsonl` entry equals the live projection of the same store. */
  it('Export_ReplayEqualsProjection_Property', async () => {
    const arbFeatureId = fc.constant('prop-feature');
    const arbTail = fc.array(
      fc.oneof(
        fc.record({
          type: fc.constant('workflow.transition'),
          data: fc.record({ to: fc.constantFrom('plan', 'delegate', 'review', 'synthesize') }),
        }),
        fc.record({
          type: fc.constant('state.patched'),
          data: fc.record({
            featureId: fc.constant('prop-feature'),
            patch: fc.dictionary(
              fc.constantFrom('artifacts.design', 'artifacts.plan'),
              fc.string({ minLength: 1, maxLength: 12 }),
            ),
          }),
        }),
        fc.record({
          type: fc.constant('task.assigned'),
          data: fc.record({
            taskId: fc.string({ minLength: 1, maxLength: 6 }),
            title: fc.string({ maxLength: 12 }),
            branch: fc.string({ minLength: 1, maxLength: 10 }),
          }),
        }),
      ),
      { minLength: 0, maxLength: 12 },
    );

    await fc.assert(
      fc.asyncProperty(arbFeatureId, arbTail, async (featureId, tail) => {
        const runDir = await mkdtemp(path.join(tempDir, 'run-'));
        const store = new EventStore(runDir);
        await store.initialize();
        try {
          await store.append(featureId, {
            type: 'workflow.started',
            data: { featureId, workflowType: 'feature' },
          });
          for (const ev of tail) await store.append(featureId, ev);

          const domainEvents = await store.query(featureId);
          const { buildExportBundle } = await import('../../../../../src/projections/views/lifecycle/export.js');
          const bundle = buildExportBundle(featureId, domainEvents, runDir);
          const jsonl = bundle.entries.get('events.jsonl')!.toString('utf8');
          const replayed = foldEvents(
            jsonl.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as WorkflowEvent),
          );

          const live = await resolveWorkflowState({ featureId, eventStore: store });
          expect('state' in live).toBe(true);
          if ('state' in live) expect(replayed).toEqual(live.state);
        } finally {
          store.close();
        }
      }),
      { numRuns: 30 },
    );
  });
});

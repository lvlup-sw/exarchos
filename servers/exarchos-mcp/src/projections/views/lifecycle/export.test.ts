// ─── Tests for the `export` lifecycle verb (DR-6) ─────────────────────────────
//
// Boundary coverage: every assertion drives a REAL `EventStore` + the REAL
// filesystem (a temp dir) across the composite seam — no hand-mocks of the state
// source or the zip. The named cases pin:
//   • the events.jsonl → state.json round-trip (replaying the bundle's event
//     stream reconstructs its state.json — and the live projection);
//   • the INV-13 two-event split + INV-8 idempotency: a fresh run appends
//     EXACTLY one export.requested + one export.executed with a distinct key;
//   • the crash precheck: a dangling requested is COMPLETED without duplicating
//     the intent (the reused storage key makes the re-emit a cache-hit);
//   • artifacts/ inclusion + missing-reference tolerance (listed in metadata);
//   • the invalid-output-path guard (structured suggestedFix, ZERO events);
//   • the cold-probe side-effect-free invariant (unknown featureId → no zip,
//     ZERO events);
//   • a data-transformation PROPERTY: replay(export(store)) === projection(store)
//     over arbitrary event sequences.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fc } from '@fast-check/vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as yauzl from 'yauzl';
import type { Readable } from 'node:stream';

import { EventStore } from '../../../events/store.js';
import { rmrfAsync } from '../../../test-helpers/temp-dir.js';
import type { DispatchContext } from '../../../dispatch/core/dispatch.js';
import type { WorkflowEvent } from '../../../events/schemas.js';
import { workflowStateProjection } from '../workflow-state-projection.js';
import { resolveWorkflowState } from '../../../verbs/resolve-state.js';
import { handleViewExport, ExportOutputSchema } from './export.js';
import { handleView } from '../composite.js';

let tempDir: string;
let eventStore: EventStore;
let ctx: DispatchContext;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'export-test-'));
  eventStore = new EventStore(tempDir);
  await eventStore.initialize();
  // `cwd` is the base dir the handler resolves the default output path AND
  // referenced-artifact paths against, so everything lands inside the temp dir.
  ctx = { stateDir: tempDir, eventStore, enableTelemetry: false, cwd: tempDir };
});

afterEach(async () => {
  await eventStore.close?.();
  await rmrfAsync(tempDir);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Seed a realistic feature workflow; artifact paths are OPTIONAL overrides. */
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

// ─── Named cases ──────────────────────────────────────────────────────────────

describe('export (DR-6 diagnostic bundle)', () => {
  it('Export_Bundle_ReplayEventsJsonlEqualsStateJson', async () => {
    const featureId = 'round-trip-feature';
    await seedWorkflow(featureId);

    const outputPath = path.join(tempDir, 'bundle.zip');
    const res = await handleViewExport({ featureId, output: outputPath }, ctx);
    expect(res.success).toBe(true);

    // The zip exists on disk and is a real ZIP (PK\x03\x04 magic).
    expect(fs.existsSync(outputPath)).toBe(true);
    const zipBytes = await fs.promises.readFile(outputPath);
    expect(zipBytes.subarray(0, 4).toString('hex')).toBe('504b0304');

    // Read the ACTUAL written bundle back and REPLAY events.jsonl.
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

    // Round-trip: replaying the bundle's events reconstructs its state.json.
    expect(replayedState).toEqual(stateJson);

    // And that state is exactly the LIVE projection over the store (export.*
    // events are identity in the projection, so they do not perturb it).
    const live = await resolveWorkflowState({ featureId, eventStore });
    expect('state' in live).toBe(true);
    if ('state' in live) expect(live.state).toEqual(stateJson);
  });

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

    // A re-run mints a NEW logical key → a NEW pair (never a duplicate intent).
    const second = await handleViewExport(
      { featureId, output: path.join(tempDir, 'b.zip') },
      ctx,
    );
    expect(second.success).toBe(true);
    expect(await countByType(featureId, 'export.requested')).toBe(2);
    expect(await countByType(featureId, 'export.executed')).toBe(2);

    // The two pairs are keyed by DISTINCT idempotencyKeys (INV-8).
    const events = await eventStore.query(featureId);
    const requestedKeys = events
      .filter((e) => e.type === 'export.requested')
      .map((e) => (e.data as { idempotencyKey: string }).idempotencyKey);
    expect(new Set(requestedKeys).size).toBe(2);

    // Each requested has a paired executed carrying the SAME logical key.
    const executedKeys = new Set(
      events
        .filter((e) => e.type === 'export.executed')
        .map((e) => (e.data as { idempotencyKey: string }).idempotencyKey),
    );
    for (const k of requestedKeys) expect(executedKeys.has(k)).toBe(true);

    // INV-13 ORDER (observed on the REAL handler, not a hand-seeded intent): the
    // intent `export.requested` MUST be journaled BEFORE its result
    // `export.executed`. `findDanglingIntent` keys crash-recovery on a
    // requested-WITHOUT-a-paired-executed, so a swapped emission order silently
    // breaks recovery even though the pair COUNTS stay 1:1. Assert strict
    // sequence ordering per logical key — this fails if the two `append()` calls
    // in export.ts are swapped.
    for (const key of new Set(requestedKeys)) {
      const keyOf = (e: WorkflowEvent): string => (e.data as { idempotencyKey: string }).idempotencyKey;
      const requested = events.find((e) => e.type === 'export.requested' && keyOf(e) === key);
      const executed = events.find((e) => e.type === 'export.executed' && keyOf(e) === key);
      expect(requested).toBeDefined();
      expect(executed).toBeDefined();
      expect(requested!.sequence).toBeLessThan(executed!.sequence);
    }
  });

  it('Export_CrashBetweenPair_PrecheckCompletesWithoutDuplicateIntent', async () => {
    const featureId = 'crash-feature';
    await seedWorkflow(featureId);
    const outputPath = path.join(tempDir, 'crash.zip');

    // Simulate a crash between the pair: a durable INTENT with NO paired
    // executed and no zip yet on disk. Emit it with the SAME derived storage key
    // the handler uses, so the handler's re-emit collapses onto it.
    const crashedKey = 'crashed-logical-key';
    await eventStore.append(
      featureId,
      { type: 'export.requested', data: { featureId, outputPath, idempotencyKey: crashedKey } },
      { idempotencyKey: `export.requested:${crashedKey}` },
    );
    expect(await countByType(featureId, 'export.requested')).toBe(1);
    expect(await countByType(featureId, 'export.executed')).toBe(0);
    expect(fs.existsSync(outputPath)).toBe(false);

    // Recover.
    const res = await handleViewExport({ featureId }, ctx);
    expect(res.success).toBe(true);
    const data = (res as { data: Record<string, unknown> }).data;
    expect(data.recovered).toBe(true);
    // The write completed and the bundle landed at the RECORDED intent path.
    expect(data.outputPath).toBe(outputPath);
    expect(fs.existsSync(outputPath)).toBe(true);

    // No DUPLICATE intent: still exactly ONE requested (the re-emit was a
    // cache-hit on the reused storage key) and now exactly ONE executed.
    expect(await countByType(featureId, 'export.requested')).toBe(1);
    expect(await countByType(featureId, 'export.executed')).toBe(1);

    // The executed pairs to the crashed intent's key (INV-8), not a new one.
    const events = await eventStore.query(featureId);
    const executed = events.find((e) => e.type === 'export.executed');
    expect((executed!.data as { idempotencyKey: string }).idempotencyKey).toBe(crashedKey);

    // Idempotent re-recovery: running again over the completed pair mints a new
    // pair (the intent is no longer dangling) but the on-disk zip already matches
    // the deterministic bundle, so the write is SKIPPED.
    const again = await handleViewExport({ featureId, output: outputPath }, ctx);
    const againData = (again as { data: Record<string, unknown> }).data;
    expect(againData.recovered).toBe(false);
    expect(againData.bundleRewritten).toBe(false);
  });

  it('Export_ArtifactsDir_IncludedAndMissingRefsListedInMetadata', async () => {
    const featureId = 'artifacts-feature';
    // design → an artifact FILE that exists; plan → a reference that does NOT.
    const designRel = 'docs/specs/design.md';
    const planRel = 'docs/specs/missing-plan.md';
    await mkdir(path.join(tempDir, 'docs', 'specs'), { recursive: true });
    await writeFile(path.join(tempDir, designRel), '# Design\ncontents', 'utf8');
    await seedWorkflow(featureId, { design: designRel, plan: planRel });

    const outputPath = path.join(tempDir, 'artifacts.zip');
    const res = await handleViewExport({ featureId, output: outputPath }, ctx);
    expect(res.success).toBe(true);
    const data = (res as { data: Record<string, unknown> }).data;

    // The missing reference is tolerated + surfaced on the executed result.
    expect(data.missingArtifacts).toEqual([planRel]);

    const entries = await readZipEntries(await fs.promises.readFile(outputPath));
    const names = [...entries.keys()];

    // The existing artifact FILE is included under artifacts/… with its bytes.
    const designEntry = names.find((n) => n.startsWith('artifacts/design/'));
    expect(designEntry).toBeDefined();
    expect(entries.get(designEntry!)!.toString('utf8')).toBe('# Design\ncontents');

    // No artifact entry was created for the missing reference.
    expect(names.some((n) => n.startsWith('artifacts/plan/'))).toBe(false);

    // metadata.json lists the missing reference and the included entry.
    const metadata = JSON.parse(entries.get('metadata.json')!.toString('utf8'));
    expect(metadata.missingArtifacts).toEqual([planRel]);
    expect(metadata.artifacts).toContain(designEntry);

    // The executed EVENT also records the missing reference (INV-13 result).
    const events = await eventStore.query(featureId);
    const executed = events.find((e) => e.type === 'export.executed');
    expect((executed!.data as { missingArtifacts?: string[] }).missingArtifacts).toEqual([planRel]);
  });

  it('Export_ArtifactRefEscapingBaseDir_RefusedByBothRoutesAndListedMissing', async () => {
    const featureId = 'traversal-feature';
    // A file that EXISTS and is readable, but lives OUTSIDE the workflow tree.
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'export-outside-'));
    try {
      const secretAbs = path.join(outsideDir, 'secret.txt');
      await writeFile(secretAbs, 'TOP-SECRET-BYTES', 'utf8');

      // BOTH escape routes: a `..` traversal relative to baseDir, and a bare
      // absolute path (the old code fed `path.isAbsolute(value) ? value` to
      // statSync/readFileSync with no containment check at all).
      const viaTraversal = path.relative(tempDir, secretAbs);
      expect(viaTraversal.startsWith('..')).toBe(true); // the ref really does escape
      await seedWorkflow(featureId, { viaTraversal, viaAbsolute: secretAbs });

      const outputPath = path.join(tempDir, 'traversal.zip');
      const res = await handleViewExport({ featureId, output: outputPath }, ctx);
      expect(res.success).toBe(true);

      const entries = await readZipEntries(await fs.promises.readFile(outputPath));
      const names = [...entries.keys()];
      // No artifact entry from outside baseDir, by either route …
      expect(names.some((n) => n.startsWith('artifacts/viaTraversal/'))).toBe(false);
      expect(names.some((n) => n.startsWith('artifacts/viaAbsolute/'))).toBe(false);
      // … and the bundle carries the file's bytes NOWHERE (the real assertion:
      // an export zip must never absorb arbitrary readable files).
      for (const buf of entries.values()) {
        expect(buf.toString('utf8')).not.toContain('TOP-SECRET-BYTES');
      }
      // Refused refs degrade to `missing` — tolerated, never a throw.
      const data = (res as { data: Record<string, unknown> }).data;
      expect(data.missingArtifacts).toEqual(expect.arrayContaining([viaTraversal, secretAbs]));
    } finally {
      await rmrfAsync(outsideDir);
    }
  });

  it('Export_AbsoluteInTreeArtifact_EntryNameIsPlatformBasenameNotWholePath', async () => {
    // An absolute, IN-TREE artifact ref. The entry name must be the file's
    // basename: `path.posix.basename()` does not treat `\` as a separator, so on
    // Windows the old code emitted `artifacts/design/C:\…\design.md` as a single
    // entry name. Passes either way on POSIX; this is the Windows lane's pin.
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
    // No drive letter or backslash leaked into the posix entry name (INV-16).
    const designEntry = names.find((n) => n.startsWith('artifacts/design/'))!;
    expect(designEntry).not.toMatch(/[\\:]/);
  });

  it('Export_InvalidOutputPath_SuggestedFixNoEvents', async () => {
    const featureId = 'invalid-path-feature';
    await seedWorkflow(featureId);
    const before = (await eventStore.query(featureId)).length;

    // An EXISTING directory is not a valid destination file.
    const res = await handleViewExport({ featureId, output: tempDir }, ctx);
    expect(res.success).toBe(false);
    const error = (res as { error: { code: string; suggestedFix?: unknown } }).error;
    expect(error.code).toBe('INVALID_OUTPUT_PATH');
    expect(error.suggestedFix).toBeDefined();

    // Side-effect-free on rejection: NO events emitted (no requested, no
    // executed), and the workflow stream is unchanged.
    const after = (await eventStore.query(featureId)).length;
    expect(after).toBe(before);
    expect(await countByType(featureId, 'export.requested')).toBe(0);
  });

  it('Export_UnknownFeatureId_ExpectedShapeNoZip', async () => {
    // Seed an UNRELATED workflow so the store is non-empty — a cold probe must
    // perturb NEITHER stream.
    await seedWorkflow('some-other-feature');
    const unknown = 'never-initted-feature';
    const defaultOutput = path.join(tempDir, `${unknown}-export.zip`);

    const res = await handleViewExport({ featureId: unknown }, ctx);
    expect(res.success).toBe(true);
    const data = (res as { data: Record<string, unknown> }).data;
    expect(data.workflowExists).toBe(false);
    expect(data.exported).toBe(false);

    // No zip written and ZERO events on the probed stream (no phantom stream).
    expect(fs.existsSync(defaultOutput)).toBe(false);
    expect((await eventStore.query(unknown)).length).toBe(0);
  });

  it('Export_CompositeSeam_ValidatesAgainstRegisteredOutputSchema', async () => {
    // Drive the FULL composite seam so the result also validates against the
    // registered ExportOutputSchema through the real envelope wrap.
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

  it('Export_ReplayEqualsProjection_Property', async () => {
    // Data-transformation property: for an arbitrary event sequence in the
    // store, replaying the bundle's events.jsonl reconstructs EXACTLY the live
    // projection over that same store — replay(export(store)) === projection(store).
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
          // export(store): build the bundle from the store's domain events.
          const { buildExportBundle } = await import('./export.js');
          const bundle = buildExportBundle(featureId, domainEvents, runDir);
          const jsonl = bundle.entries.get('events.jsonl')!.toString('utf8');
          const replayed = foldEvents(
            jsonl.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as WorkflowEvent),
          );

          // projection(store): the canonical live fold.
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

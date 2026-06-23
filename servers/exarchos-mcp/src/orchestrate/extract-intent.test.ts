// ─── Extract Intent Tests (DR-1 #1593, task 004) ────────────────────────────
//
// Covers the intent FOUNDATION: a diff-derived floor written to
// `artifacts.intent` via a single state-patch event, optional transcript
// enrichment, and the structural INV-6 guarantee (no `workflowType` branch on
// the intent path). The persist tests drive a REAL event store + stateDir and
// read the intent back via `resolveWorkflowState` — the same canonical surface
// the gates use.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { deriveIntent, persistIntent, type WorkflowIntent } from './extract-intent.js';
import { handleInit } from '../workflow/tools.js';
import { resolveWorkflowState } from './resolve-state.js';
import { EventStore } from '../event-store/store.js';

// ─── Harness ────────────────────────────────────────────────────────────────

let tmpDir: string;
let eventStore: EventStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-intent-'));
  eventStore = new EventStore(tmpDir);
  await eventStore.initialize();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Read `artifacts.intent` back through the canonical event-store projection. */
async function readStoredIntent(featureId: string): Promise<WorkflowIntent | undefined> {
  const resolved = await resolveWorkflowState({ featureId, eventStore });
  if ('error' in resolved) return undefined;
  const artifacts = resolved.state.artifacts as { intent?: WorkflowIntent } | undefined;
  return artifacts?.intent;
}

describe('extract-intent (DR-1 #1593)', () => {
  it('ExtractIntent_DiffDerivedFloor_WritesArtifactsIntent', async () => {
    // ── Pure floor ──────────────────────────────────────────────────────────
    const intent = deriveIntent(['servers/a.ts', 'docs/b.md']);
    expect(intent.source).toBe('diff');
    expect(intent.changedFiles).toEqual(['servers/a.ts', 'docs/b.md']);
    expect(intent.surfaces).toEqual(['docs', 'servers']); // de-duped, sorted top-level prefixes
    expect(intent.summary).toBe('2 files changed across 2 surfaces: docs, servers');
    expect(intent.transcriptSummary).toBeUndefined();

    // ── Persist + read back through the canonical projection ─────────────────
    const featureId = 'intent-floor-feat';
    const init = await handleInit({ featureId, workflowType: 'feature' }, tmpDir, eventStore);
    expect(init.success).toBe(true);

    const result = await persistIntent(featureId, intent, tmpDir, eventStore);
    expect(result.persisted).toBe(true);
    expect(result.warning).toBeUndefined();

    const stored = await readStoredIntent(featureId);
    expect(stored).toBeDefined();
    expect(stored).toEqual(intent);
  });

  it('ExtractIntent_TranscriptPresent_EnrichesIntent', async () => {
    // With a transcript: enriched source + a bounded transcriptSummary.
    const enriched = deriveIntent(['servers/a.ts'], {
      transcript: 'Refactor the dispatch adapter to thread eventStore.\nMore detail follows.',
    });
    expect(enriched.source).toBe('diff+transcript');
    expect(enriched.transcriptSummary).toBe('Refactor the dispatch adapter to thread eventStore.');

    // Without a transcript (and with an empty/whitespace one): floor, no summary.
    const floor = deriveIntent(['servers/a.ts']);
    expect(floor.source).toBe('diff');
    expect(floor.transcriptSummary).toBeUndefined();

    const blank = deriveIntent(['servers/a.ts'], { transcript: '   \n  ' });
    expect(blank.source).toBe('diff');
    expect(blank.transcriptSummary).toBeUndefined();
  });

  it('ExtractIntent_WorkflowAgnostic_NoTypeBranch', async () => {
    // INV-6: the SAME derived intent persists identically regardless of workflow
    // type. `deriveIntent` takes no workflowType (proven by its arity / call
    // shape), and the persist path is type-blind — so a `feature` and a
    // `oneshot` workflow store byte-identical `artifacts.intent`.
    const intent = deriveIntent(['servers/a.ts', 'skills-src/x/SKILL.md', 'docs/y.md']);

    const featureId = 'intent-agnostic-feature';
    const oneshotId = 'intent-agnostic-oneshot';
    expect((await handleInit({ featureId, workflowType: 'feature' }, tmpDir, eventStore)).success).toBe(true);
    expect((await handleInit({ featureId: oneshotId, workflowType: 'oneshot' }, tmpDir, eventStore)).success).toBe(true);

    expect((await persistIntent(featureId, intent, tmpDir, eventStore)).persisted).toBe(true);
    expect((await persistIntent(oneshotId, intent, tmpDir, eventStore)).persisted).toBe(true);

    const featureIntent = await readStoredIntent(featureId);
    const oneshotIntent = await readStoredIntent(oneshotId);
    expect(featureIntent).toEqual(oneshotIntent);
    expect(featureIntent).toEqual(intent);

    // Structural assertion: the derivation's only positional inputs are
    // `(changedFiles, opts?)` — there is NO workflowType parameter. A
    // workflowType would have to be a third positional arg; the function's arity
    // (`changedFiles` + the optional `opts`) is exactly 2, leaving no slot for
    // it. The byte-identical feature/oneshot intents above prove the same code
    // path runs for every type.
    expect(deriveIntent.length).toBe(2);
    // And `opts` carries only `transcript` — never a workflowType-like key — so
    // a type can't sneak in through the options bag either.
    const probe = deriveIntent(['servers/a.ts'], { transcript: 'x' });
    expect(Object.keys(probe).filter((k) => k.toLowerCase().includes('workflowtype'))).toEqual([]);
  });

  it('ExtractIntent_PersistWithoutWorkflow_FailsSoft', async () => {
    // Fail-soft contract: persisting against a featureId with no inited workflow
    // returns `{ persisted: false, warning }` and NEVER throws — review
    // provisioning must survive a state-patch miss.
    const intent = deriveIntent(['servers/a.ts']);
    const result = await persistIntent('no-such-workflow', intent, tmpDir, eventStore);
    expect(result.persisted).toBe(false);
    expect(result.warning).toBeTruthy();
  });
});

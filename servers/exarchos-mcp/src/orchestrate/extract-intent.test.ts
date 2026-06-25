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

import {
  deriveIntent,
  persistIntent,
  readIntent,
  groundBodyInIntent,
  bodyHasIntentMarker,
  isMeaningfulIntent,
  buildIntentSection,
  INTENT_GROUNDING_MARKER,
  type WorkflowIntent,
} from './extract-intent.js';
import { handleInit } from '../workflow/tools.js';
import { resolveWorkflowState } from './resolve-state.js';
import { EventStore } from '../event-store/store.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

// ─── Harness ────────────────────────────────────────────────────────────────

let tmpDir: string;
let eventStore: EventStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-intent-'));
  eventStore = new EventStore(tmpDir);
  await eventStore.initialize();
});

afterEach(async () => {
  await rmrfAsync(tmpDir);
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

// ─── readIntent (DR-1 task 006) ──────────────────────────────────────────────

describe('readIntent (DR-1 task 006)', () => {
  it('ReadIntent_PersistedMeaningfulIntent_RoundTrips', async () => {
    // The READ counterpart of persistIntent: persist a meaningful intent, read it
    // back through the canonical projection-backed reader.
    const intent = deriveIntent(['servers/a.ts', 'docs/b.md']);
    const featureId = 'read-intent-feat';
    expect((await handleInit({ featureId, workflowType: 'feature' }, tmpDir, eventStore)).success).toBe(true);
    expect((await persistIntent(featureId, intent, tmpDir, eventStore)).persisted).toBe(true);

    const read = await readIntent(featureId, eventStore);
    expect(read).toEqual(intent);
  });

  it('ReadIntent_NoFeatureId_ReturnsUndefined', async () => {
    // Degrade: no featureId → undefined, never throws.
    expect(await readIntent(undefined, eventStore)).toBeUndefined();
  });

  it('ReadIntent_NoEventStore_ReturnsUndefined', async () => {
    // Degrade: no event store → undefined, never throws.
    expect(await readIntent('some-feat', undefined)).toBeUndefined();
  });

  it('ReadIntent_NoPersistedIntent_ReturnsUndefined', async () => {
    // A workflow with no `artifacts.intent` → undefined (absent is not an error).
    const featureId = 'read-intent-absent';
    expect((await handleInit({ featureId, workflowType: 'feature' }, tmpDir, eventStore)).success).toBe(true);
    expect(await readIntent(featureId, eventStore)).toBeUndefined();
  });

  it('ReadIntent_UnknownWorkflow_FailsSoftToUndefined', async () => {
    // Unreadable / unknown workflow state → undefined, never throws.
    expect(await readIntent('no-such-workflow-at-all', eventStore)).toBeUndefined();
  });
});

// ─── Body grounding helpers (DR-1 task 006) ──────────────────────────────────

describe('intent body grounding (DR-1 task 006)', () => {
  it('GroundBody_MeaningfulIntent_AppendsIntentSectionAndMarker', () => {
    const intent = deriveIntent(['servers/a.ts', 'docs/b.md']);
    const grounded = groundBodyInIntent('## Summary\n\nDoes a thing.', intent);
    expect(grounded).toContain('## Intent');
    expect(bodyHasIntentMarker(grounded)).toBe(true);
    expect(grounded).toContain('docs, servers'); // surfaces
    expect(grounded).toContain(intent.summary);
    // Original body content is preserved ahead of the appended section.
    expect(grounded.startsWith('## Summary')).toBe(true);
  });

  it('GroundBody_TranscriptSummary_IncludedWhenPresent', () => {
    const intent = deriveIntent(['servers/a.ts'], { transcript: 'Thread the event store through.' });
    const section = buildIntentSection(intent);
    expect(section).toContain('**Context:** Thread the event store through.');
  });

  it('GroundBody_EmptyIntent_LeavesBodyUntouched', () => {
    const empty = deriveIntent([]);
    expect(isMeaningfulIntent(empty)).toBe(false);
    const body = '## Summary\n\nNo files.';
    expect(groundBodyInIntent(body, empty)).toBe(body);
  });

  it('GroundBody_AlreadyMarked_IsIdempotent', () => {
    const intent = deriveIntent(['servers/a.ts']);
    const once = groundBodyInIntent('## Summary\n\nBody.', intent);
    const twice = groundBodyInIntent(once, intent);
    // Second pass is a no-op — the marker appears exactly once.
    expect(twice).toBe(once);
    expect(twice.split(INTENT_GROUNDING_MARKER).length - 1).toBe(1);
  });
});

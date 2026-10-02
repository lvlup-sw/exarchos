// Tests for the workflow intent. `deriveIntent` builds a floor from the diff, and a transcript can
// enrich it. `persistIntent` writes the intent to `artifacts.intent` with one state-patch event. The
// intent path has no branch on `workflowType`. The persist tests use a real event store and read
// the intent back through `resolveWorkflowState`, the same surface that the gates use.

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
} from '../../../../src/verbs/tasks/extract-intent.js';
import { handleInit } from '../../../../src/workflow/tools.js';
import { resolveWorkflowState } from '../../../../src/verbs/resolve-state.js';
import { EventStore } from '../../../../src/events/store.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

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
  /** The surfaces are the sorted, distinct top-level directories of the changed files. */
  it('ExtractIntent_DiffDerivedFloor_WritesArtifactsIntent', async () => {
    const intent = deriveIntent(['servers/a.ts', 'docs/b.md']);
    expect(intent.source).toBe('diff');
    expect(intent.changedFiles).toEqual(['servers/a.ts', 'docs/b.md']);
    expect(intent.surfaces).toEqual(['docs', 'servers']);
    expect(intent.summary).toBe('2 files changed across 2 surfaces: docs, servers');
    expect(intent.transcriptSummary).toBeUndefined();

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

  /**
   * A transcript gives the `diff+transcript` source and a summary from its first line. No
   * transcript, or a blank one, keeps the diff floor with no summary.
   */
  it('ExtractIntent_TranscriptPresent_EnrichesIntent', async () => {
    const enriched = deriveIntent(['servers/a.ts'], {
      transcript: 'Refactor the dispatch adapter to thread eventStore.\nMore detail follows.',
    });
    expect(enriched.source).toBe('diff+transcript');
    expect(enriched.transcriptSummary).toBe('Refactor the dispatch adapter to thread eventStore.');

    const floor = deriveIntent(['servers/a.ts']);
    expect(floor.source).toBe('diff');
    expect(floor.transcriptSummary).toBeUndefined();

    const blank = deriveIntent(['servers/a.ts'], { transcript: '   \n  ' });
    expect(blank.source).toBe('diff');
    expect(blank.transcriptSummary).toBeUndefined();
  });

  /**
   * A `feature` workflow and a `oneshot` workflow store the same `artifacts.intent`. `deriveIntent`
   * takes only `changedFiles` and `opts`, so its arity is 2. The derived intent has no key that names a workflow type.
   */
  it('ExtractIntent_WorkflowAgnostic_NoTypeBranch', async () => {
    const intent = deriveIntent(['servers/a.ts', 'content/x/SKILL.md', 'docs/y.md']);

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

    expect(deriveIntent.length).toBe(2);
    const probe = deriveIntent(['servers/a.ts'], { transcript: 'x' });
    expect(Object.keys(probe).filter((k) => k.toLowerCase().includes('workflowtype'))).toEqual([]);
  });

  /**
   * Without a workflow, `persistIntent` returns `persisted: false` with a warning and does not
   * throw. Review provisioning must survive a failed state patch.
   */
  it('ExtractIntent_PersistWithoutWorkflow_FailsSoft', async () => {
    const intent = deriveIntent(['servers/a.ts']);
    const result = await persistIntent('no-such-workflow', intent, tmpDir, eventStore);
    expect(result.persisted).toBe(false);
    expect(result.warning).toBeTruthy();
  });
});

describe('readIntent (DR-1 task 006)', () => {
  it('ReadIntent_PersistedMeaningfulIntent_RoundTrips', async () => {
    const intent = deriveIntent(['servers/a.ts', 'docs/b.md']);
    const featureId = 'read-intent-feat';
    expect((await handleInit({ featureId, workflowType: 'feature' }, tmpDir, eventStore)).success).toBe(true);
    expect((await persistIntent(featureId, intent, tmpDir, eventStore)).persisted).toBe(true);

    const read = await readIntent(featureId, eventStore);
    expect(read).toEqual(intent);
  });

  it('ReadIntent_NoFeatureId_ReturnsUndefined', async () => {
    expect(await readIntent(undefined, eventStore)).toBeUndefined();
  });

  it('ReadIntent_NoEventStore_ReturnsUndefined', async () => {
    expect(await readIntent('some-feat', undefined)).toBeUndefined();
  });

  it('ReadIntent_NoPersistedIntent_ReturnsUndefined', async () => {
    const featureId = 'read-intent-absent';
    expect((await handleInit({ featureId, workflowType: 'feature' }, tmpDir, eventStore)).success).toBe(true);
    expect(await readIntent(featureId, eventStore)).toBeUndefined();
  });

  it('ReadIntent_UnknownWorkflow_FailsSoftToUndefined', async () => {
    expect(await readIntent('no-such-workflow-at-all', eventStore)).toBeUndefined();
  });
});

describe('intent body grounding (DR-1 task 006)', () => {
  /** The original body stays ahead of the appended section. */
  it('GroundBody_MeaningfulIntent_AppendsIntentSectionAndMarker', () => {
    const intent = deriveIntent(['servers/a.ts', 'docs/b.md']);
    const grounded = groundBodyInIntent('## Summary\n\nDoes a thing.', intent);
    expect(grounded).toContain('## Intent');
    expect(bodyHasIntentMarker(grounded)).toBe(true);
    expect(grounded).toContain('docs, servers');
    expect(grounded).toContain(intent.summary);
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
    expect(twice).toBe(once);
    expect(twice.split(INTENT_GROUNDING_MARKER).length - 1).toBe(1);
  });
});

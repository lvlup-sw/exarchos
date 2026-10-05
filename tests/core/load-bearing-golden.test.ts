/**
 * The golden test of the rehydration document. The document must be load-bearing: an agent that
 * reads only the document can pick a next action that the HSM also computes.
 *
 * The test replays `fixtures/load-bearing/<feature>.events.jsonl` into a fresh store. The reducer
 * must produce the document in `<feature>.expected-document.json`. A stub agent then picks a verb
 * from the document alone, and the verb must be in the HSM-computed `next_actions`.
 *
 * A pull request that changes these fixtures must carry a `GOLDEN-FIXTURE-UPDATE:` line with a
 * reason in its body. `tools/audit/gates/check-golden-fixture-note.mjs` enforces that in CI.
 * The bare import of the rehydration barrel registers the reducer with the default registry.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EventStore } from '../../src/events/store.js';
import {
  RehydrationDocumentSchema,
  type RehydrationDocument,
} from '../../src/projections/rehydration/schema.js';
import '../../src/projections/rehydration/index.js';
import { handleRehydrate } from '../../src/workflow/rehydrate.js';
import { computeNextActions } from '../../src/next-actions-computer.js';
import { getHSMDefinition } from '../../src/workflow/state-machine.js';
import type { NextAction } from '../../src/next-action.js';

const FIXTURE_FEATURE_ID = 'rehydrate-demo';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'load-bearing');
const EVENTS_FIXTURE = path.join(
  FIXTURE_DIR,
  `${FIXTURE_FEATURE_ID}.events.jsonl`,
);
const EXPECTED_DOC_FIXTURE = path.join(
  FIXTURE_DIR,
  `${FIXTURE_FEATURE_ID}.expected-document.json`,
);

/**
 * One line of the events fixture, with `type` and `data` only. `EventStore.append` assigns
 * `sequence`, `timestamp` and `streamId`, so the fixture holds no value that differs between runs.
 */
interface FixtureEventLine {
  readonly type: string;
  readonly data?: Record<string, unknown>;
}

/**
 * Parses a JSONL file into ordered records and skips empty lines. A line that is not JSON, or
 * that has no `type`, throws, so a corrupt fixture fails the test.
 */
async function loadEventsFixture(
  fixturePath: string,
): Promise<FixtureEventLine[]> {
  const raw = await readFile(fixturePath, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  return lines.map((line) => {
    const parsed = JSON.parse(line) as FixtureEventLine;
    if (typeof parsed.type !== 'string' || parsed.type.length === 0) {
      throw new Error(
        `Fixture line missing 'type': ${line.slice(0, 80)}`,
      );
    }
    return parsed;
  });
}

/**
 * Returns the verb that an agent picks from the rehydration document alone. It reads no HSM and no
 * event store. A document with a blocker gives `"blocked"`. Otherwise a phase-to-verb map of the
 * feature workflow gives the forward verb. The map lives in this test, because production code
 * computes the verb from the HSM through `computeNextActions`. A phase that the map does not hold
 * throws.
 */
function stubAgentPicksNextVerb(doc: RehydrationDocument): string {
  if (doc.blockers.length > 0) return 'blocked';

  const phase = doc.workflowState.phase;
  const phaseToForwardVerb: Record<string, string> = {
    ideate: 'plan',
    plan: 'plan-review',
    'plan-review': 'delegate',
    delegate: 'review',
    review: 'synthesize',
    synthesize: 'completed',
  };
  const verb = phaseToForwardVerb[phase];
  if (!verb) {
    throw new Error(
      `stub agent has no forward-verb mapping for phase '${phase}'`,
    );
  }
  return verb;
}

let tempDir: string;
let stateDir: string;
let store: EventStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'load-bearing-golden-'));
  stateDir = tempDir;
  store = new EventStore(tempDir);
});

afterEach(async () => {
  await rmrfAsync(tempDir);
});

describe('LoadBearing_GoldenDocument (T052, DR-15)', () => {
  /**
   * The schema check keeps the fixture inside the document contract. A mismatch with the golden
   * document means that the reducer output drifted from the committed fixture. A stub verb that is
   * absent from `next_actions` means that the document lacks a signal, or that the HSM topology
   * moved away from the fixture.
   */
  it('LoadBearing_AgentReadsDocument_FirstActionMatchesNextAction', async () => {
    const fixtureEvents = await loadEventsFixture(EVENTS_FIXTURE);
    for (const ev of fixtureEvents) {
      await store.append(FIXTURE_FEATURE_ID, {
        type: ev.type as never,
        data: ev.data ?? {},
      });
    }

    const result = await handleRehydrate(
      { featureId: FIXTURE_FEATURE_ID },
      { eventStore: store, stateDir },
    );
    expect(result.success).toBe(true);
    const doc = result.data as RehydrationDocument;

    expect(RehydrationDocumentSchema.safeParse(doc).success).toBe(true);

    const expectedRaw = await readFile(EXPECTED_DOC_FIXTURE, 'utf-8');
    const expectedDoc = JSON.parse(expectedRaw) as RehydrationDocument;
    expect(doc).toEqual(expectedDoc);

    const hsm = getHSMDefinition(doc.workflowState.workflowType);
    const nextActions: readonly NextAction[] = computeNextActions(
      {
        phase: doc.workflowState.phase,
        workflowType: doc.workflowState.workflowType,
      },
      hsm,
    );
    expect(nextActions.length).toBeGreaterThan(0);

    const agentVerb = stubAgentPicksNextVerb(doc);
    const nextActionVerbs = nextActions.map((a) => a.verb);

    expect(nextActionVerbs).toContain(agentVerb);
  });
});

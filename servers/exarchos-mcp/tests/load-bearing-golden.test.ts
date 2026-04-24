/**
 * T052 — Load-bearing golden test (DR-15, C3).
 *
 * The rehydration document must be "load-bearing": an agent reading the
 * document cold — with no follow-up tool call — should be able to pick a
 * next action that matches the HSM-computed `next_actions` for the current
 * phase. This test commits that property as a golden fixture:
 *
 *   1. `fixtures/load-bearing/<feature>.events.jsonl`
 *      A realistic mid-workflow event stream (workflow.started → tasks →
 *      workflow.transition into `plan-review`) — the inputs the reducer
 *      will fold over.
 *
 *   2. `fixtures/load-bearing/<feature>.expected-document.json`
 *      The canonical {@link RehydrationDocument} the reducer must produce
 *      from those events. Structural equality is asserted against this file
 *      so any future reducer drift is caught at CI rather than shipped.
 *
 *   3. A stub "agent" heuristic that inspects only the document (not the
 *      HSM) to pick a verb for the next action. The test asserts this verb
 *      appears in the HSM-computed `next_actions` set — proving the
 *      document alone suffices to drive behaviour.
 *
 * Fixture update policy (DR-15 C3): changes to these fixtures require an
 * explicit `GOLDEN-FIXTURE-UPDATE:` note in the PR body. T053 wires the CI
 * check; this test is the substrate it protects.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EventStore } from '../src/event-store/store.js';
import {
  RehydrationDocumentSchema,
  type RehydrationDocument,
} from '../src/projections/rehydration/schema.js';
// Side-effect import: registers the rehydration reducer with the default
// registry so `handleRehydrate` can resolve it.
import '../src/projections/rehydration/index.js';
import { handleRehydrate } from '../src/workflow/rehydrate.js';
import { computeNextActions } from '../src/next-actions-computer.js';
import { getHSMDefinition } from '../src/workflow/state-machine.js';
import type { NextAction } from '../src/next-action.js';

// ─── Fixture wiring ─────────────────────────────────────────────────────────

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
 * Raw event record as stored in the fixture file: just `type` + `data`.
 * `EventStore.append` assigns `sequence`, `timestamp`, and `streamId` —
 * those are not baked into the fixture so the fixture stays stable across
 * machines (timestamps differ; sequences derive from insertion order).
 */
interface FixtureEventLine {
  readonly type: string;
  readonly data?: Record<string, unknown>;
}

/**
 * Parse a JSONL file into an ordered array of `{ type, data }` records.
 * Empty lines are skipped; invalid JSON lines throw (a corrupt fixture
 * should fail loudly rather than silently skip).
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

// ─── Stub agent ─────────────────────────────────────────────────────────────

/**
 * Reads ONLY the rehydration document (no HSM, no event store) and returns
 * the verb the agent would invoke next. This is deliberately simple: the
 * document itself must carry enough state (phase + blockers) to pick a
 * forward verb.
 *
 * Heuristic:
 *   1. If the document reports a blocker, the agent returns `"blocked"` —
 *      the forward path requires unblocking.
 *   2. Otherwise, project the current phase forward through a minimal
 *      phase → verb map that mirrors the canonical feature-workflow
 *      progress transitions (ideate → plan → delegate → review →
 *      synthesize → completed). This map lives in the test, not in
 *      production code — production code goes through `computeNextActions`
 *      against the HSM. The point of the stub is to prove an agent can
 *      pick a CORRECT verb from the document alone.
 *
 * The test then asserts the verb returned here matches some verb in the
 * HSM-computed `next_actions`. That equivalence is what "load-bearing"
 * means per DR-15.
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

// ─── Test harness ───────────────────────────────────────────────────────────

let tempDir: string;
let stateDir: string;
let store: EventStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'load-bearing-golden-'));
  stateDir = tempDir;
  store = new EventStore(tempDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('LoadBearing_GoldenDocument (T052, DR-15)', () => {
  it('LoadBearing_AgentReadsDocument_FirstActionMatchesNextAction', async () => {
    // ── Given: fixture events are loaded and replayed into a fresh store.
    const fixtureEvents = await loadEventsFixture(EVENTS_FIXTURE);
    for (const ev of fixtureEvents) {
      await store.append(FIXTURE_FEATURE_ID, {
        type: ev.type as never,
        data: ev.data ?? {},
      });
    }

    // ── When: the handler rehydrates the document from the replayed stream.
    const result = await handleRehydrate(
      { featureId: FIXTURE_FEATURE_ID },
      { eventStore: store, stateDir },
    );
    expect(result.success).toBe(true);
    const doc = result.data as RehydrationDocument;

    // Sanity: shape must still satisfy the schema so the fixture cannot
    // silently drift out of the contract.
    expect(RehydrationDocumentSchema.safeParse(doc).success).toBe(true);

    // ── Then: the produced document matches the golden expectation byte-
    // for-byte (via structural equality). A mismatch here means the
    // reducer's output drifted from the committed fixture — regenerate
    // with `GOLDEN-FIXTURE-UPDATE:` note in the PR body (DR-15 C3).
    const expectedRaw = await readFile(EXPECTED_DOC_FIXTURE, 'utf-8');
    const expectedDoc = JSON.parse(expectedRaw) as RehydrationDocument;
    expect(doc).toEqual(expectedDoc);

    // ── And: the HSM's outbound transitions for the current phase include
    // whatever verb the stub agent picks by reading only the document.
    // This is the load-bearing property: the document alone is enough.
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

    // The stub's chosen verb must appear in the HSM-derived next_actions.
    // If it doesn't, either (i) the document is missing a signal the agent
    // needs, or (ii) the HSM topology shifted away from the fixture's
    // assumptions. Either way, a failure flags a load-bearing regression.
    expect(nextActionVerbs).toContain(agentVerb);
  });
});

import { describe, it, expect } from 'vitest';
import { fc } from '@fast-check/vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventTypes, type WorkflowEvent } from '../../event-store/schemas.js';
import type { WorkflowState } from '../../workflow/types.js';
import { SqliteBackend } from '../sqlite-backend.js';
import { hydrateStream } from '../hydration.js';

// ─── Arbitraries ────────────────────────────────────────────────────────────

const MIN_TS = new Date('2020-01-01T00:00:00Z').getTime();
const MAX_TS = new Date('2030-01-01T00:00:00Z').getTime();

/** Generate a valid ISO timestamp string from an integer range. */
const arbTimestamp = fc.integer({ min: MIN_TS, max: MAX_TS }).map((ms) => new Date(ms).toISOString());

/** Arbitrary that generates a valid WorkflowEvent with rich, varied data. */
function arbWorkflowEvent(streamId: string, sequence: number): fc.Arbitrary<WorkflowEvent> {
  return fc.record({
    streamId: fc.constant(streamId),
    sequence: fc.constant(sequence),
    timestamp: arbTimestamp,
    type: fc.constantFrom(...EventTypes),
    schemaVersion: fc.constant('1.0'),
    correlationId: fc.option(fc.uuid(), { nil: undefined }),
    causationId: fc.option(fc.uuid(), { nil: undefined }),
    agentId: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
    agentRole: fc.option(fc.constantFrom('orchestrator', 'implementer', 'reviewer'), { nil: undefined }),
    source: fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
    data: fc.option(
      fc.dictionary(
        fc.string({ minLength: 1, maxLength: 20 }).filter((k) => k !== '__proto__'),
        fc.oneof(
          fc.string({ maxLength: 200 }),
          fc.integer(),
          fc.boolean(),
          fc.constant(null),
          fc.array(fc.oneof(fc.string(), fc.integer(), fc.boolean()), { maxLength: 5 }),
          fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }).filter((k) => k !== '__proto__'), fc.string(), { maxKeys: 3 }),
        ),
        { maxKeys: 5 },
      ),
      { nil: undefined },
    ),
    idempotencyKey: fc.option(fc.uuid(), { nil: undefined }),
  }) as fc.Arbitrary<WorkflowEvent>;
}

/** Arbitrary that generates a valid WorkflowState for legacy migration tests. */
function arbWorkflowState(): fc.Arbitrary<WorkflowState> {
  return fc.record({
    version: fc.constant('1.1'),
    featureId: fc.stringMatching(/^[a-z0-9-]{3,30}$/),
    workflowType: fc.constantFrom('feature' as const, 'debug' as const, 'refactor' as const),
    phase: fc.constantFrom('ideate', 'plan', 'completed', 'cancelled'),
    createdAt: arbTimestamp,
    updatedAt: arbTimestamp,
    artifacts: fc.constant({ design: null, plan: null, pr: null }),
    tasks: fc.constant([]),
    worktrees: fc.constant({}),
    reviews: fc.constant({}),
    integration: fc.constant(null),
    synthesis: fc.constant({
      integrationBranch: null,
      mergeOrder: [],
      mergedBranches: [],
      prUrl: null,
      prFeedback: [],
    }),
    _version: fc.constant(1),
    _history: fc.constant({}),
    _checkpoint: fc.constant({
      timestamp: '1970-01-01T00:00:00Z',
      phase: 'init',
      summary: 'Initial state',
      operationsSince: 0,
      fixCycleCount: 0,
      lastActivityTimestamp: '1970-01-01T00:00:00Z',
      staleAfterMinutes: 120,
    }),
  }) as unknown as fc.Arbitrary<WorkflowState>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hydration-pbt-'));
}

function writeJsonlFile(dir: string, streamId: string, events: WorkflowEvent[]): void {
  const filePath = path.join(dir, `${streamId}.events.jsonl`);
  const content = events.map((e) => JSON.stringify(e)).join('\n') + (events.length > 0 ? '\n' : '');
  fs.writeFileSync(filePath, content, 'utf-8');
}

// ─── Property-Based Tests ───────────────────────────────────────────────────

describe('Hydration Property-Based Tests', () => {
  it('hydration_AnyValidEvent_RoundTripPreservesAllFields', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbWorkflowEvent('roundtrip-stream', 1),
        async (event) => {
          const tempDir = createTempDir();
          const backend = new SqliteBackend(':memory:');
          backend.initialize();

          try {
            // Serialize event to JSONL
            writeJsonlFile(tempDir, 'roundtrip-stream', [event]);

            // Hydrate into fresh backend
            await hydrateStream(backend, tempDir, 'roundtrip-stream');

            // Query the hydrated event
            const stored = backend.queryEvents('roundtrip-stream');
            expect(stored).toHaveLength(1);

            const hydrated = stored[0];

            // All fields must survive the round-trip
            expect(hydrated.streamId).toBe(event.streamId);
            expect(hydrated.sequence).toBe(event.sequence);
            expect(hydrated.timestamp).toBe(event.timestamp);
            expect(hydrated.type).toBe(event.type);
            expect(hydrated.schemaVersion).toBe(event.schemaVersion);

            // Optional fields
            expect(hydrated.correlationId).toBe(event.correlationId);
            expect(hydrated.causationId).toBe(event.causationId);
            expect(hydrated.agentId).toBe(event.agentId);
            expect(hydrated.agentRole).toBe(event.agentRole);
            expect(hydrated.source).toBe(event.source);
            expect(hydrated.idempotencyKey).toBe(event.idempotencyKey);

            // Data (nested object) must be deeply equal
            expect(hydrated.data).toEqual(event.data);
          } finally {
            backend.close();
            fs.rmSync(tempDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('hydration_AnyAppendSequence_MonotonicAfterHydration', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 50 }).chain((count) => {
          // Generate `count` events with sequential sequence numbers
          const eventArbs = Array.from({ length: count }, (_, i) =>
            arbWorkflowEvent('mono-stream', i + 1),
          );
          return fc.tuple(...eventArbs);
        }),
        async (events) => {
          const tempDir = createTempDir();
          const backend = new SqliteBackend(':memory:');
          backend.initialize();

          try {
            // Write all events to JSONL
            writeJsonlFile(tempDir, 'mono-stream', events);

            // Hydrate
            await hydrateStream(backend, tempDir, 'mono-stream');

            // Query back
            const stored = backend.queryEvents('mono-stream');
            expect(stored).toHaveLength(events.length);

            // Verify strictly ascending sequence order
            for (let i = 1; i < stored.length; i++) {
              expect(stored[i].sequence).toBeGreaterThan(stored[i - 1].sequence);
            }

            // Verify sequences are exactly 1..N
            for (let i = 0; i < stored.length; i++) {
              expect(stored[i].sequence).toBe(i + 1);
            }
          } finally {
            backend.close();
            fs.rmSync(tempDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it('hydration_AnyValidState_LegacyMigrationPreservesIdentity', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbWorkflowState(),
        async (state) => {
          const backend = new SqliteBackend(':memory:');
          backend.initialize();

          try {
            // Simulate legacy migration: write state to backend via setState
            backend.setState(state.featureId, state);

            // Read it back via getState
            const retrieved = backend.getState(state.featureId);

            // Must not be null
            expect(retrieved).not.toBeNull();

            // All fields must be preserved through JSON serialization round-trip
            expect(retrieved!.featureId).toBe(state.featureId);
            expect(retrieved!.workflowType).toBe(state.workflowType);
            expect(retrieved!.phase).toBe(state.phase);
            expect(retrieved!.createdAt).toBe(state.createdAt);
            expect(retrieved!.updatedAt).toBe(state.updatedAt);
            expect(retrieved!.version).toBe(state.version);

            // Deep equality for the whole object (JSON round-trip identity)
            expect(retrieved).toEqual(state);
          } finally {
            backend.close();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { EventStore } from '../event-store/store.js';
import type { PRDiffMetadata } from './types.js';

let mockEventStore: EventStore;

// ─── Test Fixtures ──────────────────────────────────────────────────────────

function lowRiskPR(number = 100): PRDiffMetadata {
  return {
    number,
    paths: ['src/utils/format.test.ts'],
    linesChanged: 10,
    filesChanged: 1,
    newFiles: 0,
  };
}

function medRiskPR(number = 200): PRDiffMetadata {
  return {
    number,
    paths: ['src/api/handler.ts'],
    linesChanged: 50,
    filesChanged: 2,
    newFiles: 1,
  };
}

function highRiskPR(number = 300): PRDiffMetadata {
  return {
    number,
    paths: ['src/auth/login.ts', 'src/api/handler.ts'],
    linesChanged: 400,
    filesChanged: 12,
    newFiles: 2,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('handleReviewTriage', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-triage-test-'));
    mockEventStore = new EventStore(tmpDir);
    await mockEventStore.initialize();
  });

  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function importHandler() {
    const { handleReviewTriage } = await import('./tools.js');
    return handleReviewTriage;
  }

  it('should return dispatch results for valid input with 3 PRs', async () => {
    const handleReviewTriage = await importHandler();
    const args = {
      featureId: 'test-feature',
      prs: [lowRiskPR(1), medRiskPR(2), highRiskPR(3)],
      activeWorkflows: [],
      pendingCodeRabbitReviews: 0,
    };

    const result = await handleReviewTriage(args as Record<string, unknown>, tmpDir, mockEventStore);

    expect(result.success).toBe(true);
    const data = result.data as {
      velocity: string;
      dispatches: Array<{ pr: number; coderabbit: boolean; selfHosted: boolean }>;
      summary: { total: number; coderabbit: number; selfHostedOnly: number };
    };
    expect(data.velocity).toBe('normal');
    expect(data.dispatches).toHaveLength(3);
    expect(data.summary.total).toBe(3);
    // At normal velocity (threshold 0.0), all PRs get coderabbit
    expect(data.summary.coderabbit).toBe(3);
    expect(data.summary.selfHostedOnly).toBe(0);
  });

  it('should emit review.routed events to the event store', async () => {
    const handleReviewTriage = await importHandler();
    const args = {
      featureId: 'test-events',
      prs: [lowRiskPR(10), highRiskPR(20)],
      activeWorkflows: [],
      pendingCodeRabbitReviews: 0,
    };

    await handleReviewTriage(args as Record<string, unknown>, tmpDir, mockEventStore);

    // Verify events were written to the JSONL file
    const eventsPath = path.join(tmpDir, 'test-events.events.jsonl');
    const content = await fs.readFile(eventsPath, 'utf-8');
    const events = content.trim().split('\n').map(line => JSON.parse(line));

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('review.routed');
    expect(events[1].type).toBe('review.routed');
    expect(events[0].data.pr).toBe(10);
    expect(events[1].data.pr).toBe(20);
    expect(events[0].data.velocityTier).toBe('normal');
    expect(events[0].data.semanticAugmented).toBe(false);
  });

  it('HandleReviewTriage_DispatchedPR_EmitsReviewRoutedEvent', async () => {
    const handleReviewTriage = await importHandler();
    const args = {
      featureId: 'test-routed-shape',
      prs: [highRiskPR(42)],
      activeWorkflows: [],
      pendingCodeRabbitReviews: 0,
    };

    await handleReviewTriage(args as Record<string, unknown>, tmpDir, mockEventStore);

    // Read the emitted events
    const eventsPath = path.join(tmpDir, 'test-routed-shape.events.jsonl');
    const content = await fs.readFile(eventsPath, 'utf-8');
    const events = content.trim().split('\n').map(line => JSON.parse(line));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('review.routed');

    // Validate shape matches ReviewRoutedData schema
    const { ReviewRoutedData } = await import('../event-store/schemas.js');
    const data = events[0].data as Record<string, unknown>;
    const parseResult = ReviewRoutedData.safeParse(data);
    expect(parseResult.success).toBe(true);

    // Verify specific field values
    expect(data.pr).toBe(42);
    expect(typeof data.riskScore).toBe('number');
    expect(Array.isArray(data.factors)).toBe(true);
    expect(['coderabbit', 'self-hosted', 'both']).toContain(data.destination);
    expect(['normal', 'elevated', 'high']).toContain(data.velocityTier);
    expect(typeof data.semanticAugmented).toBe('boolean');
    expect(data.semanticAugmented).toBe(false);
  });

  it('should filter coderabbit for low-risk PRs at high velocity', async () => {
    const handleReviewTriage = await importHandler();
    const args = {
      featureId: 'test-high-velocity',
      prs: [lowRiskPR(1), highRiskPR(2)],
      activeWorkflows: [],
      pendingCodeRabbitReviews: 8, // >6 triggers 'high' velocity
    };

    const result = await handleReviewTriage(args as Record<string, unknown>, tmpDir, mockEventStore);

    expect(result.success).toBe(true);
    const data = result.data as {
      velocity: string;
      dispatches: Array<{ pr: number; coderabbit: boolean }>;
      summary: { total: number; coderabbit: number; selfHostedOnly: number };
    };
    expect(data.velocity).toBe('high');

    const lowDispatch = data.dispatches.find(d => d.pr === 1);
    const highDispatch = data.dispatches.find(d => d.pr === 2);
    // Low-risk PR (score 0.0) should NOT get coderabbit at high velocity (threshold 0.5)
    expect(lowDispatch?.coderabbit).toBe(false);
    // High-risk PR should get coderabbit
    expect(highDispatch?.coderabbit).toBe(true);
    expect(data.summary.selfHostedOnly).toBeGreaterThan(0);
  });

  it('should return error when featureId is missing', async () => {
    const handleReviewTriage = await importHandler();
    const args = {
      prs: [lowRiskPR()],
    };

    const result = await handleReviewTriage(args as Record<string, unknown>, tmpDir, mockEventStore);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('featureId');
  });

  it('should return empty dispatches for empty prs array', async () => {
    const handleReviewTriage = await importHandler();
    const args = {
      featureId: 'test-empty',
      prs: [],
      activeWorkflows: [],
      pendingCodeRabbitReviews: 0,
    };

    const result = await handleReviewTriage(args as Record<string, unknown>, tmpDir, mockEventStore);

    expect(result.success).toBe(true);
    const data = result.data as {
      dispatches: unknown[];
      summary: { total: number; coderabbit: number; selfHostedOnly: number };
    };
    expect(data.dispatches).toHaveLength(0);
    expect(data.summary.total).toBe(0);
    expect(data.summary.coderabbit).toBe(0);
    expect(data.summary.selfHostedOnly).toBe(0);

    // Verify no events file was created
    const eventsPath = path.join(tmpDir, 'test-empty.events.jsonl');
    await expect(fs.access(eventsPath)).rejects.toThrow();
  });

});

// ─── Orchestrate Composite Integration ──────────────────────────────────────

describe('orchestrate review_triage action', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrate-review-test-'));
  });

  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should route review_triage action to handleReviewTriage', async () => {
    const { handleOrchestrate } = await import('../orchestrate/composite.js');
    const args = {
      action: 'review_triage',
      featureId: 'test-orchestrate',
      prs: [lowRiskPR()],
      activeWorkflows: [],
      pendingCodeRabbitReviews: 0,
    };

    const { EventStore } = await import('../event-store/store.js');
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
    const result = await handleOrchestrate(args as Record<string, unknown>, { stateDir: tmpDir, eventStore, enableTelemetry: false });

    expect(result.success).toBe(true);
    const data = result.data as {
      velocity: string;
      dispatches: Array<{ pr: number }>;
    };
    expect(data.velocity).toBe('normal');
    expect(data.dispatches).toHaveLength(1);
    expect(data.dispatches[0].pr).toBe(100);
  });
});

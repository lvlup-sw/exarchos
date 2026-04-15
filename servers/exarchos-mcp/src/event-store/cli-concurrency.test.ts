// ─── DR-5: Concurrent CLI Invocation Safety ──────────────────────────────────
//
// Integration test: when N CLI processes race to append events to the same
// feature stream, the resulting JSONL must contain every event exactly once
// with monotonic sequence numbers 1..N. Today the EventStore uses a per-PID
// lock that forces non-primary processes into sidecar mode, so concurrent
// CLI invocations silently divert to `{streamId}.hook-events.jsonl` until a
// merge runs. This test pins the end-state that subsequent work must honour.
//
// The test spawns real Node.js child processes (not in-process workers) via
// `tsx`, each of which runs a tiny append driver (`spawn-driver.ts`) that
// exercises the same EventStore append path that the CLI adapter uses.
// Using a focused driver keeps the test hermetic (no SQLite hydration, no
// lifecycle, no config loading) while still reproducing the cross-process
// contention that end-to-end CLI invocations exhibit.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

import { EventStore } from './store.js';
import type { WorkflowEvent } from './schemas.js';

// ─── Test Harness ───────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER_PATH = path.join(HERE, 'spawn-driver.ts');
const PKG_ROOT = path.resolve(HERE, '..', '..');
const TSX_BIN = path.join(PKG_ROOT, 'node_modules', '.bin', 'tsx');

const STREAM_ID = 'concurrency-canary';
const CONCURRENCY = 10;

interface DriverResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Spawn one CLI-equivalent append driver and capture its result. */
function spawnDriver(
  stateDir: string,
  streamId: string,
  index: number,
): Promise<DriverResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      TSX_BIN,
      [
        DRIVER_PATH,
        '--state-dir', stateDir,
        '--stream', streamId,
        '--index', String(index),
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Silence pino logger output in children (keeps stderr clean for assertions)
          EXARCHOS_LOG_LEVEL: 'silent',
        },
      },
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));

    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({
        exitCode: exitCode ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      });
    });
  });
}

// ─── Test ──────────────────────────────────────────────────────────────────

describe('DR-5: concurrent CLI append safety', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-concurrency-'));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it('ConcurrentCliEventAppend_SameFeatureId_ProducesConsistentStore', async () => {
    // Spawn CONCURRENCY child processes in parallel, each appending one
    // event with a distinct idempotency key.
    const drivers = Array.from({ length: CONCURRENCY }, (_, i) =>
      spawnDriver(stateDir, STREAM_ID, i),
    );
    const results = await Promise.all(drivers);

    // All drivers must exit cleanly.
    const failures = results.filter((r) => r.exitCode !== 0);
    if (failures.length > 0) {
      const detail = failures
        .map((r, i) => `[${i}] exit=${r.exitCode} stderr=${r.stderr.trim()} stdout=${r.stdout.trim()}`)
        .join('\n');
      throw new Error(`Some spawned appends failed:\n${detail}`);
    }

    // Read back through a fresh EventStore instance (no backend, JSONL-only)
    // so we see exactly what was persisted to disk.
    const reader = new EventStore(stateDir);
    await reader.initialize();
    const events = await reader.query(STREAM_ID);

    // Assertion 1: every event is present exactly once.
    expect(events.length).toBe(CONCURRENCY);

    // Assertion 2: sequences are the dense set 1..CONCURRENCY, no gaps, no dupes.
    const sequences = events.map((e) => e.sequence).sort((a, b) => a - b);
    const expected = Array.from({ length: CONCURRENCY }, (_, i) => i + 1);
    expect(sequences).toEqual(expected);

    // Assertion 3: every spawned driver's idempotency key made it into the store.
    const keys = new Set(
      events
        .map((e: WorkflowEvent) => e.idempotencyKey)
        .filter((k): k is string => typeof k === 'string'),
    );
    for (let i = 0; i < CONCURRENCY; i++) {
      expect(keys.has(`concurrent-${i}`)).toBe(true);
    }

    // Assertion 4: no half-written records. The JSONL file should parse
    // cleanly line-by-line with no trailing garbage.
    const jsonlPath = path.join(stateDir, `${STREAM_ID}.events.jsonl`);
    const raw = await fs.readFile(jsonlPath, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(CONCURRENCY);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    // Assertion 5: no sidecar leftovers (otherwise events were silently
    // diverted rather than serialized onto the main JSONL).
    const sidecarPath = path.join(stateDir, `${STREAM_ID}.hook-events.jsonl`);
    await expect(fs.access(sidecarPath)).rejects.toThrow();
  }, 60_000);
});

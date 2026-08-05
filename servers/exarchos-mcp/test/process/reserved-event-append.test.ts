// ─── EFF-007: reserved-event append authorization, proven in the PACKAGED runtime
//
// The reserved-proof-event guard is built-in and fail-closed, but SHIP-F001
// records `event.append` among the built-in actions with no located
// compiled-binary/process proof: the guard was verified in-process only. A guard
// that exists in `src/` but is absent (or inert) in the shipped artifact protects
// nothing, and this is the action that would let a caller forge admission
// evidence directly into the log.
//
// These cases drive the COMPILED BINARY over MCP:
//   1. a reserved admission fact is rejected through generic append,
//   2. a reserved cancellation fact is rejected the same way,
//   3. the rejection happens BEFORE persistence — the log stays clean,
//   4. a non-reserved event on the same surface still appends, so the guard is
//      scoped rather than a blanket denial that would merely look safe.
// ─────────────────────────────────────────────────────────────────────────────

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  findRepoRoot,
  ensureBinaryBuilt,
  openFixture,
  closeFixture,
  type Fixture,
} from './_helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = findRepoRoot(__dirname);

let BINARY_PATH: string;

beforeAll(async () => {
  const { binaryPath } = await ensureBinaryBuilt(REPO_ROOT);
  BINARY_PATH = binaryPath;
}, 180_000);

interface ParsedResult {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: { code?: string; message?: string; eventType?: string };
}

async function call(
  fx: Fixture,
  name: string,
  args: Record<string, unknown>,
): Promise<ParsedResult> {
  const result = await fx.client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  expect(Array.isArray(content)).toBe(true);
  const first = content[0];
  expect(first).toBeDefined();
  expect(first?.type).toBe('text');
  return JSON.parse(first!.text) as ParsedResult;
}

describe('packaged reserved-event append authorization (EFF-007)', () => {
  const streamId = 'eff-007-packaged';

  it.each([
    ['admission fact', 'admission.evidence-recorded'],
    ['cancellation fact', 'cancel.compensation-completed'],
  ])(
    'PackagedEventAppend_Reserved_%s_RejectedFailClosed',
    async (_label, eventType) => {
      const fx = await openFixture(BINARY_PATH, REPO_ROOT);
      try {
        const rejected = await call(fx, 'exarchos_event', {
          action: 'append',
          stream: streamId,
          event: { type: eventType, data: { eventVersion: '1.0' } },
        });

        expect(rejected.success, `${eventType} must not append generically`).toBe(false);
        expect(rejected.error?.code).toBe('RESERVED_EVENT_TYPE');
        // The envelope carries the offending type in the message even where the
        // structured field is trimmed, so operators can act on the rejection.
        expect(rejected.error?.message).toContain(eventType);
      } finally {
        await closeFixture(fx);
      }
    },
    60_000,
  );

  it('PackagedEventAppend_RejectedReservedEvent_NeverReachesTheLog', async () => {
    const fx = await openFixture(BINARY_PATH, REPO_ROOT);
    try {
      const rejected = await call(fx, 'exarchos_event', {
        action: 'append',
        stream: streamId,
        event: { type: 'admission.transition-decided', data: { eventVersion: '1.0' } },
      });
      expect(rejected.success).toBe(false);

      // Fail-closed means rejected BEFORE persistence. A guard that denies the
      // caller but still writes the fact would leave forged evidence readable by
      // every projection.
      const queried = await call(fx, 'exarchos_event', {
        action: 'query',
        stream: streamId,
      });
      expect(queried.success).toBe(true);
      const serialized = JSON.stringify(queried.data ?? []);
      expect(serialized).not.toContain('admission.transition-decided');
    } finally {
      await closeFixture(fx);
    }
  }, 60_000);

  it('PackagedEventAppend_NonReservedEvent_StillAppends', async () => {
    // The guard must be scoped to reserved facts. A blanket denial would pass
    // the rejection cases above while breaking the generic append surface.
    const fx = await openFixture(BINARY_PATH, REPO_ROOT);
    try {
      const accepted = await call(fx, 'exarchos_event', {
        action: 'append',
        stream: streamId,
        event: { type: 'task.progressed', data: { taskId: 'eff-007-task', tddPhase: 'green' } },
      });

      expect(accepted.success, JSON.stringify(accepted.error)).toBe(true);
    } finally {
      await closeFixture(fx);
    }
  }, 60_000);
});

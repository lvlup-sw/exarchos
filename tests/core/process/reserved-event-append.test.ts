// Reserved-event append authorization in the packaged runtime.
//
// The guard for reserved proof events is built in and fails closed. A guard that works in `src`
// but is absent or inert in the compiled binary protects nothing. Without the guard,
// `event.append` lets a caller write forged admission evidence into the log. Thus these cases
// call the compiled binary over MCP.
//
// A generic append must reject a reserved admission fact and a reserved cancellation fact. The
// rejection must come before persistence, so the log stays clean. An event that is not reserved
// must still append, which shows that the guard is not a blanket denial.

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

  /**
   * The message must name the rejected type. An operator can then act on the rejection when the
   * envelope omits the structured field.
   */
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
        expect(rejected.error?.message).toContain(eventType);
      } finally {
        await closeFixture(fx);
      }
    },
    60_000,
  );

  /**
   * Fail-closed means that the rejection comes before persistence. A guard that denies the caller
   * but still writes the fact leaves forged evidence in the log, where each projection reads it.
   */
  it('PackagedEventAppend_RejectedReservedEvent_NeverReachesTheLog', async () => {
    const fx = await openFixture(BINARY_PATH, REPO_ROOT);
    try {
      const rejected = await call(fx, 'exarchos_event', {
        action: 'append',
        stream: streamId,
        event: { type: 'admission.transition-decided', data: { eventVersion: '1.0' } },
      });
      expect(rejected.success).toBe(false);

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

  /**
   * The guard must apply only to reserved facts. A blanket denial passes the rejection cases and
   * breaks the generic append surface.
   */
  it('PackagedEventAppend_NonReservedEvent_StillAppends', async () => {
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

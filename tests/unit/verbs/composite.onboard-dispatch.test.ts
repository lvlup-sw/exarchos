/**
 * Regression guard: the `onboard` action must route through `handleOrchestrate`.
 * The onboard unit tests call `handleOnboard` directly, so they stay green when the
 * composite router has no `onboard` branch. Then `{ action: 'onboard' }` falls through to
 * `UNKNOWN_ACTION` on both the CLI and the MCP paths.
 *
 * This file runs the real `handleOnboard` through the real composite router, so no mock can
 * hide a missing branch. It uses an isolated on-disk EventStore and `dryRun: true`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../src/events/store.js';
import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { handleOrchestrate } from '../../../src/verbs/composite.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

interface Fixture {
  readonly repoRoot: string;
  readonly base: string;
  readonly ctx: DispatchContext;
}

/**
 * Creates a temp repo with a Node toolchain marker and an isolated EventStore state dir.
 * The context `cwd` points at the repo, so `defaultOnboardDeps` targets it.
 */
async function createFixture(): Promise<Fixture> {
  const base = await mkdtemp(path.join(tmpdir(), 'onboard-dispatch-'));
  const repoRoot = path.join(base, 'repo');
  const stateDir = path.join(base, 'state');
  await mkdir(repoRoot, { recursive: true });
  await writeFile(
    path.join(repoRoot, 'package.json'),
    JSON.stringify(
      { name: 'fixture', version: '0.0.0', scripts: { 'test:run': 'vitest run' } },
      null,
      2,
    ),
    'utf8',
  );
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  const ctx: DispatchContext = {
    stateDir,
    eventStore,
    enableTelemetry: false,
    cwd: repoRoot,
  };
  return { repoRoot, base, ctx };
}

describe('handleOrchestrate — onboard dispatch (RF-1 #1510)', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    await rmrfAsync(fx.base).catch(
      () => {},
    );
  });

  /**
   * The key check is that the action does not fall through to `UNKNOWN_ACTION`.
   * The composite envelope keeps the dry-run plan in `data`.
   */
  it('routes { action: onboard, dryRun } through the composite router (not UNKNOWN_ACTION)', async () => {
    const result = await handleOrchestrate(
      { action: 'onboard', dryRun: true, surface: 'cli' },
      fx.ctx,
    );

    if (result.success === false) {
      expect(result.error?.code).not.toBe('UNKNOWN_ACTION');
    }
    expect(result.success).toBe(true);

    const data = result.data as { dryRun?: boolean; greenfield?: boolean } | undefined;
    expect(data?.dryRun).toBe(true);
    expect(data?.greenfield).toBe(false);
  });

  it('emits NO onboard events on the dry-run path (plan-only, side-effect-free)', async () => {
    await handleOrchestrate({ action: 'onboard', dryRun: true, surface: 'cli' }, fx.ctx);

    const { ONBOARD_STREAM_ID } = await import('../../../src/dispatch/core/infra-streams.js');
    const events = await fx.ctx.eventStore.query(ONBOARD_STREAM_ID);
    const onboardEvents = events.filter(
      (e) => e.type === 'onboard.requested' || e.type === 'onboard.executed',
    );
    expect(onboardEvents).toHaveLength(0);
  });
});

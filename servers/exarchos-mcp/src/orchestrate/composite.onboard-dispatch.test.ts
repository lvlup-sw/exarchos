/**
 * RF-1 regression guard (epic #1510 review): the `onboard` action MUST route
 * THROUGH `handleOrchestrate`, not just when `handleOnboard` is called directly.
 *
 * The bug this file guards against: `composite.ts` had a special `doctor`
 * dispatch branch but NO `onboard` branch, `handleOnboard` was not imported, and
 * `onboard` was absent from `ACTION_HANDLERS`. So `{ action: 'onboard' }`
 * dispatched through `handleOrchestrate` fell through to `UNKNOWN_ACTION` —
 * breaking BOTH `exarchos onboard` (cli.ts) and the MCP
 * `exarchos_orchestrate {action:'onboard'}` path at runtime — even though every
 * onboard UNIT test passed (they call `handleOnboard` directly, never through
 * the composite router).
 *
 * This test is deliberately NOT in `composite.test.ts`: that file mocks
 * `./onboard/index.js` and `./doctor/index.js`, which would defeat the purpose
 * — a mock would "route" regardless of whether the real branch exists. Here we
 * run the REAL `handleOnboard` through the REAL composite router over an
 * isolated on-disk EventStore, with `dryRun: true` so no side effects land.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import type { DispatchContext } from '../core/dispatch.js';
import { handleOrchestrate } from './composite.js';

interface Fixture {
  readonly repoRoot: string;
  readonly base: string;
  readonly ctx: DispatchContext;
}

/** A temp repo (Node toolchain marker so command resolution works) + an
 * isolated EventStore state dir, wired into a minimal DispatchContext whose
 * `cwd` points at the repo so `defaultOnboardDeps` targets it. */
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
    await rm(fx.base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(
      () => {},
    );
  });

  it('routes { action: onboard, dryRun } through the composite router (not UNKNOWN_ACTION)', async () => {
    const result = await handleOrchestrate(
      { action: 'onboard', dryRun: true, surface: 'cli' },
      fx.ctx,
    );

    // The load-bearing assertion: the action ROUTED — it did NOT fall through to
    // the UNKNOWN_ACTION branch (the symptom of the missing dispatch arm).
    if (result.success === false) {
      expect(result.error?.code).not.toBe('UNKNOWN_ACTION');
    }
    expect(result.success).toBe(true);

    // A dry-run onboard returns the structured plan (greenfield:false, dryRun:true).
    // The composite wraps successes in an envelope, preserving `data`.
    const data = result.data as { dryRun?: boolean; greenfield?: boolean } | undefined;
    expect(data?.dryRun).toBe(true);
    expect(data?.greenfield).toBe(false);
  });

  it('emits NO onboard events on the dry-run path (plan-only, side-effect-free)', async () => {
    await handleOrchestrate({ action: 'onboard', dryRun: true, surface: 'cli' }, fx.ctx);

    const { ONBOARD_STREAM_ID } = await import('../core/infra-streams.js');
    const events = await fx.ctx.eventStore.query(ONBOARD_STREAM_ID);
    const onboardEvents = events.filter(
      (e) => e.type === 'onboard.requested' || e.type === 'onboard.executed',
    );
    expect(onboardEvents).toHaveLength(0);
  });
});

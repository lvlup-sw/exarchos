// ─── #1839 — the divergence must surface AT THE POINT OF USE ─────────────────
//
// Driven through the real `dispatch()` chokepoint rather than the detector, so
// the assertion is about what a caller actually receives: a mutating action
// refuses instead of reporting success, and a read carries the caveat inline
// rather than requiring a separate `doctor` run to discover it.
//
// `HOME` is stubbed into a temp tree so both candidate stores can be created
// hermetically — Node's `os.homedir()` reads `$HOME` on POSIX.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { dispatch } from '../../src/dispatch/core/dispatch.js';
import type { DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../src/events/store.js';
import { ALLOW_STORE_DIVERGENCE_ENV } from '../../src/utils/paths.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

let home: string;
let stateDir: string;
let eventStore: EventStore;

function cliStore(): string {
  return path.join(home, '.exarchos', 'state', 'exarchos.db');
}
function pluginStore(): string {
  return path.join(home, '.claude', 'workflow-state', 'exarchos.db');
}

/** Materialize a store file so the existence probe sees it. */
function createStore(p: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '');
}

function ctx(): DispatchContext {
  return { stateDir, eventStore, enableTelemetry: false };
}

beforeEach(async () => {
  home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'store-divergence-'));
  // The context's store must be the one the AMBIENT cascade resolves — that is
  // the posture the defect occurs in (a CLI falling through to its default
  // store). An explicitly-overridden state dir is unambiguous by construction
  // and is deliberately exempt from the check.
  stateDir = path.join(home, '.exarchos', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  vi.stubEnv('HOME', home);
  // Non-plugin posture, no pin — the default posture of an agent shelling out
  // to `exarchos` from inside a Claude Code session.
  vi.stubEnv('CLAUDE_PLUGIN_ROOT', '');
  vi.stubEnv('EXARCHOS_PLUGIN_ROOT', '');
  vi.stubEnv('WORKFLOW_STATE_DIR', '');
  vi.stubEnv('XDG_STATE_HOME', '');
  vi.stubEnv(ALLOW_STORE_DIVERGENCE_ENV, '');
  eventStore = new EventStore(stateDir);
  await eventStore.initialize();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rmrfAsync(home);
});

describe('Store-path divergence surfaces at the point of use (#1839)', () => {
  it('Mutation_UnderActiveDivergence_IsRefusedNotSilentlyWritten', async () => {
    // Precondition: `os.homedir()` must actually follow the stubbed HOME, or
    // this test would assert nothing.
    expect(os.homedir()).toBe(home);

    createStore(cliStore());
    createStore(pluginStore());

    const result = await dispatch(
      'exarchos_workflow',
      { action: 'init', featureId: 'divergence-probe', workflowType: 'feature' },
      ctx(),
    );

    expect(result.success, 'a write into a ghost store must not report success').toBe(false);
    expect(result.error?.code).toBe('STORE_PATH_DIVERGENCE');
    // The message must be actionable — both paths and the remedy.
    expect(result.error?.message).toContain('WORKFLOW_STATE_DIR');
    expect(result.error?.message).toContain(pluginStore());
  });

  it('Mutation_OtherStoreAbsent_ProceedsNormally', async () => {
    // The standalone CLI user. Divergence is structurally true, but nothing is
    // split — the refusal must not fire.
    createStore(cliStore());

    const result = await dispatch(
      'exarchos_workflow',
      { action: 'init', featureId: 'lone-cli', workflowType: 'feature' },
      ctx(),
    );
    expect(result.error?.code).not.toBe('STORE_PATH_DIVERGENCE');
  });

  it('Mutation_Acknowledged_ProceedsWithTheOptIn', async () => {
    createStore(cliStore());
    createStore(pluginStore());
    vi.stubEnv(ALLOW_STORE_DIVERGENCE_ENV, '1');

    const result = await dispatch(
      'exarchos_workflow',
      { action: 'init', featureId: 'deliberate-two-stores', workflowType: 'feature' },
      ctx(),
    );
    expect(result.error?.code).not.toBe('STORE_PATH_DIVERGENCE');
  });

  it('Read_UnderActiveDivergence_CarriesTheCaveatInline', async () => {
    createStore(cliStore());
    createStore(pluginStore());

    // A read action — must NOT be refused, but must carry the warning, so an
    // envelope like the reported `prepare_delegation` one can no longer read
    // as confidently correct.
    const result = await dispatch('exarchos_view', { action: 'pipeline' }, ctx());

    expect(result.error?.code).not.toBe('STORE_PATH_DIVERGENCE');
    const warnings = result.warnings ?? [];
    expect(warnings.length, 'a divergent read must carry a warning').toBeGreaterThan(0);
    expect(warnings.join(' ')).toContain('Event-store divergence');
    expect(warnings.join(' ')).toContain('WORKFLOW_STATE_DIR');
  });

  it('Mutation_ExplicitStateDir_IsExemptFromTheCheck', async () => {
    // A caller who names the store has already resolved the ambiguity, so the
    // check must stay out of the way. This exemption is what keeps dispatch
    // from behaving differently on a developer machine (where both default
    // stores usually exist) than in CI — without it the verdict would depend
    // on the invoking user's home directory rather than on the call.
    createStore(cliStore());
    createStore(pluginStore());
    const explicit = path.join(home, 'explicitly-chosen-store');
    fs.mkdirSync(explicit, { recursive: true });
    const store = new EventStore(explicit);
    await store.initialize();

    const result = await dispatch(
      'exarchos_workflow',
      { action: 'init', featureId: 'explicit-store', workflowType: 'feature' },
      { stateDir: explicit, eventStore: store, enableTelemetry: false },
    );
    expect(result.error?.code).not.toBe('STORE_PATH_DIVERGENCE');
    // `.join(' ')`, NOT `toContain(expect.stringContaining(...))`. `toContain`
    // compares array members by equality, so an asymmetric matcher is compared
    // as a value and never matches — the assertion could not fail.
    expect(result.warnings?.join(' ') ?? '').not.toContain('Event-store divergence');
  });

  it('Read_NoDivergence_CarriesNoSpuriousWarning', async () => {
    // Pin both surfaces to one store; the warning must disappear entirely
    // rather than becoming permanent noise.
    vi.stubEnv('WORKFLOW_STATE_DIR', stateDir);
    createStore(cliStore());
    createStore(pluginStore());

    const result = await dispatch('exarchos_view', { action: 'pipeline' }, ctx());
    const warnings = result.warnings ?? [];
    expect(warnings.join(' ')).not.toContain('Event-store divergence');
  });
});

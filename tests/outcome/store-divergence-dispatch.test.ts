/**
 * Outcome tests for the store-path divergence check, through the real `dispatch()` entry point.
 *
 * When the CLI store and the plugin store both exist, a mutating action must refuse with
 * `STORE_PATH_DIVERGENCE`. A read must then carry the warning in its envelope.
 *
 * The tests stub `HOME` to a temp directory, so they can create both stores. On POSIX,
 * `os.homedir()` reads `HOME`.
 */

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

/** Creates an empty store file, so the existence check finds it. */
function createStore(p: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '');
}

function ctx(): DispatchContext {
  return { stateDir, eventStore, enableTelemetry: false };
}

/**
 * The state directory of the context is the one that the ambient cascade resolves for a CLI,
 * because the check runs only for that store. The stubs give the non-plugin posture with no pinned
 * store.
 */
beforeEach(async () => {
  home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'store-divergence-'));
  stateDir = path.join(home, '.exarchos', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  vi.stubEnv('HOME', home);
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
  /**
   * `os.homedir()` must follow the stubbed `HOME`, or the test asserts nothing. The message must
   * name the remedy and the path of the other store. The refusal states the divergence one time, so
   * the envelope must carry no warning that repeats it.
   */
  it('Mutation_UnderActiveDivergence_IsRefusedNotSilentlyWritten', async () => {
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
    expect(result.error?.message).toContain('WORKFLOW_STATE_DIR');
    expect(result.error?.message).toContain(pluginStore());
    expect(
      result.warnings ?? [],
      'the refusal already carries the message; it must not be duplicated',
    ).toEqual([]);
  });

  /**
   * The standalone CLI user: the two store paths differ, but only the CLI store exists. No state
   * splits, so the refusal must not fire.
   */
  it('Mutation_OtherStoreAbsent_ProceedsNormally', async () => {
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

  /** A read action must not be refused, but its envelope must carry the divergence warning. */
  it('Read_UnderActiveDivergence_CarriesTheCaveatInline', async () => {
    createStore(cliStore());
    createStore(pluginStore());

    const result = await dispatch('exarchos_view', { action: 'pipeline' }, ctx());

    expect(result.error?.code).not.toBe('STORE_PATH_DIVERGENCE');
    const warnings = result.warnings ?? [];
    expect(warnings.length, 'a divergent read must carry a warning').toBeGreaterThan(0);
    expect(warnings.join(' ')).toContain('Event-store divergence');
    expect(warnings.join(' ')).toContain('WORKFLOW_STATE_DIR');
  });

  /**
   * A caller that names the store resolved the ambiguity, so the check must not run. Without this
   * exemption, the verdict depends on the home directory of the user: a developer machine usually
   * has both default stores, and CI does not.
   *
   * The warning assertion joins the array first. `toContain` compares array members by equality, so
   * an asymmetric matcher never matches and such an assertion cannot fail.
   */
  it('Mutation_ExplicitStateDir_IsExemptFromTheCheck', async () => {
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
    expect(result.warnings?.join(' ') ?? '').not.toContain('Event-store divergence');
  });

  /** `WORKFLOW_STATE_DIR` pins both surfaces to one store, so the read must carry no warning. */
  it('Read_NoDivergence_CarriesNoSpuriousWarning', async () => {
    vi.stubEnv('WORKFLOW_STATE_DIR', stateDir);
    createStore(cliStore());
    createStore(pluginStore());

    const result = await dispatch('exarchos_view', { action: 'pipeline' }, ctx());
    const warnings = result.warnings ?? [];
    expect(warnings.join(' ')).not.toContain('Event-store divergence');
  });
});

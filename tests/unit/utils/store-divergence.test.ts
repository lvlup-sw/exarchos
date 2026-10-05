/**
 * A store divergence must not be silent on the write path.
 * With no pinned store, the CLI resolves `~/.exarchos/state` and the plugin resolves
 * `~/.claude/workflow-state`. So each standalone CLI call diverges, and divergence alone
 * cannot trigger a refusal. The split is active only when the other store exists.
 */

import { describe, it, expect } from 'vitest';

import * as os from 'node:os';
import * as path from 'node:path';

import {
  toPosix,
  resolveStateDir,
  computeStorePathDivergence,
  detectActiveStoreDivergence,
  describeStoreDivergence,
  ALLOW_STORE_DIVERGENCE_ENV,
} from '../../../src/utils/paths.js';

const HOME = '/home/u';
const CLI_STORE = '/home/u/.exarchos/state/exarchos.db';
const PLUGIN_STORE = '/home/u/.claude/workflow-state/exarchos.db';

/** Existence oracle over an explicit set of paths, with no filesystem access. */
function existing(...paths: readonly string[]): (p: string) => boolean {
  const set = new Set(paths);
  return (p) => set.has(p);
}

/**
 * Dispatch treats the store as ambient when
 * `toPosix(path.resolve(ctx.stateDir)) === resolveStateDir()`. The production entry point
 * sets `ctx.stateDir` from `resolveStateDir()`. So that normalization must be idempotent on
 * the resolver output. If it is not, dispatch skips the divergence check, with no refusal and no warning.
 */
describe('The ambient-cascade comparison holds on the real dispatch path', () => {
  /**
   * The test uses the real home directory, because `path.resolve` is drive-relative on win32.
   * A bare `/home/u` gets a drive letter there, and the comparison fails for an unrelated reason.
   */
  it('AmbientCascade_NormalizationOfTheResolverOutput_IsIdempotent', () => {
    const realHome = os.homedir();
    for (const env of [
      {},
      { WORKFLOW_STATE_DIR: path.join(realHome, 'pinned-store') },
      { XDG_STATE_HOME: path.join(realHome, 'xdg') },
    ]) {
      const resolved = resolveStateDir({ env, homedir: realHome });
      expect(
        toPosix(path.resolve(resolved)),
        `dispatch would not recognize its own resolved store dir for env ${JSON.stringify(env)}`,
      ).toBe(resolved);
    }
  });

  /**
   * `path.win32` proves the win32 branch on a POSIX runner.
   * The test above covers only the platform that runs it.
   */
  it('AmbientCascade_WindowsShapedPath_SurvivesTheSameNormalization', () => {
    const resolverOutput = 'C:/Users/runneradmin/.exarchos/state';
    expect(toPosix(path.win32.resolve(resolverOutput))).toBe(resolverOutput);
  });
});

describe('Active store divergence (#1839)', () => {
  /** A CLI call with an empty env diverges. While that holds, divergence alone cannot trigger the refusal. */
  it('Divergence_IsTrueByDefault_ForAnyNonPluginCli', () => {
    const bare = computeStorePathDivergence({ env: {}, homedir: HOME });
    expect(bare.diverges).toBe(true);
    expect(bare.cliPath).toBe(CLI_STORE);
    expect(bare.pluginPath).toBe(PLUGIN_STORE);
  });

  /** A standalone CLI user with no plugin store diverges, but no state splits. */
  it('Divergence_OtherStoreAbsent_IsNotActive', () => {
    const d = detectActiveStoreDivergence({
      env: {},
      homedir: HOME,
      pluginMode: false,
      storeExists: existing(CLI_STORE),
    });
    expect(d.diverges).toBe(true);
    expect(d.otherExists).toBe(false);
    expect(d.active, 'a lone CLI user must not be refused').toBe(false);
  });

  /**
   * The case: an agent runs the CLI from a Claude Code session with no plugin env,
   * while the plugin store holds the workflow.
   */
  it('Divergence_OtherStoreExists_IsActive', () => {
    const d = detectActiveStoreDivergence({
      env: {},
      homedir: HOME,
      pluginMode: false,
      storeExists: existing(CLI_STORE, PLUGIN_STORE),
    });
    expect(d.active).toBe(true);
    expect(d.activePath).toBe(CLI_STORE);
    expect(d.otherPath).toBe(PLUGIN_STORE);
  });

  /** `WORKFLOW_STATE_DIR` wins in both modes, so the two surfaces resolve one store. */
  it('Divergence_WorkflowStateDirPinned_CollapsesEntirely', () => {
    const pinned = { WORKFLOW_STATE_DIR: '/home/u/.claude/workflow-state' };
    const d = detectActiveStoreDivergence({
      env: pinned,
      homedir: HOME,
      pluginMode: false,
      storeExists: existing(CLI_STORE, PLUGIN_STORE),
    });
    expect(d.diverges).toBe(false);
    expect(d.active).toBe(false);
    expect(d.otherExists).toBe(false);
  });

  /**
   * The opt-in stops the refusal and the warning, because a warning on each read adds nothing.
   * `otherExists` stays true, so the split is still detected.
   */
  it('Divergence_Acknowledged_SuppressesBothTheRefusalAndTheWarning', () => {
    const d = detectActiveStoreDivergence({
      env: { [ALLOW_STORE_DIVERGENCE_ENV]: '1' },
      homedir: HOME,
      pluginMode: false,
      storeExists: existing(CLI_STORE, PLUGIN_STORE),
    });
    expect(d.acknowledged).toBe(true);
    expect(d.active, 'an explicit opt-in must not be refused').toBe(false);
    expect(d.shouldWarn, 'an explicit opt-in must not keep warning').toBe(false);
    expect(d.otherExists, 'the split is still detected, only not repeated').toBe(true);
  });

  /**
   * An operator who writes `false` wants the guard.
   * A rule that accepts each non-blank value gives that operator the silent split.
   */
  it('Divergence_ExplicitFalsySpelling_StaysArmed', () => {
    for (const value of ['0', 'false', 'no', 'off', 'FALSE', ' 0 ']) {
      const d = detectActiveStoreDivergence({
        env: { [ALLOW_STORE_DIVERGENCE_ENV]: value },
        homedir: HOME,
        pluginMode: false,
        storeExists: existing(CLI_STORE, PLUGIN_STORE),
      });
      expect(d.acknowledged, `"${value}" must not read as an opt-in`).toBe(false);
      expect(d.active, `"${value}" must leave the refusal armed`).toBe(true);
    }
  });

  /** The active role and the other role depend on the calling surface. */
  it('Divergence_FromThePluginSide_NamesTheCliStoreAsOther', () => {
    const d = detectActiveStoreDivergence({
      env: { CLAUDE_PLUGIN_ROOT: '/opt/plugin' },
      homedir: HOME,
      storeExists: existing(CLI_STORE, PLUGIN_STORE),
    });
    expect(d.activePath).toBe(PLUGIN_STORE);
    expect(d.otherPath).toBe(CLI_STORE);
    expect(d.active).toBe(true);
  });

  /** An operator needs both paths and both env vars to act on the message. */
  it('Description_NamesBothPathsAndTheRemedy', () => {
    const d = detectActiveStoreDivergence({
      env: {},
      homedir: HOME,
      pluginMode: false,
      storeExists: existing(CLI_STORE, PLUGIN_STORE),
    });
    const message = describeStoreDivergence(d);
    expect(message).toContain(CLI_STORE);
    expect(message).toContain(PLUGIN_STORE);
    expect(message).toContain('WORKFLOW_STATE_DIR');
    expect(message).toContain(ALLOW_STORE_DIVERGENCE_ENV);
  });
});

// ─── #1839 — a store divergence must not be silent on the write path ─────────
//
// `computeStorePathDivergence` shipped and was correct, but its only consumer
// was the `store-path-divergence` doctor check. Mutating CLI actions wrote into
// the non-plugin store and reported SUCCESS; reads then answered from that
// store with a coherent, confident, wrong answer. `prepare_delegation` returned
// `taskCount: 20` (right, it saw the new events) alongside `approved: false`
// and `artifactPresent: false` (wrong, those events are in the other store),
// with nothing in the envelope hinting that two stores existed.
//
// The design constraint that shapes the fix: bare divergence is TRUE BY DEFAULT
// for every non-plugin CLI invocation, because the cascade genuinely resolves
// `~/.exarchos/state` for the CLI and `~/.claude/workflow-state` for the
// plugin. Refusing on that alone would break every standalone CLI user who has
// never installed the plugin. Requiring the other store to EXIST is what turns
// an always-true structural fact into evidence of a real split.

import { describe, it, expect } from 'vitest';

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

/** Existence oracle over an explicit set — no filesystem involved. */
function existing(...paths: readonly string[]): (p: string) => boolean {
  const set = new Set(paths);
  return (p) => set.has(p);
}

describe('The ambient-cascade comparison holds on the real dispatch path', () => {
  // dispatch decides whether the store came from the ambient cascade with
  //   toPosix(path.resolve(ctx.stateDir)) === resolveStateDir()
  // and the production entry point sets ctx.stateDir from resolveStateDir()
  // itself. So the comparison is sound exactly when that normalization is
  // IDEMPOTENT on the resolver's own output. If it is not, the check silently
  // stops applying on the one path that matters, and it fails OPEN — no
  // refusal, no warning, and no test anywhere goes red.
  //
  // Asserted as a property rather than by string-matching a platform-specific
  // path, so it holds on win32 (where path.resolve emits backslashes that
  // toPosix must fold back) as well as on POSIX.
  it('AmbientCascade_NormalizationOfTheResolverOutput_IsIdempotent', () => {
    for (const env of [{}, { WORKFLOW_STATE_DIR: '/pinned/store' }, { XDG_STATE_HOME: '/xdg' }]) {
      const resolved = resolveStateDir({ env, homedir: HOME });
      expect(
        toPosix(path.resolve(resolved)),
        `dispatch would not recognize its own resolved store dir for env ${JSON.stringify(env)}`,
      ).toBe(resolved);
    }
  });
});

describe('Active store divergence (#1839)', () => {
  it('Divergence_IsTrueByDefault_ForAnyNonPluginCli', () => {
    // The premise the refusal rule must respect. If this ever stops being
    // true, the "other store must exist" requirement can be revisited — but
    // while it holds, divergence alone cannot be the refusal trigger.
    const bare = computeStorePathDivergence({ env: {}, homedir: HOME });
    expect(bare.diverges).toBe(true);
    expect(bare.cliPath).toBe(CLI_STORE);
    expect(bare.pluginPath).toBe(PLUGIN_STORE);
  });

  it('Divergence_OtherStoreAbsent_IsNotActive', () => {
    // A standalone CLI user who never installed the plugin. Diverges
    // structurally, but nothing is being split — must NOT refuse.
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

  it('Divergence_OtherStoreExists_IsActive', () => {
    // The reported situation: an agent shells out to the CLI from inside a
    // Claude Code session, inheriting no plugin env, while the plugin's store
    // holds the real workflow.
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

  it('Divergence_WorkflowStateDirPinned_CollapsesEntirely', () => {
    // The documented remedy must actually work: the env var wins in BOTH
    // modes, so the two surfaces resolve one store and there is nothing left
    // to warn about.
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

  it('Divergence_Acknowledged_SuppressesBothTheRefusalAndTheWarning', () => {
    const d = detectActiveStoreDivergence({
      env: { [ALLOW_STORE_DIVERGENCE_ENV]: '1' },
      homedir: HOME,
      pluginMode: false,
      storeExists: existing(CLI_STORE, PLUGIN_STORE),
    });
    expect(d.acknowledged).toBe(true);
    expect(d.active, 'an explicit opt-in must not be refused').toBe(false);
    // The variable is named ALLOW. Repeating the caveat on every read after an
    // explicit opt-in is warning fatigue, not information — `doctor` stays the
    // standing diagnostic. The split is still OBSERVED, which is what keeps
    // the suppression a policy choice rather than a blind spot.
    expect(d.shouldWarn, 'an explicit opt-in must not keep warning').toBe(false);
    expect(d.otherExists, 'the split is still detected, only not repeated').toBe(true);
  });

  it('Divergence_ExplicitFalsySpelling_StaysArmed', () => {
    // An operator who writes `=false` means "keep the guard". Treating any
    // non-blank value as opt-in would hand them the silent split instead.
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

  it('Divergence_FromThePluginSide_NamesTheCliStoreAsOther', () => {
    // Symmetry: the "active" and "other" roles follow the calling surface.
    const d = detectActiveStoreDivergence({
      env: { CLAUDE_PLUGIN_ROOT: '/opt/plugin' },
      homedir: HOME,
      storeExists: existing(CLI_STORE, PLUGIN_STORE),
    });
    expect(d.activePath).toBe(PLUGIN_STORE);
    expect(d.otherPath).toBe(CLI_STORE);
    expect(d.active).toBe(true);
  });

  it('Description_NamesBothPathsAndTheRemedy', () => {
    // The message is the whole value of the fix — a bare "divergence detected"
    // gives an operator nothing to act on.
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

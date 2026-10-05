// Unit tests for `resolveInjectionChannel`. It narrows the ordered candidate list of a harness to
// one resolved channel, and it caches the help probe for the process. Each test injects a
// `helpProbe` seam, so no real CLI runs. `beforeEach` clears the cache.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearHelpProbeCache,
  resolveInjectionChannel,
  type HelpProbe,
} from '../../../../src/runtime/launcher/lifecycle-core.js';
import { HARNESS_DESCRIPTORS } from '../../../../src/runtime/launcher/harness-registry.js';

const CLAUDE_CANDIDATES = HARNESS_DESCRIPTORS['claude-code'].injection;
const FILE_FLAG = '--append-system-prompt-file';
const STRING_FLAG = '--append-system-prompt';

describe('resolveInjectionChannel — spawn-time channel probe (DR-6)', () => {
  beforeEach(() => {
    clearHelpProbeCache();
  });

  /** The help text names the two flags. The walk must select the file flag, which the registry lists first. */
  it('channelProbe_FlagPresent_SelectsPrimary', () => {
    const helpProbe: HelpProbe = () =>
      `Usage: claude [options]\n  ${FILE_FLAG} FILE   append system prompt file\n  ${STRING_FLAG} TEXT   append system prompt`;

    const res = resolveInjectionChannel(CLAUDE_CANDIDATES, 'claude', { helpProbe });

    expect(res.degraded).toBe(false);
    expect(res.channel.kind).toBe('flag');
    if (res.channel.kind === 'flag') {
      expect(res.channel.candidate.flag).toBe(FILE_FLAG);
      expect(res.channel.candidate.valueForm).toBe('file');
    }
  });

  /** The help text names only the string flag, so the walk must select the second candidate. */
  it('channelProbe_FlagAbsent_FallsBackToStringFlag', () => {
    const helpProbe: HelpProbe = () =>
      `Usage: claude [options]\n  ${STRING_FLAG} TEXT   append system prompt`;

    const res = resolveInjectionChannel(CLAUDE_CANDIDATES, 'claude', { helpProbe });

    expect(res.degraded).toBe(false);
    expect(res.channel.kind).toBe('flag');
    if (res.channel.kind === 'flag') {
      expect(res.channel.candidate.flag).toBe(STRING_FLAG);
      expect(res.channel.candidate.valueForm).toBe('string');
    }
  });

  /**
   * The probe returns `null`, as it does for a CLI that cannot spawn. The function cannot verify a
   * flag candidate, so it returns `none` with a degradation and does not throw.
   */
  it('channelProbe_CliMissing_ChannelNoneWithDegradation', () => {
    const helpProbe: HelpProbe = () => null;

    const res = resolveInjectionChannel(CLAUDE_CANDIDATES, 'claude', { helpProbe });

    expect(res.channel.kind).toBe('none');
    expect(res.degraded).toBe(true);
    expect(res.degradation).toBeDefined();
    expect(res.degradation).toContain('probe failed');
  });

  /**
   * The help probe runs at most one time for each command in a process. A different command is a
   * different cache key, so the probe runs again.
   */
  it('channelProbe_ResultCachedPerProcess', () => {
    const helpProbe = vi.fn<HelpProbe>(
      () => `Usage: claude\n  ${FILE_FLAG} FILE`,
    );

    const first = resolveInjectionChannel(CLAUDE_CANDIDATES, 'claude', { helpProbe });
    const second = resolveInjectionChannel(CLAUDE_CANDIDATES, 'claude', { helpProbe });

    expect(first.channel.kind).toBe('flag');
    expect(second.channel.kind).toBe('flag');
    expect(helpProbe).toHaveBeenCalledTimes(1);

    resolveInjectionChannel(CLAUDE_CANDIDATES, 'claude-next', { helpProbe });
    expect(helpProbe).toHaveBeenCalledTimes(2);
  });

  /** The function selects an `env` candidate directly, and it does not run the help probe. */
  it('channelProbe_EnvHarness_SelectsEnvWithoutProbing', () => {
    const helpProbe = vi.fn<HelpProbe>(() => 'unused');

    const res = resolveInjectionChannel(
      HARNESS_DESCRIPTORS.copilot.injection,
      'copilot',
      { helpProbe },
    );

    expect(res.channel.kind).toBe('env');
    expect(res.degraded).toBe(false);
    expect(helpProbe).not.toHaveBeenCalled();
  });

  /** Cursor declares `none`. A declared `none` is not a failure, so the result has no degradation. */
  it('channelProbe_CursorNone_ResolvesNoneWithoutDegradation', () => {
    const helpProbe = vi.fn<HelpProbe>(() => 'unused');

    const res = resolveInjectionChannel(
      HARNESS_DESCRIPTORS.cursor.injection,
      'cursor-agent',
      { helpProbe },
    );

    expect(res.channel.kind).toBe('none');
    expect(res.degraded).toBe(false);
    expect(res.degradation).toBeUndefined();
    expect(helpProbe).not.toHaveBeenCalled();
  });
});

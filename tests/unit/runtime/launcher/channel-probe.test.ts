// ─── Spawn-time injection-channel probe (DR-6 / DR-8) ────────────────────────
//
// Unit coverage for `resolveInjectionChannel` — the cached-per-process help
// probe that narrows a harness's preference-ordered candidate list to ONE
// resolved channel. Every test injects a deterministic `helpProbe` seam (no real
// CLI on the host), so the probe path is hermetic. The cache is cleared per test.

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

  it('channelProbe_FlagPresent_SelectsPrimary', () => {
    // Help advertises BOTH flags — the probe must pick the PRIMARY (file) flag,
    // which the registry orders first (preference-ordered walk).
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

  it('channelProbe_FlagAbsent_FallsBackToStringFlag', () => {
    // Help advertises ONLY the string flag — the file flag is absent, so the walk
    // must fall back to the second (string) candidate. The boundary match ensures
    // `--append-system-prompt` is NOT mistaken for `--append-system-prompt-file`.
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

  it('channelProbe_CliMissing_ChannelNoneWithDegradation', () => {
    // The CLI cannot be spawned (probe returns null) — every flag candidate is
    // unverifiable, so the channel degrades to `none` + a recorded degradation
    // (DR-8 fail-open).
    const helpProbe: HelpProbe = () => null;

    const res = resolveInjectionChannel(CLAUDE_CANDIDATES, 'claude', { helpProbe });

    expect(res.channel.kind).toBe('none');
    expect(res.degraded).toBe(true);
    expect(res.degradation).toBeDefined();
    expect(res.degradation).toContain('probe failed');
  });

  it('channelProbe_ResultCachedPerProcess', () => {
    // The help probe runs AT MOST ONCE per process per command — two resolutions
    // for the same command must reuse the cached help output.
    const helpProbe = vi.fn<HelpProbe>(
      () => `Usage: claude\n  ${FILE_FLAG} FILE`,
    );

    const first = resolveInjectionChannel(CLAUDE_CANDIDATES, 'claude', { helpProbe });
    const second = resolveInjectionChannel(CLAUDE_CANDIDATES, 'claude', { helpProbe });

    // Same resolution both times…
    expect(first.channel.kind).toBe('flag');
    expect(second.channel.kind).toBe('flag');
    // …but the underlying (expensive) help spawn happened exactly once.
    expect(helpProbe).toHaveBeenCalledTimes(1);

    // A DIFFERENT command is a distinct cache key — it probes again.
    resolveInjectionChannel(CLAUDE_CANDIDATES, 'claude-next', { helpProbe });
    expect(helpProbe).toHaveBeenCalledTimes(2);
  });

  it('channelProbe_EnvHarness_SelectsEnvWithoutProbing', () => {
    // An `env` candidate (Copilot / OpenCode) is a contract channel — selected
    // directly, with NO help probe spawn.
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

  it('channelProbe_CursorNone_ResolvesNoneWithoutDegradation', () => {
    // Cursor declares `none` — the documented out-of-band fallback is NOT a
    // failure, so it resolves to `none` WITHOUT a degradation.
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

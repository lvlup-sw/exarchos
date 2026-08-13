// ─── Spawn-seam integration: probe → apply → spawn (DR-6 / DR-8, high tier) ──
//
// A REAL cross-process integration test of the injection spawn seam. It writes a
// FAKE harness binary (a POSIX shell script) that:
//   - on `--help`, prints a controllable help text AND appends to a probe-count
//     file (so per-process caching is provable), and
//   - on a normal run, captures its argv + the injected env to a capture file.
//
// The test drives the ACTUAL seam end-to-end — `resolveInjectionChannel` (the
// real win32-safe `--help` probe via `spawnCommandSync`), `applyOrientationChannel`
// (real temp-file materialization for the `file` form), and `spawnHarnessChild`
// (the real cross-OS spawn) — then reads the capture file to assert the resolved
// channel actually reached the child. POSIX-only (skipped on win32, whose spawn
// path is covered by the win32-safe unit seam + the `test-windows` lane).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearHelpProbeCache, resolveInjectionChannel } from './lifecycle-core.js';
import { applyOrientationChannel } from './injection-seam.js';
import { spawnHarnessChild, type AsyncSpawnRequest } from '../../utils/process.js';
import { HARNESS_DESCRIPTORS } from './harness-registry.js';

const CLAUDE_CANDIDATES = HARNESS_DESCRIPTORS['claude-code'].injection;
const FILE_FLAG = '--append-system-prompt-file';
const STRING_FLAG = '--append-system-prompt';
const ORIENT = 'INTEGRATION-ORIENTATION-BODY';

/** Parse a capture file's `KEY=value` lines + the fenced ARGS block. */
function parseCapture(text: string): { args: string[]; env: Record<string, string> } {
  const lines = text.split('\n');
  const args: string[] = [];
  const env: Record<string, string> = {};
  let inArgs = false;
  for (const line of lines) {
    if (line === 'ARGS_START') {
      inArgs = true;
      continue;
    }
    if (line === 'ARGS_END') {
      inArgs = false;
      continue;
    }
    if (inArgs) {
      args.push(line);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return { args, env };
}

describe.skipIf(process.platform === 'win32')(
  'injection spawn seam — fake-harness integration (DR-6)',
  () => {
    let workDir: string;

    beforeEach(() => {
      clearHelpProbeCache();
      workDir = mkdtempSync(path.join(os.tmpdir(), 'inj-integ-'));
    });

    afterEach(() => {
      rmSync(workDir, { recursive: true, force: true });
    });

    /**
     * Write an executable fake-harness script whose `--help` prints `helpText`
     * (and bumps `probeCountFile`) and whose normal run captures argv/env to
     * `captureFile`. Returns the script's absolute path (the spawn `command`).
     */
    function writeFakeHarness(name: string, helpText: string): {
      binPath: string;
      captureFile: string;
      probeCountFile: string;
    } {
      const binPath = path.join(workDir, name);
      const captureFile = path.join(workDir, `${name}.capture`);
      const probeCountFile = path.join(workDir, `${name}.probes`);
      const script = [
        '#!/usr/bin/env bash',
        'if [ "$1" = "--help" ]; then',
        `  echo probe >> ${JSON.stringify(probeCountFile)}`,
        `  cat <<'HELPEOF'`,
        helpText,
        'HELPEOF',
        '  exit 0',
        'fi',
        '{',
        "  printf 'ARGS_START\\n'",
        '  for a in "$@"; do printf \'%s\\n\' "$a"; done',
        "  printf 'ARGS_END\\n'",
        "  printf 'EXARCHOS_ORIENTATION=%s\\n' \"${EXARCHOS_ORIENTATION:-<unset>}\"",
        "  printf 'EXARCHOS_ORIENTATION_AUTHORITY=%s\\n' \"${EXARCHOS_ORIENTATION_AUTHORITY:-<unset>}\"",
        "  printf 'EXARCHOS_DIRECTIVE=%s\\n' \"${EXARCHOS_DIRECTIVE:-<unset>}\"",
        `} > ${JSON.stringify(captureFile)}`,
        'exit 0',
        '',
      ].join('\n');
      writeFileSync(binPath, script, 'utf8');
      chmodSync(binPath, 0o755);
      return { binPath, captureFile, probeCountFile };
    }

    /** Resolve + apply + spawn the fake harness, returning the parsed capture. */
    async function runSeam(
      binPath: string,
      captureFile: string,
    ): Promise<{ resolvedFlag: string | null; capture: ReturnType<typeof parseCapture> }> {
      const resolution = resolveInjectionChannel(CLAUDE_CANDIDATES, binPath);
      const base: AsyncSpawnRequest = {
        command: binPath,
        args: [],
        cwd: workDir,
        env: {},
        stdio: 'ignore',
      };
      const request =
        resolution.channel.kind === 'none'
          ? base
          : applyOrientationChannel(base, resolution.channel, ORIENT);
      const child = await spawnHarnessChild(request);
      await child.exit;
      const capture = parseCapture(readFileSync(captureFile, 'utf8'));
      const resolvedFlag =
        resolution.channel.kind === 'flag' ? resolution.channel.candidate.flag : null;
      return { resolvedFlag, capture };
    }

    it('channelProbe_FlagPresent_SelectsPrimary (spawn seam)', async () => {
      const { binPath, captureFile } = writeFakeHarness(
        'fake-claude-file',
        `Usage: fake\n  ${FILE_FLAG} FILE   append system prompt file\n  ${STRING_FLAG} TEXT   append system prompt`,
      );

      const { resolvedFlag, capture } = await runSeam(binPath, captureFile);

      // The probe selected the PRIMARY (file) flag…
      expect(resolvedFlag).toBe(FILE_FLAG);
      // …and it reached the child's argv, followed by a real temp-file path…
      const flagIdx = capture.args.indexOf(FILE_FLAG);
      expect(flagIdx).toBeGreaterThanOrEqual(0);
      const filePath = capture.args[flagIdx + 1];
      expect(filePath).toBeTruthy();
      // …whose contents are the orientation payload (materialized, no repo write).
      expect(readFileSync(filePath, 'utf8')).toBe(ORIENT);
      // The file-free EXARCHOS_ORIENTATION tag rode the env too; DIRECTIVE never did.
      expect(capture.env.EXARCHOS_ORIENTATION).toBe(ORIENT);
      expect(capture.env.EXARCHOS_DIRECTIVE).toBe('<unset>');
    });

    it('channelProbe_FlagAbsent_FallsBackToStringFlag (spawn seam)', async () => {
      const { binPath, captureFile } = writeFakeHarness(
        'fake-claude-string',
        `Usage: fake\n  ${STRING_FLAG} TEXT   append system prompt`,
      );

      const { resolvedFlag, capture } = await runSeam(binPath, captureFile);

      // The file flag is absent from help → fall back to the string flag…
      expect(resolvedFlag).toBe(STRING_FLAG);
      // …delivered INLINE (the orientation string is the very next argv token).
      const flagIdx = capture.args.indexOf(STRING_FLAG);
      expect(flagIdx).toBeGreaterThanOrEqual(0);
      expect(capture.args[flagIdx + 1]).toBe(ORIENT);
      // The file flag never leaked into argv.
      expect(capture.args).not.toContain(FILE_FLAG);
    });

    it('channelProbe_CliMissing_ChannelNoneWithDegradation (spawn seam)', () => {
      // A command that does not exist on disk — the real probe cannot spawn it, so
      // the channel degrades to none + a recorded degradation, no injection.
      const missing = path.join(workDir, 'does-not-exist-harness');
      const resolution = resolveInjectionChannel(CLAUDE_CANDIDATES, missing);

      expect(resolution.channel.kind).toBe('none');
      expect(resolution.degraded).toBe(true);
      expect(resolution.degradation).toContain('probe failed');
    });

    it('channelProbe_ResultCachedPerProcess (spawn seam)', () => {
      const { binPath, probeCountFile } = writeFakeHarness(
        'fake-claude-cache',
        `Usage: fake\n  ${FILE_FLAG} FILE`,
      );

      // Two resolutions for the SAME command…
      const a = resolveInjectionChannel(CLAUDE_CANDIDATES, binPath);
      const b = resolveInjectionChannel(CLAUDE_CANDIDATES, binPath);
      expect(a.channel.kind).toBe('flag');
      expect(b.channel.kind).toBe('flag');

      // …spawned the real `--help` process EXACTLY once (the probe count file has
      // a single line); the second resolution hit the per-process cache.
      const probeLines = readFileSync(probeCountFile, 'utf8').trim().split('\n');
      expect(probeLines).toHaveLength(1);
    });
  },
);

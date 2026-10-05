// A cross-process integration test of the injection spawn seam. `writeFakeHarness` writes a fake
// harness binary, a bash script. On `--help` the script prints the given help text and appends a
// line to a probe-count file. On a normal run it writes its argv and the orientation and directive
// env values to a capture file. The script is POSIX-only, so the suite does not run on win32.
//
// `runSeam` runs the real seam: `resolveInjectionChannel` with the default `--help` probe,
// `applyOrientationChannel` with a real temp file, and `spawnHarnessChild`. It then parses the
// capture file, which shows what reached the child.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearHelpProbeCache, resolveInjectionChannel } from '../../../../src/runtime/launcher/lifecycle-core.js';
import { applyOrientationChannel } from '../../../../src/runtime/launcher/injection-seam.js';
import { spawnHarnessChild, type AsyncSpawnRequest } from '../../../../src/utils/process.js';
import { HARNESS_DESCRIPTORS } from '../../../../src/runtime/launcher/harness-registry.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

const CLAUDE_CANDIDATES = HARNESS_DESCRIPTORS['claude-code'].injection;
const FILE_FLAG = '--append-system-prompt-file';
const STRING_FLAG = '--append-system-prompt';
const ORIENT = 'INTEGRATION-ORIENTATION-BODY';

/** Parses the `KEY=value` lines and the `ARGS_START` to `ARGS_END` block of a capture file. */
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
      rmrf(workDir);
    });

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

    /**
     * The probe selects the file flag. The flag reaches the argv of the child with a temp-file path,
     * and the temp file holds the orientation. The orientation env key reaches the child too, and
     * the directive key stays unset.
     */
    it('channelProbe_FlagPresent_SelectsPrimary (spawn seam)', async () => {
      const { binPath, captureFile } = writeFakeHarness(
        'fake-claude-file',
        `Usage: fake\n  ${FILE_FLAG} FILE   append system prompt file\n  ${STRING_FLAG} TEXT   append system prompt`,
      );

      const { resolvedFlag, capture } = await runSeam(binPath, captureFile);

      expect(resolvedFlag).toBe(FILE_FLAG);
      const flagIdx = capture.args.indexOf(FILE_FLAG);
      expect(flagIdx).toBeGreaterThanOrEqual(0);
      const filePath = capture.args[flagIdx + 1];
      expect(filePath).toBeTruthy();
      expect(readFileSync(filePath, 'utf8')).toBe(ORIENT);
      expect(capture.env.EXARCHOS_ORIENTATION).toBe(ORIENT);
      expect(capture.env.EXARCHOS_DIRECTIVE).toBe('<unset>');
    });

    /**
     * The help text does not name the file flag, so the probe selects the string flag. The
     * orientation text is the next argv token, and the file flag is not in argv.
     */
    it('channelProbe_FlagAbsent_FallsBackToStringFlag (spawn seam)', async () => {
      const { binPath, captureFile } = writeFakeHarness(
        'fake-claude-string',
        `Usage: fake\n  ${STRING_FLAG} TEXT   append system prompt`,
      );

      const { resolvedFlag, capture } = await runSeam(binPath, captureFile);

      expect(resolvedFlag).toBe(STRING_FLAG);
      const flagIdx = capture.args.indexOf(STRING_FLAG);
      expect(flagIdx).toBeGreaterThanOrEqual(0);
      expect(capture.args[flagIdx + 1]).toBe(ORIENT);
      expect(capture.args).not.toContain(FILE_FLAG);
    });

    /**
     * The command does not exist on disk, so the real probe cannot spawn it. The result is `none`
     * with a degradation.
     */
    it('channelProbe_CliMissing_ChannelNoneWithDegradation (spawn seam)', () => {
      const missing = path.join(workDir, 'does-not-exist-harness');
      const resolution = resolveInjectionChannel(CLAUDE_CANDIDATES, missing);

      expect(resolution.channel.kind).toBe('none');
      expect(resolution.degraded).toBe(true);
      expect(resolution.degradation).toContain('probe failed');
    });

    /**
     * Two resolutions for one command spawn the real `--help` process one time, so the probe-count
     * file holds one line. The second resolution reads the cache.
     */
    it('channelProbe_ResultCachedPerProcess (spawn seam)', () => {
      const { binPath, probeCountFile } = writeFakeHarness(
        'fake-claude-cache',
        `Usage: fake\n  ${FILE_FLAG} FILE`,
      );

      const a = resolveInjectionChannel(CLAUDE_CANDIDATES, binPath);
      const b = resolveInjectionChannel(CLAUDE_CANDIDATES, binPath);
      expect(a.channel.kind).toBe('flag');
      expect(b.channel.kind).toBe('flag');

      const probeLines = readFileSync(probeCountFile, 'utf8').trim().split('\n');
      expect(probeLines).toHaveLength(1);
    });
  },
);

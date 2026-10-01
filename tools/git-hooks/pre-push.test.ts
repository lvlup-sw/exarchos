// Black-box tests for the opt-in pre-push ship-gate hook. The suite runs
// `pre-push.ship-gate.sample` as a POSIX `sh` script, as git runs `.git/hooks/pre-push`,
// so the file mode does not matter. Each test puts a fake `exarchos` stub first on
// PATH. The stub output stands in for the `--json` ToolResult of the ship-path verb.
// The tests assert the exit code of the hook and, where it matters, its stderr.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmrf } from '../test-helpers/temp-dir.js';

import { spawnAsync, type SpawnResult } from '../test-helpers/spawn.js';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = path.join(__dirname, 'pre-push.ship-gate.sample');

/**
 * Writes an executable `exarchos` shell stub that prints `stdout` and exits with `exitCode`.
 * The stub ignores its arguments, so the test runs the wiring of the hook without a real CLI.
 */
function writeStub(dir: string, stdout: string, exitCode = 0): void {
  const stubPath = path.join(dir, 'exarchos');
  const script = `#!/bin/sh\ncat <<'EXARCHOS_STUB_EOF'\n${stdout}\nEXARCHOS_STUB_EOF\nexit ${exitCode}\n`;
  writeFileSync(stubPath, script);
  chmodSync(stubPath, 0o755);
}

/**
 * Runs the hook under `sh` and returns the spawn result. `binName` is the name that
 * the hook resolves on PATH (`EXARCHOS_BIN`). The degrade-open test gives a name that
 * no host has, and keeps the inherited PATH so `sh` still resolves.
 */
function runHook(pathEnv: string, binName = 'exarchos'): Promise<SpawnResult> {
  return spawnAsync('sh', [HOOK_PATH], {
    env: {
      ...process.env,
      PATH: pathEnv,
      EXARCHOS_BIN: binName,
    },
  });
}

describe('pre-push ship-gate hook (DR-5, #1597)', () => {
  let binDir: string;

  beforeEach(() => {
    binDir = mkdtempSync(path.join(tmpdir(), 'ship-gate-hook-'));
  });

  afterEach(() => {
    rmrf(binDir);
  });

  /** Guards against a rename or removal of the script. Its header gives the install steps. */
  it('HookSample_Exists', () => {
    expect(existsSync(HOOK_PATH)).toBe(true);
  });

  /** An advisory verb gives `success:true` with `data.passed:false` on a finding, so the hook must parse the JSON, not the zero exit code. */
  it('PrePushHook_BlockingFinding_BlocksPush', async () => {
    writeStub(
      binDir,
      '{"success":true,"data":{"passed":false,"passCount":1,"failCount":3,"report":"3 lint errors"}}',
      0,
    );
    const result = await runHook(`${binDir}:${process.env.PATH ?? ''}`);
    expect(result.status, `stderr: ${result.stderr}`).toBe(1);
    expect(result.stderr).toMatch(/BLOCKED/);
  });

  it('PrePushHook_Pass_AllowsPush', async () => {
    writeStub(
      binDir,
      '{"success":true,"data":{"passed":true,"passCount":4,"failCount":0,"report":"ok"}}',
      0,
    );
    const result = await runHook(`${binDir}:${process.env.PATH ?? ''}`);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stderr).toMatch(/passed/);
  });

  /**
   * `EXARCHOS_BIN` names a binary that no PATH holds, so `command -v` fails on each host.
   * The hook must degrade open with exit 0 and an actionable message.
   */
  it('PrePushHook_VerbUnavailable_DegradesOpen', async () => {
    const absentBin = 'exarchos-ship-gate-absent-binary';
    const result = await runHook(process.env.PATH ?? '', absentBin);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stderr).toMatch(/not found on PATH/);
  });

  /** The verb ran but gave no pass or block signal, as after a crash or a skipped gate. The hook must allow the push. */
  it('PrePushHook_InconclusiveVerb_DegradesOpen', async () => {
    writeStub(
      binDir,
      '{"success":false,"error":{"code":"SCRIPT_ERROR","message":"boom"}}',
      2,
    );
    const result = await runHook(`${binDir}:${process.env.PATH ?? ''}`);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stderr).toMatch(/could not determine a verdict/);
  });
});

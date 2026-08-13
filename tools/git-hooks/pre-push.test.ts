import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Black-box tests for the opt-in pre-push ship-gate hook (DR-5, #1597) ────
//
// We drive `hooks/pre-push.ship-gate.sample` as a real POSIX `sh` script — the
// same way git would invoke `.git/hooks/pre-push` — via `spawnSync('sh', ...)`,
// so the test is independent of the file's on-disk mode. Per test we write a
// fake `exarchos` stub into a tmp dir and prepend it to PATH; the stub's stdout
// stands in for the ship-path verb's `--json` ToolResult. We assert on the
// hook's EXIT CODE (the block/allow signal git honors) and, where load-bearing,
// its stderr.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = path.join(__dirname, 'pre-push.ship-gate.sample');

/** Write an executable `exarchos` shell stub that prints `stdout` and exits `code`. */
function writeStub(dir: string, stdout: string, exitCode = 0): void {
  const stubPath = path.join(dir, 'exarchos');
  // The stub ignores all args and just emits the canned ToolResult line, so the
  // hook's verb/flag wiring is exercised end-to-end without a real CLI.
  const script = `#!/bin/sh\ncat <<'EXARCHOS_STUB_EOF'\n${stdout}\nEXARCHOS_STUB_EOF\nexit ${exitCode}\n`;
  writeFileSync(stubPath, script);
  chmodSync(stubPath, 0o755);
}

/**
 * Run the hook under `sh`, returning the spawn result.
 *
 * `binName` is the name the hook resolves on PATH (`EXARCHOS_BIN`). Tests that
 * exercise a present engine point it at `exarchos` with the stub dir prepended
 * to PATH; the degrade-open test points it at a guaranteed-absent name so the
 * lookup fails regardless of whether a real `exarchos` is installed — while
 * keeping the inherited PATH intact so `sh` itself still resolves.
 */
function runHook(pathEnv: string, binName = 'exarchos'): ReturnType<typeof spawnSync> {
  return spawnSync('sh', [HOOK_PATH], {
    encoding: 'utf-8',
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
    rmSync(binDir, { recursive: true, force: true });
  });

  it('HookSample_Exists', () => {
    // Guard against the script being renamed/removed out from under the hook
    // installer documented in its header.
    expect(existsSync(HOOK_PATH)).toBe(true);
  });

  it('PrePushHook_BlockingFinding_BlocksPush', () => {
    // Advisory verbs emit success:true with data.passed:false on a finding —
    // the hook must parse the JSON signal, not the (zero) exit code.
    writeStub(
      binDir,
      '{"success":true,"data":{"passed":false,"passCount":1,"failCount":3,"report":"3 lint errors"}}',
      0,
    );
    const result = runHook(`${binDir}:${process.env.PATH ?? ''}`);
    expect(result.status, `stderr: ${result.stderr}`).toBe(1);
    expect(result.stderr).toMatch(/BLOCKED/);
  });

  it('PrePushHook_Pass_AllowsPush', () => {
    writeStub(
      binDir,
      '{"success":true,"data":{"passed":true,"passCount":4,"failCount":0,"report":"ok"}}',
      0,
    );
    const result = runHook(`${binDir}:${process.env.PATH ?? ''}`);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stderr).toMatch(/passed/);
  });

  it('PrePushHook_VerbUnavailable_DegradesOpen', () => {
    // Engine unavailable: point EXARCHOS_BIN at a name that resolves on no
    // PATH so `command -v` fails — regardless of whether a real `exarchos` is
    // installed on the test host. The inherited PATH stays intact so `sh`
    // itself still resolves. The hook must degrade-open (exit 0) with an
    // actionable message, never wedge the push on a missing optional tool
    // (POLA).
    const absentBin = 'exarchos-ship-gate-absent-binary';
    const result = runHook(process.env.PATH ?? '', absentBin);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stderr).toMatch(/not found on PATH/);
  });

  it('PrePushHook_InconclusiveVerb_DegradesOpen', () => {
    // The verb ran but emitted no pass/block signal (e.g. a crash or a skipped
    // gate). "Couldn't run" must be distinct from "gate says block": allow the
    // push rather than wedge it on an inconclusive verdict.
    writeStub(
      binDir,
      '{"success":false,"error":{"code":"SCRIPT_ERROR","message":"boom"}}',
      2,
    );
    const result = runHook(`${binDir}:${process.env.PATH ?? ''}`);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stderr).toMatch(/could not determine a verdict/);
  });
});

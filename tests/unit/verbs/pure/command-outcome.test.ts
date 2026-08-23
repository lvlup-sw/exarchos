// ─── Command Failure Classification Tests ───────────────────────────────────
//
// The discriminant these tests pin is the one the gates depend on: a process
// that EXITED produced a verdict; a process that never started, or was killed
// at its wall clock, produced none. Every gate in this lane branches on that
// distinction, so a regression here turns "nothing was measured" back into
// "something failed" at five call sites at once.

import { describe, it, expect } from 'vitest';
import {
  classifyCommandFailure,
  inconclusiveReason,
} from '../../../../src/verbs/pure/command-outcome.js';

/** An `execFileSync` throw for a process that ran and exited non-zero. */
function exited(status: number, extra: Record<string, unknown> = {}): unknown {
  return Object.assign(new Error(`Command failed with exit code ${status}`), {
    status,
    ...extra,
  });
}

/** An `execFileSync` throw carrying an errno and NO numeric exit status. */
function errno(code: string, extra: Record<string, unknown> = {}): unknown {
  return Object.assign(new Error(`spawnSync somecmd ${code}`), { code, ...extra });
}

describe('classifyCommandFailure', () => {
  it('NumericStatus_IsAVerdict', () => {
    const failure = classifyCommandFailure(exited(1));
    expect(failure.kind).toBe('exit');
    expect(failure.exitCode).toBe(1);
  });

  it('NumericStatus_WinsOverAnErrno', () => {
    // The status is checked FIRST on purpose. A process that exited decided
    // something, whatever incidental `code` the error also carries.
    const failure = classifyCommandFailure(exited(2, { code: 'ENOENT' }));
    expect(failure.kind).toBe('exit');
    expect(failure.exitCode).toBe(2);
  });

  it.each(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ENOMEM'])(
    'SpawnErrno_%s_IsNotAVerdict',
    (code) => {
      const failure = classifyCommandFailure(errno(code));
      expect(failure.kind).toBe('spawn');
      expect(failure.detail).toContain(code);
    },
  );

  it('Timeout_IsItsOwnArm_NotASpawnFailure', () => {
    const failure = classifyCommandFailure(errno('ETIMEDOUT'));
    expect(failure.kind).toBe('timeout');
  });

  it('OutputCeilingKill_StaysAVerdict_NotASpawnFailure', () => {
    // The child DID run; the ceiling killed it afterwards. Folding this into
    // `spawn` would withdraw a finding the runner really produced.
    const failure = classifyCommandFailure(errno('ERR_CHILD_PROCESS_STDIO_MAXBUFFER'));
    expect(failure.kind).toBe('exit');
  });

  it('CapturesBothStreams_IncludingBuffers', () => {
    const failure = classifyCommandFailure(
      exited(1, { stdout: Buffer.from('out'), stderr: 'err' }),
    );
    expect(failure.stdout).toBe('out');
    expect(failure.stderr).toBe('err');
  });

  it('DetailKeepsOnlyTheFirstMessageLine', () => {
    const failure = classifyCommandFailure(
      Object.assign(new Error('boom\nline two\nline three'), { code: 'ENOENT' }),
    );
    expect(failure.detail).toBe('ENOENT: boom');
  });

  it('NonObjectThrow_LandsOnTheVerdictArm', () => {
    // Total over `unknown`, and conservative: the arm that keeps a finding,
    // not the arm that withdraws one.
    const failure = classifyCommandFailure('a bare string');
    expect(failure.kind).toBe('exit');
    expect(failure.detail).toBeTruthy();
  });
});

describe('inconclusiveReason', () => {
  it('ExitFailure_HasNoReason', () => {
    expect(inconclusiveReason('npm test', classifyCommandFailure(exited(1)))).toBeNull();
  });

  it('SpawnFailure_NamesTheCommandAndTheCause', () => {
    const reason = inconclusiveReason('cargo test', classifyCommandFailure(errno('ENOENT')));
    expect(reason).toContain('cargo test');
    expect(reason).toContain('ENOENT');
  });

  it('Timeout_SaysItWasKilled_NotThatItFailed', () => {
    const reason = inconclusiveReason('pytest', classifyCommandFailure(errno('ETIMEDOUT')));
    expect(reason).toContain('time limit');
    expect(reason).not.toContain('failed');
  });
});

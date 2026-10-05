import { spawn } from 'node:child_process';

export interface SandboxOptions {
  timeLimitMs: number;
  workDir: string;
  /** Byte limit for each of stdout and stderr. The default is 1 MB. */
  maxOutputBytes?: number;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Runs a command with a time limit and an output limit. The promise never rejects.
 * A spawn failure resolves with the error message in `stderr` and a null exit code.
 * When stdout or stderr exceeds the byte limit, the result keeps only the bytes that fit.
 *
 * The process runs detached, so the timeout kills its whole process group, child processes included.
 * When the group kill fails, the timeout kills only the process. It ignores a second failure, because the process can exit first.
 */
export async function runInSandbox(
  command: string,
  args: string[],
  input: string,
  options: SandboxOptions
): Promise<SandboxResult> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return new Promise<SandboxResult>((resolve) => {
    let timedOut = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    let proc;
    try {
      proc = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: options.workDir,
        detached: true,
      });
    } catch (err) {
      resolve({
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: null,
        timedOut: false,
        truncated: false,
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      if (proc.pid === undefined) return;
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        try {
          proc.kill('SIGKILL');
        } catch {
        }
      }
    }, options.timeLimitMs);

    proc.stdout.on('data', (chunk: Buffer) => {
      if (stdoutTruncated) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        const remaining = maxOutputBytes - (stdoutBytes - chunk.length);
        if (remaining > 0) {
          stdoutChunks.push(chunk.subarray(0, remaining));
        }
        stdoutTruncated = true;
      } else {
        stdoutChunks.push(chunk);
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      if (stderrTruncated) return;
      stderrBytes += chunk.length;
      if (stderrBytes > maxOutputBytes) {
        const remaining = maxOutputBytes - (stderrBytes - chunk.length);
        if (remaining > 0) {
          stderrChunks.push(chunk.subarray(0, remaining));
        }
        stderrTruncated = true;
      } else {
        stderrChunks.push(chunk);
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        exitCode: code,
        timedOut,
        truncated: stdoutTruncated || stderrTruncated,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: err.message,
        exitCode: null,
        timedOut,
        truncated: stdoutTruncated || stderrTruncated,
      });
    });

    if (input) {
      proc.stdin.write(input, () => {
        proc.stdin.end();
      });
    } else {
      proc.stdin.end();
    }
  });
}

import { execFile, spawn } from 'node:child_process';
import { mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { runInSandbox } from './sandbox.js';

export interface CompileResult {
  success: boolean;
  executablePath?: string;
  error?: string;
}

export interface ExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

type Language = 'cpp' | 'python' | 'typescript';

const EXTENSION_MAP: Record<string, Language> = {
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.py': 'python',
  '.ts': 'typescript',
};

export function detectLanguage(solutionPath: string): Language {
  const ext = extname(solutionPath).toLowerCase();
  const lang = EXTENSION_MAP[ext];
  if (!lang) {
    throw new Error(`Unsupported file extension: ${ext}`);
  }
  return lang;
}

/**
 * Compiles a C++ solution with g++. Python and TypeScript need no compilation, so the source path
 * is the executable path.
 *
 * MinGW g++ on Windows appends `.exe` to an `-o` target with no dot in its name, so the output
 * path ends in `.exe` on win32.
 *
 * The g++ timeout is 30 seconds, and 60 seconds on win32. A cold g++ on a loaded win32 runner
 * can exceed 30 seconds. An exceeded timeout does not look like a timeout: `execFile` reports an
 * error, and the result is `success: false`. Both values must stay below the 90-second timeout
 * of the cold-compile test, so the g++ timeout ends a slow compile first.
 */
export async function compile(solutionPath: string, language?: string): Promise<CompileResult> {
  const lang = language ?? detectLanguage(solutionPath);

  if (lang === 'python' || lang === 'typescript') {
    return { success: true, executablePath: solutionPath };
  }

  if (lang === 'cpp') {
    const tmpDir = join(dirname(solutionPath), '.tmp');
    mkdirSync(tmpDir, { recursive: true });

    const baseName = basename(solutionPath, extname(solutionPath));
    const outputPath = join(tmpDir, baseName) + (process.platform === 'win32' ? '.exe' : '');

    return new Promise<CompileResult>((resolve) => {
      execFile(
        'g++',
        ['-O2', '-std=c++17', '-o', outputPath, solutionPath],
        { timeout: process.platform === 'win32' ? 60_000 : 30_000 },
        (error, _stdout, stderr) => {
          if (error) {
            resolve({ success: false, error: stderr || error.message });
          } else {
            resolve({ success: true, executablePath: outputPath });
          }
        }
      );
    });
  }

  return { success: false, error: `Unsupported language: ${lang}` };
}

export async function execute(
  executablePath: string,
  input: string,
  timeLimitMs: number
): Promise<ExecuteResult> {
  return new Promise<ExecuteResult>((resolve) => {
    let timedOut = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    let proc;
    try {
      proc = spawn(executablePath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      resolve({
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: null,
        timedOut: false,
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      if (proc.pid !== undefined) {
        killProcessGroup(proc.pid);
      }
    }, timeLimitMs);

    proc.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        exitCode: code,
        timedOut,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: err.message,
        exitCode: null,
        timedOut,
      });
    });

    if (input) {
      proc.stdin.write(input, () => proc.stdin.end());
    } else {
      proc.stdin.end();
    }
  });
}

/**
 * Compiles a solution and runs it in the sandbox. The result omits `compileError` when the
 * compiler gave no message, because `exactOptionalPropertyTypes` rejects an explicit `undefined`.
 * After a C++ run, the function deletes the temp executable and ignores a failure of the delete.
 */
export async function runSolution(
  solutionPath: string,
  input: string,
  timeLimitMs: number
): Promise<ExecuteResult & { compiled: boolean; compileError?: string }> {
  const compileResult = await compile(solutionPath);

  if (!compileResult.success) {
    return {
      stdout: '',
      stderr: compileResult.error ?? '',
      exitCode: null,
      timedOut: false,
      compiled: false,
      ...(compileResult.error === undefined ? {} : { compileError: compileResult.error }),
    };
  }

  const lang = detectLanguage(solutionPath);
  const workDir = dirname(solutionPath);

  const { command, args } = resolveExecution(lang, compileResult.executablePath!, solutionPath);

  const sandboxResult = await runInSandbox(command, args, input, {
    timeLimitMs,
    workDir,
  });

  if (lang === 'cpp' && compileResult.executablePath) {
    try { unlinkSync(compileResult.executablePath); } catch { }
  }

  return {
    stdout: sandboxResult.stdout,
    stderr: sandboxResult.stderr,
    exitCode: sandboxResult.exitCode,
    timedOut: sandboxResult.timedOut,
    compiled: true,
  };
}

/** Resolve the command and arguments for executing a solution by language. */
function resolveExecution(
  lang: Language,
  executablePath: string,
  sourcePath: string
): { command: string; args: string[] } {
  switch (lang) {
    case 'python':
      return { command: 'python3', args: [sourcePath] };
    case 'typescript':
      return { command: 'npx', args: ['tsx', sourcePath] };
    case 'cpp':
      return { command: executablePath, args: [] };
  }
}

/**
 * Kills a process group by negated PID, and falls back to a direct kill. When both kills fail,
 * the process already exited.
 */
function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
    }
  }
}

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

export async function compile(solutionPath: string, language?: string): Promise<CompileResult> {
  const lang = language ?? detectLanguage(solutionPath);

  // Interpreted languages need no compilation
  if (lang === 'python' || lang === 'typescript') {
    return { success: true, executablePath: solutionPath };
  }

  if (lang === 'cpp') {
    const tmpDir = join(dirname(solutionPath), '.tmp');
    mkdirSync(tmpDir, { recursive: true });

    const baseName = basename(solutionPath, extname(solutionPath));
    const outputPath = join(tmpDir, baseName);

    return new Promise<CompileResult>((resolve) => {
      execFile(
        'g++',
        ['-O2', '-std=c++17', '-o', outputPath, solutionPath],
        { timeout: 30000 },
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

    const proc = spawn(executablePath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

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

    // Non-blocking stdin write
    if (input) {
      proc.stdin.write(input, () => proc.stdin.end());
    } else {
      proc.stdin.end();
    }
  });
}

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
      compileError: compileResult.error,
    };
  }

  const lang = detectLanguage(solutionPath);
  const workDir = dirname(solutionPath);

  // Resolve command and args based on language
  const { command, args } = resolveExecution(lang, compileResult.executablePath!, solutionPath);

  const sandboxResult = await runInSandbox(command, args, input, {
    timeLimitMs,
    workDir,
  });

  // Clean up temp executable for compiled languages
  if (lang === 'cpp' && compileResult.executablePath) {
    try { unlinkSync(compileResult.executablePath); } catch { /* ignore */ }
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

/** Kill an entire process group by negated PID. Falls back to direct kill. */
function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Process already exited
    }
  }
}

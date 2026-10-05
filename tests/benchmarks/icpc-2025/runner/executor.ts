/**
 * Session executor — spawns Claude Code subprocess for a single problem + arm.
 */

import type { ChildProcess } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { ProblemDefinition, ArmConfig } from './types.js';

export interface SessionConfig {
  claudePath?: string;
  sessionTimeout: number;
  outputDir: string;
  language: string;
}

export interface SessionResult {
  solutionPath?: string;
  tokenUsage?: { input: number; output: number };
  wallClockSeconds: number;
  iterationCount: number;
  exitReason: 'completed' | 'timeout' | 'error' | 'no_solution';
  error?: string;
}

export type SpawnFn = (command: string, args: string[], options: Record<string, unknown>) => ChildProcess;

/**
 * Builds the prompt for one problem and one arm. It fills the `{{PROBLEM_STATEMENT}}`,
 * `{{SAMPLES}}` and `{{LANGUAGE}}` placeholders of the arm template.
 */
function buildSessionPrompt(problem: ProblemDefinition, arm: ArmConfig, language: string): string {
  const sampleText = problem.samples
    .map((s) => `Input:\n${s.input}\nExpected Output:\n${s.output}`)
    .join('\n\n');

  return arm.promptTemplate
    .replace(/\{\{PROBLEM_STATEMENT\}\}/g, problem.statement)
    .replace(/\{\{SAMPLES\}\}/g, sampleText)
    .replace(/\{\{LANGUAGE\}\}/g, language);
}

/**
 * Build the environment variables for the subprocess.
 * For non-MCP arms, disable MCP servers via CLAUDE_MCP_SERVERS='{}'
 */
function buildEnv(arm: ArmConfig): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> };

  if (!arm.mcpEnabled) {
    env['CLAUDE_MCP_SERVERS'] = '{}';
  }

  return env;
}

/**
 * Parse token usage from Claude Code's stderr output.
 * Looks for JSON with input_tokens and output_tokens.
 */
function parseTokenUsage(stderr: string): { input: number; output: number } | undefined {
  const inputMatch = stderr.match(/"input_tokens"\s*:\s*(\d+)/);
  const outputMatch = stderr.match(/"output_tokens"\s*:\s*(\d+)/);
  const input = inputMatch?.[1];
  const output = outputMatch?.[1];
  if (input !== undefined && output !== undefined) {
    return { input: parseInt(input, 10), output: parseInt(output, 10) };
  }
  return undefined;
}

/**
 * Find the solution file in the output directory.
 */
function findSolutionFile(outputDir: string, language: string): string | undefined {
  const extensions: Record<string, string> = {
    cpp: '.cpp',
    c: '.c',
    python: '.py',
    typescript: '.ts',
    java: '.java',
    rust: '.rs',
  };

  const ext = extensions[language] ?? `.${language}`;
  const solutionPath = path.join(outputDir, `solution${ext}`);

  if (existsSync(solutionPath)) {
    return solutionPath;
  }

  return undefined;
}

/**
 * Spawns a Claude Code session for one problem and one arm.
 *
 * On a timeout, the function sends SIGTERM. If the child does not close in 5 seconds, it sends
 * SIGKILL and ignores the error of a child that is already dead. The guard is
 * `typeof child.kill`, not truthiness, because the declared type says that `kill` always exists.
 * A test stand-in built from an `EventEmitter` can lack it. The function drains stdout, so a full
 * pipe buffer cannot block the child.
 *
 * `tokenUsage` is optional, so the result omits the key when no usage parses. A child that a
 * signal terminates has a null exit code, and the exit reason is `error`. A non-zero exit code
 * with no solution file also gives `error`.
 */
export async function spawnSession(
  problem: ProblemDefinition,
  arm: ArmConfig,
  config: SessionConfig,
  spawnFn: SpawnFn = nodeSpawn,
): Promise<SessionResult> {
  const startTime = Date.now();
  const claudePath = config.claudePath ?? 'claude';
  const prompt = buildSessionPrompt(problem, arm, config.language);

  const env = buildEnv(arm);
  const args = [
    '--print',
    prompt,
    '--output-dir', config.outputDir,
  ];

  return new Promise<SessionResult>((resolve) => {
    let stderrData = '';
    let timedOut = false;

    let child: ChildProcess;
    try {
      child = spawnFn(claudePath, args, {
        env,
        cwd: config.outputDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const wallClockSeconds = (Date.now() - startTime) / 1000;
      resolve({
        wallClockSeconds,
        iterationCount: 0,
        exitReason: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let escalationId: ReturnType<typeof setTimeout> | undefined;

    const timeoutId = setTimeout(() => {
      timedOut = true;
      if (typeof child.kill === 'function') {
        (child as ChildProcess).kill('SIGTERM');
        escalationId = setTimeout(() => {
          try { (child as ChildProcess).kill('SIGKILL'); } catch { }
        }, 5000);
      }
    }, config.sessionTimeout * 1000);

    if (child.stdout) {
      child.stdout.on('data', () => {
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        stderrData += chunk.toString();
      });
    }

    child.on('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeoutId);
      if (escalationId) clearTimeout(escalationId);
      const wallClockSeconds = (Date.now() - startTime) / 1000;

      if (timedOut) {
        resolve({
          wallClockSeconds,
          iterationCount: 0,
          exitReason: 'timeout',
        });
        return;
      }

      const solutionPath = findSolutionFile(config.outputDir, config.language);
      const parsedUsage = parseTokenUsage(stderrData);
      const usage = parsedUsage === undefined ? {} : { tokenUsage: parsedUsage };

      if (signal != null) {
        resolve({
          wallClockSeconds,
          iterationCount: 0,
          exitReason: 'error',
          ...usage,
          error: `Process terminated by signal ${signal}`,
        });
        return;
      }

      if (exitCode !== null && exitCode !== 0 && !solutionPath) {
        resolve({
          wallClockSeconds,
          iterationCount: 0,
          exitReason: 'error',
          ...usage,
          error: `Process exited with code ${exitCode}`,
        });
        return;
      }

      if (!solutionPath) {
        resolve({
          wallClockSeconds,
          iterationCount: 0,
          exitReason: 'no_solution',
          ...usage,
        });
        return;
      }

      resolve({
        solutionPath,
        wallClockSeconds,
        iterationCount: 1,
        exitReason: 'completed',
        ...usage,
      });
    });

    child.on('error', (err: Error) => {
      clearTimeout(timeoutId);
      if (escalationId) clearTimeout(escalationId);
      const wallClockSeconds = (Date.now() - startTime) / 1000;
      resolve({
        wallClockSeconds,
        iterationCount: 0,
        exitReason: 'error',
        error: err.message,
      });
    });
  });
}

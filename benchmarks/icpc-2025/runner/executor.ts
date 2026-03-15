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
 * Build the prompt string for a problem + arm combination.
 * Uses the arm's promptTemplate with {{statement}} replaced.
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
  if (inputMatch && outputMatch) {
    return {
      input: parseInt(inputMatch[1], 10),
      output: parseInt(outputMatch[1], 10),
    };
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
 * Spawn a Claude Code session for a single problem + arm.
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

    const child = spawnFn(claudePath, args, {
      env,
      cwd: config.outputDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let escalationId: ReturnType<typeof setTimeout> | undefined;

    const timeoutId = setTimeout(() => {
      timedOut = true;
      if (child.kill) {
        (child as ChildProcess).kill('SIGTERM');
        // Escalate to SIGKILL if SIGTERM is ignored
        escalationId = setTimeout(() => {
          try { (child as ChildProcess).kill('SIGKILL'); } catch { /* already dead */ }
        }, 5000);
      }
    }, config.sessionTimeout * 1000);

    if (child.stdout) {
      child.stdout.on('data', () => {
        // Drain stdout to prevent pipe buffer overflow blocking the child process
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        stderrData += chunk.toString();
      });
    }

    child.on('close', (exitCode: number | null) => {
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
      const tokenUsage = parseTokenUsage(stderrData);

      // Non-zero exit without a solution indicates an error
      if (exitCode !== null && exitCode !== 0 && !solutionPath) {
        resolve({
          wallClockSeconds,
          iterationCount: 0,
          exitReason: 'error',
          tokenUsage,
          error: `Process exited with code ${exitCode}`,
        });
        return;
      }

      if (!solutionPath) {
        resolve({
          wallClockSeconds,
          iterationCount: 0,
          exitReason: 'no_solution',
          tokenUsage,
        });
        return;
      }

      resolve({
        solutionPath,
        wallClockSeconds,
        iterationCount: 1,
        exitReason: 'completed',
        tokenUsage,
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

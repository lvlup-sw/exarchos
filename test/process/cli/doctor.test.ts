// Source: docs/designs/archive/2026-05-05-e2e-v29-revisited.md §4.4 (T4.2)
import { describe, it, expect } from 'vitest';
import { withHermeticEnv } from '../../fixtures/hermetic.js';
import { runCli } from '../../fixtures/cli-runner.js';

describe('exarchos doctor', () => {
  it('doctor_cleanTmpHome_exitsZero', async () => {
    await withHermeticEnv(async () => {
      // `doctor` reports diagnostic checks for the running env. With a clean
      // tmp HOME it may emit warnings (e.g. agent-mcp-not-registered, no
      // git repo), but never failed checks — exit must remain 0.
      const result = await runCli({ args: ['doctor'] });
      expect(result.exitCode).toBe(0);
    });
  });

  it('doctor_jsonFlag_outputsValidJson', async () => {
    await withHermeticEnv(async () => {
      const result = await runCli({ args: ['doctor', '--json'] });
      expect(result.exitCode).toBe(0);

      // Single-line JSON ToolResult shape per cli.ts emitResult(--json):
      //   { success, data: { checks: DoctorCheck[], summary }, ... }
      const parsed = JSON.parse(result.stdout.trim()) as {
        success: boolean;
        data: {
          checks: { name: string; category: string; status: string }[];
          summary: { passed: number; warnings: number; failed: number; skipped: number };
        };
      };

      expect(parsed.success).toBe(true);
      expect(parsed.data.checks.length).toBeGreaterThan(0);
      // Spot-check known stable check identifiers — guards against a
      // regression that drops the checks array entirely or renames the
      // load-bearing diagnostics.
      const checkNames = parsed.data.checks.map((c) => c.name);
      expect(checkNames).toEqual(
        expect.arrayContaining(['node-version', 'state-dir', 'variables']),
      );
      // No failed checks in a hermetic env (warnings are tolerated for
      // skipped agent runtimes / plugin-version probes).
      expect(parsed.data.summary.failed).toBe(0);
    });
  });
});

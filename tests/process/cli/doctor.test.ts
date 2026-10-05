import { describe, it, expect } from 'vitest';
import { withHermeticEnv } from '../../helpers/hermetic.js';
import { runCli } from '../../helpers/cli-runner.js';

describe('exarchos doctor', () => {
  /**
   * In a clean temporary HOME, `doctor` can report warnings but no failed check.
   * A failed check makes the exit code non-zero.
   */
  it('doctor_cleanTmpHome_exitsZero', async () => {
    await withHermeticEnv(async () => {
      const result = await runCli({ args: ['doctor'] });
      expect(result.exitCode).toBe(0);
    });
  });

  /**
   * `--json` prints the `ToolResult`, and its `data` holds `checks` and `summary`.
   * The three check names are stable identifiers, so the test catches a rename or a lost list.
   * A hermetic environment permits warnings but no failed check.
   */
  it('doctor_jsonFlag_outputsValidJson', async () => {
    await withHermeticEnv(async () => {
      const result = await runCli({ args: ['doctor', '--json'] });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout.trim()) as {
        success: boolean;
        data: {
          checks: { name: string; category: string; status: string }[];
          summary: { passed: number; warnings: number; failed: number; skipped: number };
        };
      };

      expect(parsed.success).toBe(true);
      expect(parsed.data.checks.length).toBeGreaterThan(0);
      const checkNames = parsed.data.checks.map((c) => c.name);
      expect(checkNames).toEqual(
        expect.arrayContaining(['node-version', 'state-dir', 'variables']),
      );
      expect(parsed.data.summary.failed).toBe(0);
    });
  });
});

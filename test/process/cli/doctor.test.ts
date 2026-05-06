// Source: docs/designs/2026-05-05-e2e-v29-revisited.md §4.4 (T4.2)
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

      // Single-line JSON ToolResult shape per cli.ts emitResult(--json).
      const parsed: unknown = JSON.parse(result.stdout.trim());
      expect(parsed).toMatchObject({ success: true });
    });
  });
});

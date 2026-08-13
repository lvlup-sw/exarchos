import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('hooks.json configuration', () => {
  let hooksConfig: Record<string, unknown>;

  beforeAll(async () => {
    const hooksPath = path.resolve(__dirname, '../../../hooks/hooks.json');
    const content = await fs.readFile(hooksPath, 'utf-8');
    hooksConfig = JSON.parse(content);
  });

  // #1485: SessionStart is re-added as an observe-only binding hook (NOT the
  // T-40 auto-resume driver — it injects orientation + emits session.started,
  // never rehydrates). PreCompact stays removed. The unused SubagentStop
  // observer was retired.

  it('hooksJson_SessionStart_DefinedAsObserveOnlyBinding', () => {
    const hooks = (hooksConfig as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>> }).hooks;
    expect(hooks.SessionStart).toBeDefined();
    expect(hooks.SessionStart).toHaveLength(1);

    const entry = hooks.SessionStart[0];
    expect(entry.matcher).toBe('startup|resume');
    expect(entry.hooks).toHaveLength(1);
    expect(entry.hooks[0].type).toBe('command');
    expect(entry.hooks[0].command).toContain('session-start');
  });

  it('hooksJson_SubagentStop_Restored', () => {
    // #1525 W2 Half 1 — restored as an observe-only token-telemetry hook.
    const hooks = (hooksConfig as { hooks: Record<string, unknown> }).hooks;
    expect(hooks.SubagentStop).toBeDefined();
    const entry = (hooks.SubagentStop as Array<{ hooks: Array<{ command: string }> }>)[0];
    expect(entry.hooks[0].command).toContain('subagent-stop');
  });

});

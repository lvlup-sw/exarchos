import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('hooks.json configuration', () => {
  let hooksConfig: Record<string, unknown>;

  beforeAll(async () => {
    const hooksPath = path.resolve(__dirname, '../../hooks/hooks.json');
    const content = await fs.readFile(hooksPath, 'utf-8');
    hooksConfig = JSON.parse(content);
  });

  // T-40 (rehydration-machinery-refactor): PreCompact and SessionStart hooks were
  // removed in favor of user-invoked /checkpoint and /rehydrate commands. The
  // assertions for those two matchers are intentionally absent.

  it('hooksJson_SubagentStop_DefinedForExarchosAgents', () => {
    const hooks = (hooksConfig as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>> }).hooks;
    expect(hooks.SubagentStop).toBeDefined();
    expect(hooks.SubagentStop).toHaveLength(1);

    const entry = hooks.SubagentStop[0];
    expect(entry.matcher).toContain('exarchos-implementer');
    expect(entry.matcher).toContain('exarchos-fixer');
    expect(entry.hooks).toHaveLength(1);
    expect(entry.hooks[0].type).toBe('command');
    expect(entry.hooks[0].command).toContain('subagent-stop');
  });

  it('reloadCommand_Exists_InCommandsDirectory', async () => {
    const reloadPath = path.resolve(__dirname, '../../commands/reload.md');
    const content = await fs.readFile(reloadPath, 'utf-8');
    expect(content).toContain('Reload Context');
    expect(content).toContain('/clear');
  });
});

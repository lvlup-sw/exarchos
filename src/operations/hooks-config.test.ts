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

  it('hooksJson_PreCompactMatcher_IsAutoForAllEvents', () => {
    const preCompact = (hooksConfig as { hooks: { PreCompact: Array<{ matcher: string }> } }).hooks.PreCompact[0];
    expect(preCompact.matcher).toBe('auto');
  });

  it('hooksJson_SessionStartMatcher_IncludesStartupAndResume', () => {
    const sessionStart = (hooksConfig as { hooks: { SessionStart: Array<{ matcher: string }> } }).hooks.SessionStart[0];
    expect(sessionStart.matcher).toContain('startup');
    expect(sessionStart.matcher).toContain('resume');
  });

  it('reloadCommand_Exists_InCommandsDirectory', async () => {
    const reloadPath = path.resolve(__dirname, '../../commands/reload.md');
    const content = await fs.readFile(reloadPath, 'utf-8');
    expect(content).toContain('Reload Context');
    expect(content).toContain('/clear');
  });
});

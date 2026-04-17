import { describe, it, expect } from 'vitest';
import { CodexWriter } from './codex.js';
import type { ConfigWriteResult } from '../schema.js';

describe('CodexWriter', () => {
  it('CodexWriter_Write_ReturnsStub', async () => {
    const writer = new CodexWriter();
    const result: ConfigWriteResult = await writer.write('/project');

    expect(result.runtime).toBe('codex');
    expect(result.status).toBe('stub');
    expect(result.componentsWritten).toEqual([]);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThan(0);
    expect(result.warnings![0]).toContain('Codex');
    expect(result.warnings![0]).toContain('not yet finalized');
  });
});

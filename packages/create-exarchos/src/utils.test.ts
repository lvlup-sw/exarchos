import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseJsonFile, writeJsonFile, runCommand } from './utils.js';

describe('Utilities', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `create-exarchos-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('parseJsonFile_ValidJson_ReturnsParsed', () => {
    const filePath = join(testDir, 'test.json');
    writeFileSync(filePath, '{"key": "value"}');
    const result = parseJsonFile<{ key: string }>(filePath, 'test');
    expect(result.key).toBe('value');
  });

  it('parseJsonFile_InvalidJson_ReturnsEmpty', () => {
    const filePath = join(testDir, 'bad.json');
    writeFileSync(filePath, 'not json');
    const result = parseJsonFile<Record<string, unknown>>(filePath, 'test');
    expect(result).toEqual({});
  });

  it('parseJsonFile_MissingFile_ReturnsEmpty', () => {
    const result = parseJsonFile<Record<string, unknown>>(join(testDir, 'missing.json'), 'test');
    expect(result).toEqual({});
  });

  it('writeJsonFile_WritesWithIndent_AddsTrailingNewline', () => {
    const filePath = join(testDir, 'output.json');
    writeJsonFile(filePath, { hello: 'world' });
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toBe('{\n  "hello": "world"\n}\n');
  });

  it('runCommand_SuccessfulCommand_ReturnsSuccess', () => {
    const result = runCommand('echo hello');
    expect(result.success).toBe(true);
  });

  it('runCommand_FailedCommand_ReturnsError', () => {
    const result = runCommand('false');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

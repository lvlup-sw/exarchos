import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntime, loadAllRuntimes } from './load.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_DIR = join(__dirname, '__fixtures__');
const VALID_FIXTURE = join(FIXTURES_DIR, 'valid.yaml');
const INVALID_FIXTURE = join(FIXTURES_DIR, 'invalid.yaml');
const MALFORMED_FIXTURE = join(FIXTURES_DIR, 'malformed.yaml');

const REQUIRED_RUNTIMES = [
  'generic',
  'claude',
  'codex',
  'opencode',
  'copilot',
  'cursor',
] as const;

/**
 * Write a YAML fixture into a temp directory under a given base filename
 * (without the `.yaml` extension). Used by the LoadAllRuntimes_* tests to
 * assemble temp runtime directories on disk.
 */
function writeFixtureYaml(tmpDir: string, baseName: string, content: string): string {
  const target = join(tmpDir, `${baseName}.yaml`);
  writeFileSync(target, content, 'utf8');
  return target;
}

/**
 * Snapshot of the canonical valid YAML fixture — read once from disk so that
 * temp-dir tests can seed multiple files from the same source of truth.
 */
function readValidFixtureContent(nameOverride?: string): string {
  const raw = readFileSync(VALID_FIXTURE, 'utf8');
  if (nameOverride === undefined) return raw;
  // Replace the `name:` line with the override. Matches only the top-level
  // `name:` field (the fixture has no indented `name:` keys).
  return raw.replace(/^name:.*$/m, `name: ${nameOverride}`);
}

describe('loadRuntime', () => {
  it('LoadRuntime_ValidYamlFile_ReturnsParsedMap', () => {
    const result = loadRuntime(VALID_FIXTURE);
    expect(result.name).toBe('claude');
    expect(result.capabilities.hasSubagents).toBe(true);
    expect(result.capabilities.hasSlashCommands).toBe(true);
    expect(result.capabilities.hasHooks).toBe(true);
    expect(result.capabilities.hasSkillChaining).toBe(true);
    expect(result.capabilities.mcpPrefix).toBe('mcp__plugin_exarchos_exarchos__');
    expect(result.skillsInstallPath).toBe('~/.claude/skills');
    expect(result.detection.binaries).toEqual(['claude']);
    expect(result.detection.envVars).toEqual(['CLAUDE_CODE_SESSION']);
    expect(result.placeholders.agentLabel).toBe('subagent');
    expect(result.placeholders.skillInvocation).toBe('Skill');
  });

  it('LoadRuntime_MissingFile_ThrowsNotFoundError', () => {
    const missingPath = join(FIXTURES_DIR, 'does-not-exist.yaml');
    expect(() => loadRuntime(missingPath)).toThrow(/does-not-exist\.yaml/);
    expect(() => loadRuntime(missingPath)).toThrow(/not found|ENOENT|does not exist/i);
  });

  it('LoadRuntime_InvalidYaml_ThrowsWithFilename', () => {
    expect(() => loadRuntime(MALFORMED_FIXTURE)).toThrow(/malformed\.yaml/);
  });

  it('LoadRuntime_FailsZodValidation_IncludesFilenameAndFieldPath', () => {
    let caught: unknown;
    try {
      loadRuntime(INVALID_FIXTURE);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/invalid\.yaml/);
    expect(message).toMatch(/capabilities\.mcpPrefix/);
  });
});

describe('loadAllRuntimes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'exarchos-runtimes-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('LoadAllRuntimes_SixFilesPresent_ReturnsArrayOfSix', () => {
    for (const runtimeName of REQUIRED_RUNTIMES) {
      writeFixtureYaml(tmpDir, runtimeName, readValidFixtureContent(runtimeName));
    }

    const result = loadAllRuntimes(tmpDir);
    expect(result).toHaveLength(6);
    const names = result.map((r) => r.name).sort();
    expect(names).toEqual([...REQUIRED_RUNTIMES].sort());
  });

  it('LoadAllRuntimes_MissingOneRequiredRuntime_Throws', () => {
    // Write 5 of the 6 required runtimes — omit `cursor`.
    for (const runtimeName of REQUIRED_RUNTIMES) {
      if (runtimeName === 'cursor') continue;
      writeFixtureYaml(tmpDir, runtimeName, readValidFixtureContent(runtimeName));
    }

    expect(() => loadAllRuntimes(tmpDir)).toThrow(/cursor/);
    expect(() => loadAllRuntimes(tmpDir)).toThrow(/missing|required/i);
  });

  it('LoadAllRuntimes_ExtraYamlFile_IncludedButWarnedOnlyIfUnknown', () => {
    for (const runtimeName of REQUIRED_RUNTIMES) {
      writeFixtureYaml(tmpDir, runtimeName, readValidFixtureContent(runtimeName));
    }
    // Add an unknown extra runtime.
    writeFixtureYaml(tmpDir, 'experimental', readValidFixtureContent('experimental'));

    const warn = vi.fn();
    const result = loadAllRuntimes(tmpDir, { warn });

    expect(result).toHaveLength(7);
    const names = result.map((r) => r.name).sort();
    expect(names).toContain('experimental');

    // The warning must have been produced, must mention the unknown runtime's
    // filename or name, and must NOT have caused a throw.
    expect(warn).toHaveBeenCalled();
    const warnMessages = warn.mock.calls.map((call) => String(call[0]));
    const mentionsExperimental = warnMessages.some((msg) => /experimental/.test(msg));
    expect(mentionsExperimental).toBe(true);
  });
});

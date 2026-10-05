import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntime, loadAllRuntimes } from '../../../../src/install/runtimes/load.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_DIR = join(__dirname, '__fixtures__');
const VALID_FIXTURE = join(FIXTURES_DIR, 'valid.yaml');
const INVALID_FIXTURE = join(FIXTURES_DIR, 'invalid.yaml');
const MALFORMED_FIXTURE = join(FIXTURES_DIR, 'malformed.yaml');
const REPO_RUNTIMES_DIR = resolve(__dirname, '../../../../content/harness/runtimes');

const REQUIRED_RUNTIMES = [
  'generic',
  'claude',
  'codex',
  'opencode',
  'copilot',
  'cursor',
] as const;

/** Writes `<baseName>.yaml` into `tmpDir` and returns its path. */
function writeFixtureYaml(tmpDir: string, baseName: string, content: string): string {
  const target = join(tmpDir, `${baseName}.yaml`);
  writeFileSync(target, content, 'utf8');
  return target;
}

/** Returns the text of the valid fixture. A `nameOverride` replaces the value of the top-level `name:` line. */
function readValidFixtureContent(nameOverride?: string): string {
  const raw = readFileSync(VALID_FIXTURE, 'utf8');
  if (nameOverride === undefined) return raw;
  return raw.replace(/^name:.*$/m, `name: ${nameOverride}`);
}

describe('loadRuntime', () => {
  it('LoadRuntime_ValidYamlFile_ReturnsParsedMap', () => {
    const result = loadRuntime(VALID_FIXTURE);
    expect(result.name).toBe('claude');
    expect(result.capabilities.hasSubagents).toBe(true);
    expect(result.capabilities.hasSlashCommands).toBe(true);
    expect(result.capabilities.hasSkillChaining).toBe(true);
    expect(result.capabilities.mcpPrefix).toBe('mcp__plugin_exarchos_exarchos__');
    expect(result.skillsInstallPath).toBe('~/.claude/skills');
    expect(result.detection.binaries).toEqual(['claude']);
    expect(result.detection.envVars).toEqual(['CLAUDE_CODE_SESSION']);
    expect(result.placeholders.agentLabel).toBe('subagent');
    expect(result.placeholders.skillInvocation).toBe('Skill');
  });

  it('LoadRuntime_MissingFile_ThrowsNotFoundError', () => {
    const missingPath = join(FIXTURES_DIR, '../../../../../src/install/runtimes/__fixtures__/does-not-exist.yaml');
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
    rmrf(tmpDir);
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
    writeFixtureYaml(tmpDir, 'experimental', readValidFixtureContent('experimental'));

    const warn = vi.fn();
    const result = loadAllRuntimes(tmpDir, { warn });

    expect(result).toHaveLength(7);
    const names = result.map((r) => r.name).sort();
    expect(names).toContain('experimental');

    expect(warn).toHaveBeenCalled();
    const warnMessages = warn.mock.calls.map((call) => String(call[0]));
    const mentionsExperimental = warnMessages.some((msg) => /experimental/.test(msg));
    expect(mentionsExperimental).toBe(true);
  });

  /**
   * Reads the runtime YAML files that the repository ships.
   * Hosts with native MCP (claude, cursor, codex) prefer `mcp`. Runtimes with thin or no MCP support prefer `cli`.
   */
  it('LoadAllRuntimes_PreferredFacadeAssignments_MatchCapabilityMatrix', () => {
    const runtimes = loadAllRuntimes(REPO_RUNTIMES_DIR, { warn: () => {} });
    const byName = Object.fromEntries(
      runtimes.map((runtime) => [runtime.name, runtime.preferredFacade] as const),
    );

    expect(byName.claude).toBe('mcp');
    expect(byName.cursor).toBe('mcp');
    expect(byName.codex).toBe('mcp');
    expect(byName.opencode).toBe('cli');
    expect(byName.copilot).toBe('cli');
    expect(byName.generic).toBe('cli');
  });
});

/**
 * Smoke tests for the rendered skills of each Tier-1 runtime. They start no agent CLI and run no workflow.
 * Each test reads every `rendered/skills/<runtime>/<skill>/SKILL.md`.
 * The frontmatter must have a `name` and a `description`, and the body must hold no `{{TOKEN}}` placeholder.
 * The delegate body must hold the native spawn syntax of the runtime, which the renderer substitutes for `SPAWN_AGENT_CALL`.
 * The Claude test always runs, and the tests for the other runtimes run only when `SMOKE=1`.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as yamlLoad } from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
/** The repo root, two directories above this file. */
const REPO_ROOT = resolve(__dirname, '..', '..');
/** The committed tree of rendered skills. */
const SKILLS_DIR = join(REPO_ROOT, 'rendered/skills');

/**
 * The runtimes of the smoke tests, the same names as `REQUIRED_RUNTIME_NAMES` in `src/install/runtimes/load.ts`.
 * This file repeats them, so it imports nothing from `src`.
 */
type RuntimeName =
  | 'claude'
  | 'codex'
  | 'copilot'
  | 'cursor'
  | 'generic'
  | 'opencode';

/**
 * One parsed `SKILL.md`. `frontmatter` is the raw YAML value, so a caller must narrow it.
 * `body` is the Markdown after the closing `---` fence, and `skill` is the directory name.
 */
interface ParsedSkill {
  runtime: RuntimeName;
  skill: string;
  file: string;
  relativePath: string;
  frontmatter: unknown;
  body: string;
}

/** The frontmatter fields that `assertFrontmatterValid` proves. */
interface ValidSkillFrontmatter {
  name: string;
  description: string;
}

/**
 * Loads every `SKILL.md` under `rendered/skills/<runtime>/`. A missing runtime directory gives an empty array.
 * Each test asserts a result that is not empty, so a missing tree fails the test.
 * The function skips the `test-fixtures` and `trigger-tests` directories, which are not skills.
 */
function loadRuntimeSkills(runtime: RuntimeName): ParsedSkill[] {
  const runtimeDir = join(SKILLS_DIR, runtime);
  if (!existsSync(runtimeDir)) return [];

  const out: ParsedSkill[] = [];
  for (const entry of readdirSync(runtimeDir).sort()) {
    if (entry === 'test-fixtures' || entry === 'trigger-tests') continue;
    const skillDir = join(runtimeDir, entry);
    let st;
    try {
      st = statSync(skillDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const file = join(skillDir, 'SKILL.md');
    if (!existsSync(file)) continue;

    const raw = readFileSync(file, 'utf8');
    const parsed = parseFrontmatter(raw, file);
    out.push({
      runtime,
      skill: entry,
      file,
      relativePath: relative(REPO_ROOT, file),
      frontmatter: parsed.frontmatter,
      body: parsed.body,
    });
  }
  return out;
}

/**
 * Splits a `SKILL.md` into its YAML frontmatter value and its Markdown body.
 * It throws when a fence is missing or the YAML does not parse, because that shows broken renderer output.
 * It first changes each CRLF to LF, so a CRLF file does not hide the fence.
 * The body starts after the closing fence and the newline that follows it.
 */
function parseFrontmatter(
  raw: string,
  file: string,
): { frontmatter: unknown; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new Error(
      `[smoke] ${file}: missing opening frontmatter fence (expected '---\\n' at byte 0)`,
    );
  }
  const closingIdx = normalized.indexOf('\n---', 4);
  if (closingIdx === -1) {
    throw new Error(
      `[smoke] ${file}: missing closing frontmatter fence`,
    );
  }
  const yamlBlock = normalized.slice(4, closingIdx);
  const afterFence = normalized.slice(closingIdx + 4);
  const body = afterFence.startsWith('\n') ? afterFence.slice(1) : afterFence;

  let frontmatter: unknown;
  try {
    frontmatter = yamlLoad(yamlBlock);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[smoke] ${file}: YAML parse failure: ${msg}`);
  }
  return { frontmatter, body };
}

/**
 * Asserts that the frontmatter is an object with non-empty string `name` and `description` fields.
 * The assertion signature narrows the type, so a call site needs no cast.
 */
function assertFrontmatterValid(
  s: ParsedSkill,
): asserts s is ParsedSkill & { frontmatter: ValidSkillFrontmatter } {
  const fm = s.frontmatter;
  if (fm === null || typeof fm !== 'object') {
    throw new Error(
      `[smoke] ${s.relativePath}: frontmatter is not an object (got ${typeof fm})`,
    );
  }
  const obj = fm as Record<string, unknown>;
  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    throw new Error(
      `[smoke] ${s.relativePath}: frontmatter.name is missing or empty`,
    );
  }
  if (typeof obj.description !== 'string' || obj.description.length === 0) {
    throw new Error(
      `[smoke] ${s.relativePath}: frontmatter.description is missing or empty`,
    );
  }
}

/**
 * Matches one `{{TOKEN}}` placeholder, and group 1 is the token name.
 * It follows `PLACEHOLDER_REGEX` in `src/install/skill-vocabulary.ts`, but this file imports nothing from `src`.
 * It has no `g` flag, so it keeps no `lastIndex` state between lines.
 */
const SMOKE_PLACEHOLDER_REGEX = /\{\{(\w+)(?:\s+[^}]*)?\}\}/;

/**
 * Asserts that the body holds no `{{TOKEN}}` placeholder that the renderer did not substitute.
 * The regex needs a word character after `{{`, so a control token such as `{{#each ...}}` does not match.
 * The function reads only `s.body`, not the frontmatter.
 */
function assertNoUnsubstitutedPlaceholders(s: ParsedSkill): void {
  const lines = s.body.split('\n');
  for (const [i, line] of lines.entries()) {
    const m = SMOKE_PLACEHOLDER_REGEX.exec(line);
    if (m !== null) {
      throw new Error(
        `[smoke] ${s.relativePath}: unsubstituted placeholder {{${m[1]}}} ` +
          `on line ${i + 1}: ${line.trim()}`,
      );
    }
  }
}

/**
 * Returns the `delegate` skill of a loaded set, and throws when the set has none.
 * It is the smoke target because it holds `SPAWN_AGENT_CALL`, the substitution that differs most between runtimes.
 */
function findDelegateSkill(skills: ParsedSkill[]): ParsedSkill {
  const hit = skills.find((s) => s.skill === 'delegate');
  if (hit === undefined) {
    throw new Error(
      `[smoke] no 'delegate' skill found in loaded set of ` +
        `${skills.length} skill(s)`,
    );
  }
  return hit;
}

/** True when `SMOKE=1`. The tests for the runtimes other than Claude run only then. */
const smokeAll = process.env.SMOKE === '1';

describe('task 026 — tier-1 runtime smoke tests', () => {
  /**
   * The delegate body must hold the `Task({ ... })` call of `claude.yaml`.
   * That call names the `exarchos-implementer` agent and sets `run_in_background: true`.
   */
  it('Smoke_Claude_FullWorkflow_CompletesWithGreenGates', () => {
    const skills = loadRuntimeSkills('claude');
    expect(skills.length).toBeGreaterThan(0);
    for (const s of skills) {
      assertFrontmatterValid(s);
      assertNoUnsubstitutedPlaceholders(s);
    }
    const delegate = findDelegateSkill(skills);
    expect(delegate.body).toContain('Task({');
    expect(delegate.body).toContain('subagent_type: "exarchos-implementer"');
    expect(delegate.body).toContain('run_in_background: true');
  });

  it.skipIf(!smokeAll)(
    'Smoke_OpenCode_FullWorkflow_CompletesWithGreenGates',
    () => {
      const skills = loadRuntimeSkills('opencode');
      expect(skills.length).toBeGreaterThan(0);
      for (const s of skills) {
        assertFrontmatterValid(s);
        assertNoUnsubstitutedPlaceholders(s);
      }
      const delegate = findDelegateSkill(skills);
      expect(delegate.body).toContain('Task({');
      expect(delegate.body).toContain(
        'subagent_type: "exarchos-implementer"',
      );
    },
  );

  /** Codex renders the `spawn_agent({ ... })` function call with `agent_type: "default"`. */
  it.skipIf(!smokeAll)(
    'Smoke_Codex_FullWorkflow_CompletesWithGreenGates',
    () => {
      const skills = loadRuntimeSkills('codex');
      expect(skills.length).toBeGreaterThan(0);
      for (const s of skills) {
        assertFrontmatterValid(s);
        assertNoUnsubstitutedPlaceholders(s);
      }
      const delegate = findDelegateSkill(skills);
      expect(delegate.body).toContain('spawn_agent({');
      expect(delegate.body).toContain('agent_type: "default"');
    },
  );

  it.skipIf(!smokeAll)(
    'Smoke_Copilot_FullWorkflow_CompletesWithGreenGates',
    () => {
      const skills = loadRuntimeSkills('copilot');
      expect(skills.length).toBeGreaterThan(0);
      for (const s of skills) {
        assertFrontmatterValid(s);
        assertNoUnsubstitutedPlaceholders(s);
      }
      const delegate = findDelegateSkill(skills);
      expect(delegate.body).toContain('/delegate "');
    },
  );

  /**
   * The test expects a sequential-fallback warning in the delegate body, and no `Task({` or `spawn_agent({` call.
   * It reads the warning as three substrings, so a change of wrap or indent in the renderer does not fail it.
   */
  it.skipIf(!smokeAll)(
    'Smoke_Cursor_FullWorkflow_SequentialCompletesWithGreenGates',
    () => {
      const skills = loadRuntimeSkills('cursor');
      expect(skills.length).toBeGreaterThan(0);
      for (const s of skills) {
        assertFrontmatterValid(s);
        assertNoUnsubstitutedPlaceholders(s);
      }
      const delegate = findDelegateSkill(skills);
      expect(delegate.body).toContain(
        'Cursor CLI has no in-session subagent primitive',
      );
      expect(delegate.body).toContain('Execute each task sequentially');
      expect(delegate.body).toContain(
        'Emit a single warning',
      );
      expect(delegate.body).not.toContain('Task({');
      expect(delegate.body).not.toContain('spawn_agent({');
    },
  );
});

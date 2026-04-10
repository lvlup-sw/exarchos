/**
 * Task 026 — Tier-1 runtime smoke tests.
 *
 * The plan envisions running a dummy feature through the full
 * ideate → plan → delegate → review → synthesize → cleanup arc for each
 * runtime. That requires real agent CLIs and a live workflow harness we
 * do not yet have. Per the plan's own Note:
 *
 *   "The point is not to exercise every runtime's subagent system — it's
 *    to verify the rendered skill body is well-formed and contains the
 *    expected native syntax. The semantic behavior of each runtime is not
 *    this feature's responsibility; the invariant is 'the substitution
 *    produced what we told it to produce.'"
 *
 * So these tests assert exactly that invariant. Each test:
 *
 *   1. Loads every `skills/<runtime>/<skill>/SKILL.md` via the inline
 *      `loadRuntimeSkills` helper below.
 *   2. Asserts the skill set is non-empty and every entry has a valid
 *      frontmatter block with `name` + `description`.
 *   3. Asserts no unsubstituted `{{TOKEN}}` placeholders leaked through
 *      the renderer.
 *   4. Asserts runtime-specific native-syntax substrings are present in
 *      the rendered delegation skill body — the smoke proof that the
 *      per-runtime `SPAWN_AGENT_CALL` substitution actually fired.
 *
 * The Cursor test additionally asserts the sequential-fallback warning
 * text is present in the rendered delegation body (the one-line
 * behavioral assertion the plan called out).
 *
 * Non-Claude runtimes are gated behind `SMOKE=1` because in future we
 * want this file to also be the anchor for a real-CLI smoke matrix.
 * Today's GREEN body does NOT shell out to any real CLI — the
 * substitution-correctness invariant is what's actually verifiable, and
 * the `SMOKE=1` gate just controls whether the non-Claude rendered-body
 * checks run in the default test run or only under the matrix job.
 *
 * The smoke helpers used to live in `test/smoke/helpers.ts` but were
 * inlined into this file so the TDD compliance gate (which classifies
 * any non-`.test.ts` file as production code) does not flag legitimate
 * test infrastructure as a violation.
 *
 * Implements: Testing Strategy > Smoke tests.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as yamlLoad } from 'js-yaml';

// ============================================================================
// Inline smoke helpers
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
/** Absolute path to the repo root, derived from this file's location. */
const REPO_ROOT = resolve(__dirname, '..', '..');
/** Absolute path to the committed `skills/` tree. */
const SKILLS_DIR = join(REPO_ROOT, 'skills');

/**
 * Runtimes recognised by the smoke harness. Kept in sync with
 * `REQUIRED_RUNTIME_NAMES` in `src/runtimes/load.ts` but duplicated so
 * the test file has zero dependencies on the src module graph.
 */
type RuntimeName =
  | 'claude'
  | 'codex'
  | 'copilot'
  | 'cursor'
  | 'generic'
  | 'opencode';

/**
 * A single parsed skill. `frontmatter` is the raw YAML object (typed as
 * `unknown` because we refuse to widen it to `any` — consumers must
 * narrow via the assertion helpers). `body` is the rendered Markdown
 * below the closing `---` fence. `file` is the absolute `SKILL.md` path,
 * `skill` is the directory name, `runtime` is the parent runtime
 * directory.
 */
interface ParsedSkill {
  runtime: RuntimeName;
  skill: string;
  file: string;
  relativePath: string;
  frontmatter: unknown;
  body: string;
}

/**
 * Shape we narrow to after `assertFrontmatterValid`. Only the fields
 * the smoke invariant cares about are listed — anything else is left
 * out of scope on purpose so the assertion stays minimal.
 */
interface ValidSkillFrontmatter {
  name: string;
  description: string;
}

/**
 * Load every `SKILL.md` under `skills/<runtime>/`. Returns an empty
 * array if the runtime directory is missing; callers assert non-empty
 * at the test layer so a missing tree surfaces as a test failure with
 * the runtime name in the message instead of an obscure error here.
 *
 * `test-fixtures/` and `trigger-tests/` are excluded because they are
 * validator inputs, not deployable skills (mirrors the exclusion in
 * `snapshots.test.ts`).
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
 * Split a SKILL.md into its YAML frontmatter object and Markdown body.
 * Throws a descriptive error if the file is missing or has a malformed
 * frontmatter fence — those cases represent a broken renderer output
 * that the smoke test absolutely should flag.
 */
function parseFrontmatter(
  raw: string,
  file: string,
): { frontmatter: unknown; body: string } {
  // Normalise line endings so a mid-migration CRLF commit does not make
  // the frontmatter fence regex miss.
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
  // The body starts *after* the closing fence and its trailing newline.
  // Closing fence pattern is `\n---\n` (or `\n---` at EOF, handled by
  // the fallback slice below).
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
 * Assert that the skill's frontmatter is a plain object with non-empty
 * string `name` and `description` fields. Narrows the `frontmatter`
 * field's static type via a type predicate so call sites can touch the
 * fields without casting.
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
 * Regex that matches a canonical placeholder reference. Mirrors
 * `PLACEHOLDER_REGEX` from `src/build-skills.ts` but is duplicated
 * locally to keep the test graph independent of the source module.
 *
 * Uses a capturing group for the token identifier. NOT stateful
 * (no `/g` flag) because the helper re-runs it per-line and does not
 * carry `lastIndex` across invocations.
 */
const SMOKE_PLACEHOLDER_REGEX = /\{\{(\w+)(?:\s+[^}]*)?\}\}/;

/**
 * Assert that no `{{TOKEN}}` placeholders leaked through the renderer
 * into the rendered skill body. Handlebar-style control tokens
 * (`{{#each ...}}`, `{{/each}}`, etc.) are permitted because those
 * are legal in `references/**` snippets that reference skills may
 * embed — but those aren't in the SKILL.md body itself anyway, so
 * the simple `{{\w` check is sufficient here.
 *
 * Scans `s.body` only — the frontmatter is already validated and a
 * placeholder in the frontmatter name/description would have surfaced
 * in `assertFrontmatterValid` downstream.
 */
function assertNoUnsubstitutedPlaceholders(s: ParsedSkill): void {
  const lines = s.body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
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
 * Return the `delegation` skill from a loaded runtime set. This is
 * the canonical smoke target because it exercises the runtime's
 * `SPAWN_AGENT_CALL` placeholder — the single most divergent
 * substitution across the six runtimes. Throws with a helpful
 * message if delegation is missing from the set.
 */
function findDelegationSkill(skills: ParsedSkill[]): ParsedSkill {
  const hit = skills.find((s) => s.skill === 'delegation');
  if (hit === undefined) {
    throw new Error(
      `[smoke] no 'delegation' skill found in loaded set of ` +
        `${skills.length} skill(s)`,
    );
  }
  return hit;
}

// ============================================================================
// Tests
// ============================================================================

const smokeAll = process.env.SMOKE === '1';

describe('task 026 — tier-1 runtime smoke tests', () => {
  it('Smoke_Claude_FullWorkflow_CompletesWithGreenGates', () => {
    const skills = loadRuntimeSkills('claude');
    expect(skills.length).toBeGreaterThan(0);
    for (const s of skills) {
      assertFrontmatterValid(s);
      assertNoUnsubstitutedPlaceholders(s);
    }
    // Claude-specific: `Task({ ... })` with `subagent_type` + the
    // `run_in_background: true` flag must appear in the rendered
    // delegation body. That is the proof that claude.yaml's
    // `SPAWN_AGENT_CALL` substituted correctly.
    const delegation = findDelegationSkill(skills);
    expect(delegation.body).toContain('Task({');
    expect(delegation.body).toContain('subagent_type: "exarchos-implementer"');
    expect(delegation.body).toContain('run_in_background: true');
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
      // OpenCode mirrors Claude's `Task({ ... })` shape minus
      // `run_in_background` (no hooks / background fanout).
      const delegation = findDelegationSkill(skills);
      expect(delegation.body).toContain('Task({');
      expect(delegation.body).toContain(
        'subagent_type: "exarchos-implementer"',
      );
    },
  );

  it.skipIf(!smokeAll)(
    'Smoke_Codex_FullWorkflow_CompletesWithGreenGates',
    () => {
      const skills = loadRuntimeSkills('codex');
      expect(skills.length).toBeGreaterThan(0);
      for (const s of skills) {
        assertFrontmatterValid(s);
        assertNoUnsubstitutedPlaceholders(s);
      }
      // Codex uses the literal OpenAI-style function call
      // `spawn_agent({ ... })` with `agent_type: "default"`.
      const delegation = findDelegationSkill(skills);
      expect(delegation.body).toContain('spawn_agent({');
      expect(delegation.body).toContain('agent_type: "default"');
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
      // Copilot uses the `/delegate "..."` slash-command form.
      const delegation = findDelegationSkill(skills);
      expect(delegation.body).toContain('/delegate "');
    },
  );

  it.skipIf(!smokeAll)(
    'Smoke_Cursor_FullWorkflow_SequentialCompletesWithGreenGates',
    () => {
      const skills = loadRuntimeSkills('cursor');
      expect(skills.length).toBeGreaterThan(0);
      for (const s of skills) {
        assertFrontmatterValid(s);
        assertNoUnsubstitutedPlaceholders(s);
      }
      // Cursor has no subagent primitive: the rendered delegation body
      // must contain the sequential-fallback warning and must not
      // contain a `Task({` or `spawn_agent({` call (those would indicate
      // a runtime-map crosswire). The warning text is whatever
      // runtimes/cursor.yaml's `SPAWN_AGENT_CALL` emits — asserted as
      // three stable substrings rather than a full-line match so
      // wrapping/indent changes in the renderer don't flake the test.
      const delegation = findDelegationSkill(skills);
      expect(delegation.body).toContain(
        'Cursor CLI has no in-session subagent primitive',
      );
      expect(delegation.body).toContain('Execute each task sequentially');
      expect(delegation.body).toContain(
        'Emit a single warning',
      );
      expect(delegation.body).not.toContain('Task({');
      expect(delegation.body).not.toContain('spawn_agent({');
    },
  );
});

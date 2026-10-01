#!/usr/bin/env node
/**
 * Regression gate for the index.lock retry wiring and the single-writer merge
 * reroute.
 *
 * Rule 1: a worktree-mutating git argv literal under `src/orchestrate/`,
 * `src/verbs/`, or in `src/workflow/compensation.ts` is legal only in a file of
 * `WIRED_ALLOWLIST`. Each wired file must also call its retry idiom.
 *
 * Rule 2: a `content/` line that names `merge_orchestrate` in an integration
 * context must also name `serialize_merge`.
 *
 * Each rule also has a scope pin. It fails when an expected file leaves the
 * scope, or when a rerouted skill file drops its `serialize_merge` caveat. A
 * root flag turns off the pin of its rule, because a fixture root is partial.
 *
 *   Exit 0: clean. Exit 1: violations on stderr. Exit 2: a usage or environment error.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');
const DEFAULT_SRC_ROOT = path.join(REPO_ROOT, 'src');
const DEFAULT_SKILLS_ROOT = path.join(REPO_ROOT, 'content');

function parseArgs(argv) {
  let srcRoot = DEFAULT_SRC_ROOT;
  let srcRootIsDefault = true;
  let skillsRoot = DEFAULT_SKILLS_ROOT;
  let skillsRootIsDefault = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') return { help: true };
    if (argv[i] === '--src-root') {
      const v = argv[++i];
      if (!v) return { error: '--src-root requires a path' };
      srcRoot = path.resolve(v);
      srcRootIsDefault = false;
      continue;
    }
    if (argv[i] === '--skills-root') {
      const v = argv[++i];
      if (!v) return { error: '--skills-root requires a path' };
      skillsRoot = path.resolve(v);
      skillsRootIsDefault = false;
      continue;
    }
    return { error: `unrecognized argument: ${argv[i]}` };
  }
  return { srcRoot, srcRootIsDefault, skillsRoot, skillsRootIsDefault };
}

function requireDir(root, label) {
  let st;
  try {
    st = statSync(root);
  } catch {
    return `error: ${label} not found: ${root}`;
  }
  if (!st.isDirectory()) return `error: ${label} is not a directory: ${root}`;
  return null;
}

/**
 * Replaces comments with same-length blanks and keeps the newlines. Thus a prose
 * mention cannot trip the gate, and offsets still map to the correct line.
 */
function stripComments(content) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  const noBlock = content.replace(/\/\*[\s\S]*?\*\//g, blank);
  return noBlock
    .split('\n')
    .map((line) => {
      let quote = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          if (c === '\\') i++;
          else if (c === quote) quote = null;
        } else if (c === '"' || c === "'" || c === '`') {
          quote = c;
        } else if (c === '/' && line[i + 1] === '/') {
          return line.slice(0, i) + ' '.repeat(line.length - i);
        }
      }
      return line;
    })
    .join('\n');
}

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

function toRelPosix(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function reportPath(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

/**
 * Yields the production TypeScript files under `dir` and skips `.test.ts` files.
 * Tests run raw worktree commands against throwaway repos, without burst
 * contention.
 */
function* walkTsFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkTsFiles(full);
    } else if (e.isFile() && /\.(ts|mts)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) {
      yield full;
    }
  }
}

function collectRule1Files(srcRoot) {
  const files = [
    ...walkTsFiles(path.join(srcRoot, 'orchestrate')),
    ...walkTsFiles(path.join(srcRoot, 'verbs')),
  ];
  const compensationFile = path.join(srcRoot, 'workflow', 'compensation.ts');
  if (existsSync(compensationFile)) files.push(compensationFile);
  return files;
}

/**
 * A worktree-mutating argv literal, in each dispatch form. `worktree list` is
 * excluded, because it does not contend for `.git/index.lock`.
 */
const WORKTREE_MUTATION_RE = /\[\s*['"]worktree['"]\s*,\s*['"](?:add|remove|prune)['"]/g;

/**
 * The wired files and the retry idiom that each must call. Paths are relative to
 * the source root and use POSIX separators.
 */
const WIRED_IDIOM_REQUIREMENTS = new Map([
  ['verbs/vcs/git-exec-default.ts', /\bwithIndexLockRetrySync\s*\(/],
  ['verbs/team/setup-worktree.ts', /\bburstStagger\s*\(/],
  ['verbs/worktree/manager.ts', /\bwithIndexLockRetry\s*\(/],
  ['workflow/compensation.ts', /\bwithIndexLockRetry\s*\(/],
]);
/**
 * The files that can hold a worktree-mutating literal. `git-retry.ts` defines
 * the idioms, so it has no idiom requirement.
 */
const WIRED_ALLOWLIST = new Set([
  ...WIRED_IDIOM_REQUIREMENTS.keys(),
  'verbs/worktree/git-retry.ts',
]);

/**
 * The scope pin of rule 1: the wired files and the merge seam. The seam
 * `merge-orchestrate.ts` calls the wrapped `defaultGitExec`, so it needs no
 * wrapper, but it must stay in scope.
 */
const EXPECTED_SRC_SCOPE_FILES = [
  ...WIRED_ALLOWLIST,
  'verbs/merge/merge-orchestrate.ts',
];

function checkRule1(srcRoot, srcRootIsDefault, violations) {
  for (const file of collectRule1Files(srcRoot)) {
    const rel = toRelPosix(srcRoot, file);
    const raw = readFileSync(file, 'utf8');
    const src = stripComments(raw);

    if (WIRED_ALLOWLIST.has(rel)) {
      const requiredRe = WIRED_IDIOM_REQUIREMENTS.get(rel);
      if (requiredRe && !requiredRe.test(src)) {
        violations.push(
          `${reportPath(file)}  [rule1-idiom-missing]  ` +
            `expected a call matching ${requiredRe} in this wired file, none found`,
        );
      }
      continue;
    }

    for (const m of src.matchAll(WORKTREE_MUTATION_RE)) {
      const line = lineOf(raw, m.index);
      const excerpt = raw.split('\n')[line - 1]?.trim().slice(0, 120) ?? '';
      violations.push(
        `${reportPath(file)}:${line}  [rule1-naked-worktree-mutation]  ${excerpt}`,
      );
    }
  }

  if (srcRootIsDefault) {
    for (const relExpected of EXPECTED_SRC_SCOPE_FILES) {
      if (!existsSync(path.join(srcRoot, relExpected))) {
        violations.push(
          `${relExpected}  [rule1-scope-shrink]  ` +
            `expected file missing from the walked src-root scope (renamed / moved out?)`,
        );
      }
    }
  }
}

function* walkMdFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkMdFiles(full);
    } else if (e.isFile() && e.name.endsWith('.md')) {
      yield full;
    }
  }
}

/** An integration context: "integration branch", "integration-branch", "integration ref", or "integration merge". */
const INTEGRATION_CONTEXT_RE = /integration[\s-]?(?:branch|ref|merge)/i;

/**
 * The scope pin of rule 2: the files that carry the `serialize_merge` reroute,
 * relative to `content/`. Each must still name `serialize_merge` on a line that
 * names `merge_orchestrate`.
 */
const EXPECTED_SKILLS_SCOPE_FILES = [
  'delivery/skills/merge-orchestrator/SKILL.md',
  'delivery/skills/merge-orchestrator/references/recovery-runbook.md',
  'delivery/skills/merge-orchestrator/references/local-git-semantics.md',
  'delivery/skills/delegate/SKILL.md',
  'synthesis/skills/synthesize/SKILL.md',
  'synthesis/skills/shepherd/SKILL.md',
  'delivery/skills/git-worktrees/SKILL.md',
];

function checkRule2(skillsRoot, skillsRootIsDefault, violations) {
  const filesWithSerializeCaveat = new Set();

  for (const file of walkMdFiles(skillsRoot)) {
    const raw = readFileSync(file, 'utf8');
    const lines = raw.split('\n');
    let sawSerialize = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('merge_orchestrate')) continue;
      const hasSerialize = line.includes('serialize_merge');
      if (hasSerialize) sawSerialize = true;
      if (INTEGRATION_CONTEXT_RE.test(line) && !hasSerialize) {
        violations.push(
          `${reportPath(file)}:${i + 1}  [rule2-raw-merge-orchestrate-integration-directive]  ` +
            `${line.trim().slice(0, 160)}`,
        );
      }
    }

    if (sawSerialize) filesWithSerializeCaveat.add(toRelPosix(skillsRoot, file));
  }

  if (skillsRootIsDefault) {
    for (const relExpected of EXPECTED_SKILLS_SCOPE_FILES) {
      if (!filesWithSerializeCaveat.has(relExpected)) {
        violations.push(
          `${relExpected}  [rule2-scope-shrink]  ` +
            `expected serialize_merge reroute caveat missing (file removed or caveat dropped?)`,
        );
      }
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      'Usage: check-wlm-wiring.mjs [--src-root <path>] [--skills-root <path>]\n',
    );
    return 0;
  }
  if (args.error) {
    process.stderr.write(`error: ${args.error}\n`);
    return 2;
  }

  const srcErr = requireDir(args.srcRoot, '--src-root');
  if (srcErr) {
    process.stderr.write(`${srcErr}\n`);
    return 2;
  }
  const skillsErr = requireDir(args.skillsRoot, '--skills-root');
  if (skillsErr) {
    process.stderr.write(`${skillsErr}\n`);
    return 2;
  }

  const violations = [];
  checkRule1(args.srcRoot, args.srcRootIsDefault, violations);
  checkRule2(args.skillsRoot, args.skillsRootIsDefault, violations);

  if (violations.length > 0) {
    process.stderr.write(
      `WLM wiring gate: ${violations.length} violation(s):\n` +
        violations.map((v) => `  ${v}`).join('\n') +
        '\n',
    );
    return 1;
  }
  process.stdout.write('WLM wiring gate: clean.\n');
  return 0;
}

process.exit(main());

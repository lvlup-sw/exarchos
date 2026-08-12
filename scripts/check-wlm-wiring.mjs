#!/usr/bin/env node
/**
 * WLM wiring gate — DR-1 (index.lock retry kernel) + DR-2 (single-writer
 * reroute) regression fence (task-004).
 *
 * Two independent, additive rules. Modeled on
 * `scripts/check-windows-portability.mjs`: a zero-dependency Node script that
 * walks files and flags a regression at PR time, seconds instead of the full
 * suite.
 *
 *   Rule 1 — retry-adapter coverage (DR-1). Every worktree-mutating git
 *   invocation (a `['worktree', 'add'|'remove'|'prune', …]` argv literal,
 *   however it's dispatched — `gitRunner.run(…)`, `runCommand('git', …)`,
 *   `gitExec(…)`, a raw `execFileSync('git', …)`) anywhere under
 *   `servers/exarchos-mcp/src/orchestrate/` (recursively) or in
 *   `servers/exarchos-mcp/src/workflow/compensation.ts` must be constructed
 *   ONLY inside one of the 5 production files that own the DR-1 retry
 *   kernel's wrapping (`WIRED_ALLOWLIST` below) — every other file is
 *   presumed naked and flagged. Each allow-listed file is in turn required to
 *   actually CALL its retry idiom (`withIndexLockRetry`/`withIndexLockRetrySync`/
 *   `burstStagger`), so gutting the wrapper without removing the call site
 *   still fails. A scope-pin (default root only) asserts the merge seam
 *   (`merge-orchestrate.ts`) and the 5 wired files are still inside the
 *   walked scope, so relocating a site out from under the gate to dodge it
 *   is itself a failure.
 *
 *   Rule 2 — no raw `merge_orchestrate` directive for an INTEGRATION merge in
 *   `skills-src/` (DR-2). Every current legitimate co-mention of
 *   `merge_orchestrate` with integration-branch language is paired with
 *   `serialize_merge` on the SAME line (the caveat). A line naming
 *   `merge_orchestrate` in an integration-branch/-ref/-merge context WITHOUT
 *   `serialize_merge` alongside it is flagged. A scope-pin (default root
 *   only) asserts the 7 rerouted surfaces (merge-orchestrator contributes 3
 *   files) still carry the `serialize_merge` caveat, so silently deleting the
 *   reroute (rather than reintroducing a bad directive) is also caught.
 *
 *   Exit 0 — clean.  Exit 1 — violations (`path:line  [rule]  excerpt` on
 *   stderr).  Exit 2 — usage / environment error.
 *
 * Flags:
 *   --src-root <path>     Root containing `orchestrate/` + `workflow/` for
 *                          Rule 1 (default: repo `servers/exarchos-mcp/src`).
 *   --skills-root <path>  Root containing skill sources for Rule 2 (default:
 *                          repo `skills-src`).
 *   --help                Show usage.
 *
 * The scope-pin checks for each rule are suppressed when its root is
 * overridden via a flag — a fixture root is deliberately partial, so pinning
 * the full-tree scope there would be a false alarm. The real-tree CI
 * invocation uses no overrides, so the pin stays live where it matters.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_SRC_ROOT = path.join(REPO_ROOT, 'servers', 'exarchos-mcp', 'src');
const DEFAULT_SKILLS_ROOT = path.join(REPO_ROOT, 'skills-src');

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

// Replace comments with same-length blanks (newlines preserved) so a prose
// mention in a docstring cannot trip the gate, while offsets still map to the
// correct source line. Same shape as check-windows-portability.mjs.
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

// ─── Rule 1 — retry-adapter coverage (DR-1) ─────────────────────────────────

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
      // Production only — fixtures/unit tests legitimately spawn raw
      // `git worktree add/remove` against throwaway repos; that is not the
      // DR-1 concern (real, burst-dispatched production contention).
      yield full;
    }
  }
}

function collectRule1Files(srcRoot) {
  const files = [...walkTsFiles(path.join(srcRoot, 'orchestrate'))];
  const compensationFile = path.join(srcRoot, 'workflow', 'compensation.ts');
  if (existsSync(compensationFile)) files.push(compensationFile);
  return files;
}

// A worktree-mutating argv literal — `['worktree', 'add'|'remove'|'prune', …]`
// — however it's dispatched (`gitRunner.run(…)`, `runCommand('git', …)`,
// `gitExec(…)`, a raw `execFileSync('git', …)`). Read-only subcommands
// (`worktree list`) are deliberately excluded — they never contend for
// `.git/index.lock`.
const WORKTREE_MUTATION_RE = /\[\s*['"]worktree['"]\s*,\s*['"](?:add|remove|prune)['"]/g;

// The 5 production files that legitimately construct a worktree-mutating argv
// literal today — each owns (or, for git-retry.ts, defines) the DR-1 retry
// wrapping. Every other file under scope is presumed naked. Paths are
// src-root-relative, POSIX-separated.
const WIRED_IDIOM_REQUIREMENTS = new Map([
  ['verbs/vcs/git-exec-default.ts', /\bwithIndexLockRetrySync\s*\(/],
  ['verbs/team/setup-worktree.ts', /\bburstStagger\s*\(/],
  ['verbs/worktree/manager.ts', /\bwithIndexLockRetry\s*\(/],
  ['workflow/compensation.ts', /\bwithIndexLockRetry\s*\(/],
]);
// git-retry.ts IS the kernel — it defines the idioms rather than calling one
// of them, so it is allow-listed without an idiom-presence requirement.
const WIRED_ALLOWLIST = new Set([
  ...WIRED_IDIOM_REQUIREMENTS.keys(),
  'verbs/worktree/git-retry.ts',
]);

// Scope-pin (default root only): the 5 wired files plus the merge seam
// (`merge-orchestrate.ts`, which must stay INSIDE the walked scope even
// though it needs no wrapping of its own — it delegates to the already-
// wrapped `defaultGitExec`). If any goes missing from the walked scope
// (renamed, or the directory moved), that is itself a failure — silently
// shrinking the gate's scope must never look like a clean pass.
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
      continue; // Allow-listed: exempt from the naked-mutation scan below.
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

// ─── Rule 2 — no raw `merge_orchestrate` for an integration merge (DR-2) ────

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

// An "integration-merge directive" context — the phrase that must never
// appear naming raw `merge_orchestrate` without the `serialize_merge` caveat
// on the SAME line. Matches "integration branch", "integration-branch",
// "integration ref", "shared integration", "integration merge", etc.
const INTEGRATION_CONTEXT_RE = /integration[\s-]?(?:branch|ref|merge)/i;

// The 7 surfaces task-007 rerouted (merge-orchestrator contributes 3 files:
// SKILL.md + its two references/). Scope-pin (default root only): each must
// still carry the `serialize_merge` caveat somewhere — if a file is deleted
// or its reroute caveat silently dropped (rather than a bad directive being
// reintroduced), that is itself a regression the same-line check alone can't
// see.
const EXPECTED_SKILLS_SCOPE_FILES = [
  'merge-orchestrator/SKILL.md',
  'merge-orchestrator/references/recovery-runbook.md',
  'merge-orchestrator/references/local-git-semantics.md',
  'delegate/SKILL.md',
  'synthesize/SKILL.md',
  'shepherd/SKILL.md',
  'git-worktrees/SKILL.md',
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

// ─── Entry point ─────────────────────────────────────────────────────────────

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

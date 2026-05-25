// Retirement guard for the `axiom` plugin dependency (#1477).
//
// #1477 fully excised axiom: the `plugins.axiom` config block, the review
// orchestrator's `pluginStatus.axiom` + `axiom:audit` invocation, the
// `axiom_overlap` / `DIM-*` catalog machinery, and every skill/command that
// invoked an `axiom:*` skill. This guard pins the excision so axiom cannot
// quietly return through a *functional* surface. It deliberately matches
// functional usage (config reads, skill invocations, TS identifiers, YAML
// fields) and NOT bare prose/comment mentions — historical comments that
// document the retirement (e.g. "the axiom_overlap field was removed") are
// legitimate and must not fail the guard.

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');

// Live surfaces that must carry zero functional axiom coupling. Dated record
// trees under docs/ (designs, plans, research, …) are point-in-time artifacts
// and are intentionally out of scope — see vocabulary-lint scanRepoDefaults.
const SCAN_ROOTS = [
  path.join(REPO_ROOT, 'servers/exarchos-mcp/src'),
  path.join(REPO_ROOT, 'skills-src'),
  path.join(REPO_ROOT, 'commands'),
];
const CONFIG_FILE = path.join(REPO_ROOT, '.exarchos.yml');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

// Functional patterns — these indicate axiom is still *wired in*, not merely
// named. Comment lines (// or *-leading) are stripped before matching so
// retirement-documenting comments survive.
const FUNCTIONAL_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'axiom skill invocation', re: /axiom:(audit|critique|harden|distill|verify|scan|humanize|design|backend-quality|scaffold-invariants)/ },
  { label: 'plugins.axiom config access', re: /plugins\s*[?.]\s*axiom/ },
  { label: 'pluginStatus.axiom access', re: /pluginStatus\s*\.\s*axiom/ },
  { label: 'axiomOverlap identifier', re: /\baxiomOverlap\b/ },
  { label: 'axiom_overlap YAML field', re: /^\s*axiom_overlap\s*:/ },
];

function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  // `#` covers YAML comments (e.g. `# axiom_overlap: removed in #1477`) and
  // markdown headings — both scanned here as .yml/.yaml/.md. //, *, /* cover TS.
  return (
    t.startsWith('//') ||
    t.startsWith('*') ||
    t.startsWith('/*') ||
    t.startsWith('#')
  );
}

function* walk(root: string): Generator<string> {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(path.join(root, entry.name));
    } else if (
      /\.(ts|md|yml|yaml|json)$/.test(entry.name) &&
      // Test files legitimately name the retired identifiers to assert their
      // absence (e.g. `expect(entry.axiomOverlap).toBeUndefined()`). The sweep
      // targets production + content surfaces, not absence-verification tests.
      !/\.test\.ts$/.test(entry.name)
    ) {
      yield path.join(root, entry.name);
    }
  }
}

// Block-style YAML reintroduction (`plugins:\n  axiom:`) spans lines, so the
// line-anchored patterns above cannot see it. This whole-file regex catches it
// in any scanned `.yml`/`.yaml` (not just `.exarchos.yml`).
const PLUGINS_AXIOM_YAML_BLOCK = /plugins\s*:[\s\S]*?\baxiom\s*:/;

function findFunctionalAxiomRefs(): string[] {
  const hits: string[] = [];
  const files = [...SCAN_ROOTS].flatMap((r) => [...walk(r)]);
  if (fs.existsSync(CONFIG_FILE)) files.push(CONFIG_FILE);
  for (const file of files) {
    // This guard file itself names the patterns it forbids; skip it.
    if (file === fileURLToPath(import.meta.url)) continue;
    const content = fs.readFileSync(file, 'utf8');
    if (/\.(ya?ml)$/.test(file) && PLUGINS_AXIOM_YAML_BLOCK.test(content)) {
      hits.push(`${path.relative(REPO_ROOT, file)} [plugins.axiom YAML block]`);
    }
    content.split('\n').forEach((line, i) => {
      if (isCommentLine(line)) return;
      for (const { label, re } of FUNCTIONAL_PATTERNS) {
        if (re.test(line)) {
          hits.push(`${path.relative(REPO_ROOT, file)}:${i + 1} [${label}] ${line.trim()}`);
        }
      }
    });
  }
  return hits;
}

describe('axiom retirement (#1477)', () => {
  it('WorkingTree_NoFunctionalAxiomRefs_GrepClean', () => {
    const hits = findFunctionalAxiomRefs();
    expect(
      hits,
      `Functional axiom coupling must be fully excised (#1477). Offending refs:\n${hits.join('\n')}`,
    ).toEqual([]);
  });

  it('ExarchosYml_NoPluginsAxiomBlock_Removed', () => {
    expect(fs.existsSync(CONFIG_FILE), '.exarchos.yml must exist').toBe(true);
    const yml = fs.readFileSync(CONFIG_FILE, 'utf8');
    expect(/plugins\s*:[\s\S]*?\baxiom\s*:/.test(yml)).toBe(false);
  });
});

// Guard for the retired `axiom` plugin dependency (#1477).
//
// The guard fails when axiom comes back through a functional surface: a config read, a skill
// invocation, a TS identifier, or a YAML field. It skips comment lines, so a comment that
// records the retirement does not fail it.

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { SUBJECT_SRC_ROOT, fromRepoRoot } from './subject-root.js';

/**
 * Live surfaces that must carry no functional axiom coupling. The scan leaves out the
 * `docs/` trees, as `scanRepoDefaults` in the vocabulary lint does.
 */
const SCAN_ROOTS = [SUBJECT_SRC_ROOT, fromRepoRoot('content'), fromRepoRoot('commands')];
const CONFIG_FILE = fromRepoRoot('.exarchos.yml');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

/**
 * Patterns that show axiom is still wired in, not only named. The scan skips comment
 * lines before it matches them.
 */
const FUNCTIONAL_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'axiom skill invocation', re: /axiom:(audit|critique|harden|distill|verify|scan|humanize|design|backend-quality|scaffold-invariants)/ },
  { label: 'plugins.axiom config access', re: /plugins\s*[?.]\s*axiom/ },
  { label: 'pluginStatus.axiom access', re: /pluginStatus\s*\.\s*axiom/ },
  { label: 'axiomOverlap identifier', re: /\baxiomOverlap\b/ },
  { label: 'axiom_overlap YAML field', re: /^\s*axiom_overlap\s*:/ },
];

/**
 * Returns true for a line that starts with `//`, `*`, `/*` or `#`. The `#` prefix covers
 * YAML comments and Markdown headings, because the scan also reads those files.
 */
function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return (
    t.startsWith('//') ||
    t.startsWith('*') ||
    t.startsWith('/*') ||
    t.startsWith('#')
  );
}

/**
 * Yields the `.ts`, `.md`, `.yml`, `.yaml` and `.json` files under `root`. It skips test files,
 * because a test names the retired identifiers to assert that they are absent.
 */
function* walk(root: string): Generator<string> {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(path.join(root, entry.name));
    } else if (
      /\.(ts|md|yml|yaml|json)$/.test(entry.name) &&
      !/\.test\.ts$/.test(entry.name)
    ) {
      yield path.join(root, entry.name);
    }
  }
}

/**
 * Matches a `plugins:` key with an `axiom:` key anywhere after it. This catches the block-style
 * YAML form, which spans lines, so the line patterns cannot see it.
 */
const PLUGINS_AXIOM_YAML_BLOCK = /plugins\s*:[\s\S]*?\baxiom\s*:/;

/**
 * Returns one entry for each functional axiom reference in the scan roots and in
 * `.exarchos.yml`. It skips this guard file, which names the patterns that it forbids.
 */
function findFunctionalAxiomRefs(): string[] {
  const hits: string[] = [];
  const files = [...SCAN_ROOTS].flatMap((r) => [...walk(r)]);
  if (fs.existsSync(CONFIG_FILE)) files.push(CONFIG_FILE);
  for (const file of files) {
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

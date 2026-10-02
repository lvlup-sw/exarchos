import type { RuntimeMap } from '../runtimes/types.js';
import { lintRenderedSkill, type VocabularyLintFinding } from '../vocabulary-lint.js';
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { renderCallMacros, toPosix } from './call-macro.js';
import { render } from './render.js';
import { applyRequiresGuards, elideClaudeOnlyCodeBlocks } from './requires-guards.js';

const REFERENCES_LINK_REGEX = /references\/([A-Za-z0-9._\-/]+)/g;

/**
 * Return the paths that `body` links to through `references/<file>` patterns,
 * in Markdown links or in prose. Keep only paths that are files under
 * `referencesDir`, with forward slashes. This scan does not follow links.
 * `collectReferencedFiles` gives the transitive closure.
 */
function extractDirectLinks(body: string, referencesDir: string): Set<string> {
  const linked = new Set<string>();
  const regex = new RegExp(REFERENCES_LINK_REGEX.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    let rel = match[1];
    if (rel === undefined) continue;
    const hashIdx = rel.indexOf('#');
    if (hashIdx !== -1) rel = rel.slice(0, hashIdx);
    rel = rel.replace(/[)"'].*$/, '');
    if (rel.length === 0) continue;
    const candidate = join(referencesDir, rel);
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      linked.add(rel.replace(/\\/g, '/'));
    }
  }
  return linked;
}

/**
 * Return the transitive closure of reference paths that `body` or a reached
 * reference file links to. `body` is the rendered SKILL.md. A reference file
 * often links to deeper helpers, and a direct scan alone prunes them as orphans.
 * Each reference file goes through `applyRequiresGuards` for `runtime` before
 * the scan reads its links. Thus a link in an elided `<!-- requires:* -->` block
 * pulls in no file. The walk is breadth-first, and the `linked` set stops cycles.
 */
export function collectReferencedFiles(
  body: string,
  referencesDir: string,
  runtime: RuntimeMap,
): Set<string> {
  const linked = new Set<string>();
  const queue: string[] = [];
  for (const direct of extractDirectLinks(body, referencesDir)) {
    if (!linked.has(direct)) {
      linked.add(direct);
      queue.push(direct);
    }
  }
  while (queue.length > 0) {
    const rel = queue.shift()!;
    const filePath = join(referencesDir, rel);
    if (!existsSync(filePath)) continue;
    let refBody: string;
    try {
      refBody = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const guardedRefBody = applyRequiresGuards(refBody, runtime, filePath);
    for (const next of extractDirectLinks(guardedRefBody, referencesDir)) {
      if (!linked.has(next)) {
        linked.add(next);
        queue.push(next);
      }
    }
  }
  return linked;
}

/**
 * Copy the reference files in `linked` from `srcRefs` to `destRefs`, with the
 * directory structure and mtimes. The function skips files outside `linked`. An
 * empty `linked` set creates no directory. `writtenPaths` collects each written path.
 */
function copyLinkedReferences(
  srcRefs: string,
  destRefs: string,
  linked: Set<string>,
  writtenPaths?: Set<string>,
): void {
  if (linked.size === 0) return;
  mkdirSync(destRefs, { recursive: true });

  for (const rel of linked) {
    const srcFile = join(srcRefs, rel);
    if (!existsSync(srcFile)) continue;
    const srcStat = statSync(srcFile);
    if (!srcStat.isFile()) continue;
    const destFile = join(destRefs, rel);
    mkdirSync(dirname(destFile), { recursive: true });
    const contents = readFileSync(srcFile);
    writeFileSync(destFile, contents);
    utimesSync(destFile, srcStat.atime, srcStat.mtime);
    if (writtenPaths) writtenPaths.add(resolve(destFile));
  }
}

/**
 * Reference file extensions that go through the SKILL.md render pipeline.
 * Other files are byte-copied, so binary, JSON and YAML files stay unchanged.
 */
const RENDERED_REFERENCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md',
  '.markdown',
]);

/**
 * Write the reference files in `linked` from `srcRefs` to `destRefs` for
 * `runtime`. The function skips files outside `linked`. A Markdown file goes through
 * `applyRequiresGuards`, `renderCallMacros`, `render` and
 * `elideClaudeOnlyCodeBlocks`, as SKILL.md does. Unknown tokens stay in place,
 * because references carry handlebar templates that dispatch fills later.
 * Other files are byte-copied with their mtime.
 *
 * `writtenPaths` collects each written path. `vocabularyFindings` collects the
 * vocabulary-lint findings of each rendered file, with the reference path as
 * `sourcePath`. A render error names the reference file.
 */
export function renderLinkedReferences(
  srcRefs: string,
  destRefs: string,
  linked: Set<string>,
  runtime: RuntimeMap,
  writtenPaths?: Set<string>,
  vocabularyFindings?: VocabularyLintFinding[],
): void {
  if (linked.size === 0) return;
  mkdirSync(destRefs, { recursive: true });

  for (const rel of linked) {
    const srcFile = toPosix(join(srcRefs, rel));
    if (!existsSync(srcFile)) continue;
    const srcStat = statSync(srcFile);
    if (!srcStat.isFile()) continue;
    const destFile = join(destRefs, rel);
    mkdirSync(dirname(destFile), { recursive: true });

    const dotIdx = rel.lastIndexOf('.');
    const ext = dotIdx === -1 ? '' : rel.slice(dotIdx).toLowerCase();
    if (RENDERED_REFERENCE_EXTENSIONS.has(ext)) {
      const body = readFileSync(srcFile, 'utf8');
      try {
        const guardElided = applyRequiresGuards(body, runtime, srcFile);
        const macroExpanded = renderCallMacros(guardElided, runtime);
        const rendered = elideClaudeOnlyCodeBlocks(
          render(macroExpanded, runtime.placeholders, {
            sourcePath: srcFile,
            runtimeName: runtime.name,
            lenientUnknownTokens: true,
          }),
          runtime,
        );
        if (vocabularyFindings) {
          vocabularyFindings.push(
            ...lintRenderedSkill(rendered, srcFile, runtime),
          );
        }
        writeFileSync(destFile, rendered);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes(srcFile)) throw err;
        throw new Error(`Reference render error in ${srcFile}: ${msg}`);
      }
    } else {
      const contents = readFileSync(srcFile);
      writeFileSync(destFile, contents);
      utimesSync(destFile, srcStat.atime, srcStat.mtime);
    }
    if (writtenPaths) writtenPaths.add(resolve(destFile));
  }
}

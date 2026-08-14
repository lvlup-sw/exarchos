import type { RuntimeMap } from '../runtimes/types.js';
import { lintRenderedSkill, type VocabularyLintFinding } from '../vocabulary-lint.js';
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { renderCallMacros, toPosix } from './call-macro.js';
import { render } from './render.js';
import { applyRequiresGuards, elideClaudeOnlyCodeBlocks } from './requires-guards.js';

const REFERENCES_LINK_REGEX = /references\/([A-Za-z0-9._\-/]+)/g;

/**
 * Extract the set of references-relative paths that `body` links to via
 * `references/<file>` patterns (in markdown links or bare prose).
 * Returns paths that resolve to an on-disk file under `referencesDir`.
 * Paths are normalized to forward slashes so set membership works on
 * Windows and matches the `references/` on-disk layout.
 *
 * Single-pass: callers wanting transitive closure should use
 * `collectReferencedFiles` instead.
 */
function extractDirectLinks(body: string, referencesDir: string): Set<string> {
  const linked = new Set<string>();
  const regex = new RegExp(REFERENCES_LINK_REGEX.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    let rel = match[1];
    if (rel === undefined) continue;
    // Strip URL fragment (e.g. `foo.md#section`) — link targets the file.
    const hashIdx = rel.indexOf('#');
    if (hashIdx !== -1) rel = rel.slice(0, hashIdx);
    // Strip any trailing parens/quotes that the lazy regex may have
    // captured if the link was `(references/foo.md)` without a label.
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
 * Walk `body` (the rendered SKILL.md after guards + macros + tokens have
 * been processed) and return the *transitive closure* of references-
 * relative paths that the body or any reachable reference file links to.
 *
 * Why transitive: skill prose often delegates substantive material to
 * a reference file which in turn links to deeper helpers (e.g.
 * `polish-track.md` references `phases/polish-implement.md`). A
 * non-transitive scan would prune the deeper helpers as orphans even
 * though the skill would break in practice when the user follows the
 * first link.
 *
 * Runtime-aware: each reference file's content is run through
 * `applyRequiresGuards` against `runtime` before its outgoing links
 * are extracted. This prevents links inside elided `<!-- requires:* -->`
 * blocks from spuriously pulling files into the runtime variant — the
 * elided block has been pruned for the rendered SKILL.md and the
 * transitive scan must honor the same elision when descending into
 * referenced files (Sentry #1181 LOW).
 *
 * Files that exist on disk but are not in the returned set are pruned
 * by `copyLinkedReferences`. The `referencesDir` argument filters out
 * matches that don't correspond to an on-disk file — typo'd links
 * surface via the lint, not here.
 */
export function collectReferencedFiles(
  body: string,
  referencesDir: string,
  runtime: RuntimeMap,
): Set<string> {
  const linked = new Set<string>();
  // BFS over the link graph rooted at `body`. Each visited reference
  // file contributes its own outgoing links, expanding the set until
  // closure. Visited tracking on `linked` prevents cycles from looping.
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
      // Binary or unreadable — no outgoing links to traverse.
      continue;
    }
    // Apply runtime guards so links inside `<!-- requires:* -->` blocks
    // that elide for this runtime are NOT followed (Sentry #1181 LOW).
    // Diagnostics from the guard parser surface with the reference
    // file's path so authors can fix offending guards in place.
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
 * Copy only the references files in `linked` from `srcRefs` to
 * `destRefs`, preserving directory structure. Files not in `linked`
 * are skipped so an elided guard's referenced files do not bleed into
 * runtimes that don't link to them.
 *
 * Symmetric with `copyTreePreservingMtime` for mtime preservation and
 * the optional `writtenPaths` accumulator that `buildAllSkills` uses
 * for stale-cleanup tracking. Creates the destination directory only
 * when at least one file is copied — avoids spawning empty
 * `references/` directories under runtimes that drop every link.
 */
function copyLinkedReferences(
  srcRefs: string,
  destRefs: string,
  linked: Set<string>,
  writtenPaths?: Set<string>,
): void {
  if (linked.size === 0) return;
  // Materialize parent dir before writing children.
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
 * File extensions whose contents go through the same render pipeline
 * SKILL.md uses (guards → CALL macros → tokens → claude-only fenced-block
 * elision). Anything not in this set is byte-copied so binary blobs
 * (PNGs, GIFs, screenshots embedded in references) survive intact.
 *
 * Conservative on purpose — if an author drops a `.json` schema or
 * `.yaml` snippet into `references/` they almost certainly want it
 * verbatim. Markdown is the only format that actually carries
 * `{{TOKEN}}` and `<!-- requires:* -->` syntax in the source tree, so
 * narrowing to `.md` keeps the blast radius of the new pipeline tiny.
 */
const RENDERED_REFERENCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md',
  '.markdown',
]);

/**
 * Wave C: render the references files in `linked` from `srcRefs` to
 * `destRefs`, applying the same per-runtime pipeline as SKILL.md.
 * Symmetric with `copyLinkedReferences` (which it replaces in
 * `buildAllSkills`): files outside `linked` are skipped so an elided
 * guard's referenced files do not bleed into runtimes that don't link
 * to them.
 *
 * Pipeline for Markdown references (matches the SKILL.md pipeline in
 * `buildAllSkills` exactly):
 *   1. `applyRequiresGuards` — elide blocks whose required capability
 *      isn't declared by the runtime.
 *   2. `renderCallMacros` — expand `{{CALL ...}}` to the runtime's
 *      preferred facade.
 *   3. `render` — substitute `{{TOKEN}}` placeholders.
 *   4. `elideClaudeOnlyCodeBlocks` — drop fenced blocks tagged
 *      `runtime:claude-only` from non-Claude renders.
 *   5. `assertNoUnresolvedPlaceholders` — fail fast on a residual
 *      `{{...}}` so a typo in a reference surfaces with the same
 *      diagnostic shape as a SKILL.md typo.
 *
 * Non-Markdown references (anything outside
 * `RENDERED_REFERENCE_EXTENSIONS`) byte-copy unchanged with mtime
 * preservation, identical to the pre-Wave-C behavior. This keeps
 * binary blobs intact while the new pipeline only touches the file
 * formats that actually carry placeholder/guard syntax.
 *
 * @param srcRefs - Source `references/` directory.
 * @param destRefs - Per-runtime destination `references/` directory.
 * @param linked - Reference paths (relative to `srcRefs`) that survive
 *   the link-prune pass; everything else is dropped.
 * @param runtime - Target runtime; drives placeholder substitution,
 *   guard evaluation, and Claude-only elision.
 * @param writtenPaths - Optional accumulator for the stale-cleanup
 *   pass in `buildAllSkills`. Mirrors the `copyLinkedReferences`
 *   contract so the caller can swap implementations transparently.
 * @param vocabularyFindings - Optional accumulator for Wave C's
 *   vocabulary-lint extension. After rendering each Markdown
 *   reference, the bytes about to hit disk are scanned for forbidden
 *   Claude-only terms via `lintRenderedSkill`; findings are appended
 *   here using the reference file path as `sourcePath` so the
 *   aggregated diagnostic in `buildAllSkills` points authors at the
 *   actual offender (not the SKILL.md that linked it).
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
  // Materialize parent dir before writing children.
  mkdirSync(destRefs, { recursive: true });

  for (const rel of linked) {
    const srcFile = toPosix(join(srcRefs, rel));
    if (!existsSync(srcFile)) continue;
    const srcStat = statSync(srcFile);
    if (!srcStat.isFile()) continue;
    const destFile = join(destRefs, rel);
    mkdirSync(dirname(destFile), { recursive: true });

    // Decide pipeline vs byte-copy by file extension. Markdown
    // references go through the same render passes as SKILL.md so
    // guards/tokens/claude-only blocks behave identically. Everything
    // else (binary blobs, JSON, YAML) is preserved verbatim with
    // mtime so existing reference assets aren't corrupted by an
    // accidental re-encoding pass.
    const dotIdx = rel.lastIndexOf('.');
    const ext = dotIdx === -1 ? '' : rel.slice(dotIdx).toLowerCase();
    if (RENDERED_REFERENCE_EXTENSIONS.has(ext)) {
      const body = readFileSync(srcFile, 'utf8');
      try {
        const guardElided = applyRequiresGuards(body, runtime, srcFile);
        const macroExpanded = renderCallMacros(guardElided, runtime);
        // `lenientUnknownTokens: true` — references legitimately carry
        // handlebar-style template literals (e.g. `{{category}}`,
        // `{{#each hints}}`) that are populated downstream at dispatch
        // time, not by the renderer. Throwing on unknown tokens here
        // would force authors to rewrite every template-bearing
        // reference. The placeholder-lint already excludes references
        // by design (see `placeholder-lint.ts` header comment) — the
        // renderer matches that contract by leaving unknowns intact.
        const rendered = elideClaudeOnlyCodeBlocks(
          render(macroExpanded, runtime.placeholders, {
            sourcePath: srcFile,
            runtimeName: runtime.name,
            lenientUnknownTokens: true,
          }),
          runtime,
        );
        // Wave C: scan the rendered reference bytes for forbidden
        // Claude-only terms. Findings are aggregated into the shared
        // accumulator (one per occurrence per runtime) so the build's
        // post-loop diagnostic surfaces every offender at once with
        // the reference file path — authors can jump straight to the
        // line, no need to grep through SKILL.md links.
        if (vocabularyFindings) {
          vocabularyFindings.push(
            ...lintRenderedSkill(rendered, srcFile, runtime),
          );
        }
        writeFileSync(destFile, rendered);
      } catch (err) {
        // Re-throw with source file context if the inner error doesn't
        // already mention it — mirrors the SKILL.md branch's wrapping
        // behavior so a CALL macro / placeholder failure inside a
        // reference points the author at the exact file.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes(srcFile)) throw err;
        throw new Error(`Reference render error in ${srcFile}: ${msg}`);
      }
    } else {
      // Binary or non-Markdown reference: byte-copy with mtime
      // preserved so timestamp-sensitive consumers see no churn.
      const contents = readFileSync(srcFile);
      writeFileSync(destFile, contents);
      utimesSync(destFile, srcStat.atime, srcStat.mtime);
    }
    if (writtenPaths) writtenPaths.add(resolve(destFile));
  }
}

/**
 * Pre-flight: enforce that every loaded runtime declares a value for
 * every token in `RuntimeTokenKey`. Aggregates all missing
 * (runtime, token) pairs into a single error so authors fix the YAML in
 * one pass — without this, a typo or missed entry would only surface
 * for whichever runtime renders the offending source first.
 *
 * Adding a token to `RuntimeTokenKey` and forgetting to add it to even
 * one of the six runtime YAMLs is the most common Wave A authoring
 * mistake; this check catches it before any rendering happens.
 *
 * Throws with a sorted (runtime, token) listing for determinism.
 *
 * Exported so the collapsed-vocabulary work (harness conform-and-shrink) can
 * pin, in a unit test, that the prefix tokens (`MCP_PREFIX`/`COMMAND_PREFIX`)
 * stay in the required-coverage set for as long as they are still consumed —
 * they are only retired from `content/` in a later rewrite task, so dropping
 * them from `RuntimeTokenKey` early would silently un-cover every runtime YAML.
 */

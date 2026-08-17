import { canonicalCommandSet } from '../config/canonical-skills.js';
import { lintPlaceholders } from '../placeholder-lint.js';
import { loadAllRuntimes } from '../runtimes/load.js';
import type { RuntimeMap } from '../runtimes/types.js';
import { classifySkill } from '../skill-vocabulary.js';
import { formatVocabularyLintMessage, lintRenderedSkill, type VocabularyLintFinding } from '../vocabulary-lint.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { renderCallMacros, toPosix } from './call-macro.js';
import { cleanStaleFiles } from './out-dir.js';
import { assertNoUnresolvedPlaceholders, validateChainTargets } from './placeholders.js';
import { assertProceduralSkill } from './procedural.js';
import { collectReferencedFiles, renderLinkedReferences } from './reference-links.js';
import { render } from './render.js';
import { applyRequiresGuards, elideClaudeOnlyCodeBlocks } from './requires-guards.js';
import { STANDARD_RUNTIME, STANDARD_TREE_NAME } from './standard-runtime.js';
import { assertRuntimeTokenCoverage, unionPlaceholderKeys, walkSkillSourceDirs } from './token-coverage.js';

export interface BuildReport {
  variantsWritten: number;
  referencesCopied: number;
  overridesUsed: string[];
  warnings: string[];
}

/**
 * Orchestrator: render every source skill once per loaded runtime into
 * a per-runtime output tree.
 *
 * For each `srcDir/**\/SKILL.md` source:
 *   - If a runtime-specific override `SKILL.<runtime>.md` exists in the
 *     same skill directory, that override is written verbatim to the
 *     runtime's output (no rendering, no placeholder validation). The
 *     override path is recorded in `BuildReport.overridesUsed`.
 *   - Otherwise the source body is rendered with the runtime's
 *     `placeholders` map and the result is validated with
 *     `assertNoUnresolvedPlaceholders` before being written.
 *   - Any `references/` subdirectory next to the source `SKILL.md` is
 *     mirrored under each runtime's output variant.
 *
 * After writing all variants, any file under `outDir/<runtime>/` that
 * was not produced by this run is removed. Files outside
 * `outDir/<runtime>/` are never touched.
 *
 * Throws if `srcDir` contains no `SKILL.md` files.
 *
 * @param opts.srcDir - Source root (e.g. `content/`).
 * @param opts.outDir - Per-runtime output root (e.g. `skills/`). Each
 *   runtime gets a subdirectory named after its `RuntimeMap.name`.
 * @param opts.runtimesDir - Directory containing runtime YAML files
 *   consumed by `loadAllRuntimes`.
 * @returns Populated `BuildReport`.
 */
export function buildAllSkills(opts: {
  srcDir: string;
  outDir: string;
  runtimesDir: string;
}): BuildReport {
  const runtimes: RuntimeMap[] = loadAllRuntimes(opts.runtimesDir);
  const skillDirs = walkSkillSourceDirs(opts.srcDir);

  if (skillDirs.length === 0) {
    throw new Error(
      `buildAllSkills: no SKILL.md files found under ${opts.srcDir} — refusing to produce an empty build.`,
    );
  }

  // Pre-flight: every runtime YAML must declare every canonical token in
  // its `placeholders` map. This is a forcing function that turns a
  // missing entry into a single aggregated error naming every (runtime,
  // token) pair, instead of a per-render `unknown placeholder` failure
  // for whichever runtime iterates first. Implements Wave A coverage
  // guarantee for `RuntimeTokenKey`.
  assertRuntimeTokenCoverage(runtimes);

  // Pre-flight: enforce the placeholder vocabulary. Running this
  // *before* the renderer means a stray `{{NOT_A_REAL_TOKEN}}`
  // surfaces as a single aggregated error naming every offender,
  // rather than throwing at the first `render()` call for whichever
  // runtime happens to iterate first. Implements DR-3 (lint path).
  //
  // Vocabulary is derived from the union of placeholder keys across
  // every loaded runtime map. In production the union collapses to the
  // canonical `RuntimeTokenKey` vocabulary declared in `content/harness/runtimes/*.yaml`:
  // the two PREFIX tokens (MCP_PREFIX, COMMAND_PREFIX), which are NOT
  // orchestration tokens, plus the five ORCHESTRATION tokens (TASK_TOOL,
  // CHAIN, SPAWN_AGENT_CALL, SUBAGENT_COMPLETION_HOOK, SUBAGENT_RESULT_API).
  // Only the orchestration tokens genuinely fork per harness; see
  // `classifySkill` / `PREFIX_TOKENS` / `ORCHESTRATION_TOKENS` above.
  // In tests that use synthetic fixtures the union is whatever the
  // fixtures declare — the lint self-adjusts so tests never need to
  // carry a duplicate "allowed tokens" list.
  //
  // `enforceCollapsedVocabulary: true` (Task 002 completion): now that the 16
  // procedural sources render from logical prose (`exarchos:exarchos_*` /
  // bare verbs) and carry no prefix tokens, the collapsed-vocabulary rules are
  // enforced on the real tree — a prefix or orchestration token smuggled into a
  // procedural skill is a hard build failure. Orchestration skills (which
  // legitimately reference both kinds) are exempt because the rules key on the
  // source's derived class.
  const vocabulary = unionPlaceholderKeys(runtimes);
  const lintResult = lintPlaceholders({
    sourcesDir: opts.srcDir,
    vocabulary,
    enforceCollapsedVocabulary: true,
  });
  if (!lintResult.passed) {
    throw new Error(lintResult.message);
  }

  // Per-output-tree set of file paths we produced this run. Used by the
  // stale-cleanup pass at the end so we only delete orphans, never files
  // that the current run legitimately wrote. Keyed by output subtree name:
  // one entry per loaded runtime (the orchestration residual) plus the
  // `standard` tree (the single procedural render). Because procedural skills
  // no longer write under `skills/<runtime>/`, their previously rendered
  // per-runtime dirs become orphans and the cleanup pass deletes them (DR-1 —
  // the ~90 stale renders are removed here).
  const writtenByRuntime = new Map<string, Set<string>>();
  for (const rt of runtimes) writtenByRuntime.set(rt.name, new Set());
  writtenByRuntime.set(STANDARD_TREE_NAME, new Set());

  // Valid `{{CHAIN next="..."}}` targets: the canonical workflow verbs plus
  // every on-disk skill directory name. Chain targets in the sources use the
  // canonical verb (e.g. `plan`, `delegate`), which may not yet match the
  // pre-rename directory name, so the canonical set is authoritative; the
  // directory names are unioned in for forward-compatibility with the rename.
  const validChainTargets = new Set<string>(canonicalCommandSet());
  for (const skillDir of skillDirs) {
    const rel = relative(opts.srcDir, skillDir).replace(/\\/g, '/');
    validChainTargets.add(rel);
    const base = rel.split('/').pop();
    if (base) validChainTargets.add(base);
  }

  const overridesUsed: string[] = [];
  const warnings: string[] = [];
  let variantsWritten = 0;
  let referencesCopied = 0;

  // Wave B: aggregate vocabulary-lint findings across every (runtime,
  // skill) pair so the build emits one consolidated diagnostic
  // listing every offender, rather than failing at the first hit.
  const vocabularyFindings: VocabularyLintFinding[] = [];

  // Flattening introduces a namespace hazard that grouped sources do not have:
  // two domains may each author a `review/`, and the output has one slot for
  // that name. Unguarded this is a last-writer-wins overwrite in which the
  // losing skill simply never appears — no error, just a tree missing a skill.
  // Both sources are named because knowing only the winner does not say what
  // was lost.
  const claimedBy = new Map<string, string>();
  for (const skillDir of skillDirs) {
    const name = basename(skillDir);
    const previous = claimedBy.get(name);
    if (previous !== undefined) {
      throw new Error(
        `buildAllSkills: two sources render to the same flat name '${name}' — ` +
          `${toPosix(previous)} and ${toPosix(skillDir)}. The rendered tree has one ` +
          `slot per name; rename one source.`,
      );
    }
    claimedBy.set(name, skillDir);
  }

  for (const skillDir of skillDirs) {
    // Sources are grouped by capability domain; the rendered tree is flat.
    // A harness resolves a skill by its bare name, so the domain a skill is
    // authored under must not leak into the path it renders to.
    const skillName = basename(skillDir);
    const sourcePath = toPosix(join(skillDir, 'SKILL.md'));
    const body = readFileSync(sourcePath, 'utf8');

    // Fail the build on a CHAIN whose target skill does not exist — a dead
    // chain would otherwise render a `Skill(...)` invocation that no-ops at
    // runtime. Runs for every skill; procedural sources carry no CHAIN so it
    // is a no-op there.
    validateChainTargets(body, sourcePath, validChainTargets);

    // Classification drives emission (DR-1/DR-2): a procedural skill collapses
    // to a single runtime-neutral render under `skills/standard/`; an
    // orchestration skill keeps the per-runtime pipeline. `assertProceduralSkill`
    // is the build-time gate that a source authored as procedural has not
    // smuggled in an orchestration token or a `<!-- requires:* -->` guard —
    // either would be silently lost in the collapse.
    const skillClass = classifySkill(body).skillClass;
    if (skillClass === 'procedural') {
      assertProceduralSkill(body, sourcePath);
    }
    // Procedural → the single synthetic `standard` runtime; orchestration →
    // the loaded per-runtime set. The loop body below is identical for both;
    // only the set it iterates and the resolved placeholder map differ.
    const targetRuntimes: RuntimeMap[] =
      skillClass === 'procedural' ? [STANDARD_RUNTIME] : runtimes;

    for (const rt of targetRuntimes) {
      const written = writtenByRuntime.get(rt.name)!;
      const outSkillDir = join(opts.outDir, rt.name, skillName);
      const outSkillFile = join(outSkillDir, 'SKILL.md');
      mkdirSync(outSkillDir, { recursive: true });

      // Escape hatch: runtime-specific override file wins for this
      // runtime only, and is written verbatim with no rendering.
      const overridePath = toPosix(join(skillDir, `SKILL.${rt.name}.md`));
      if (existsSync(overridePath)) {
        const overrideBody = readFileSync(overridePath, 'utf8');
        writeFileSync(outSkillFile, overrideBody);
        written.add(resolve(outSkillFile));
        overridesUsed.push(overridePath);
        variantsWritten++;
        // Override files are still subject to the Wave B vocabulary
        // lint — an author cannot dodge the gate by routing
        // Claude-only prose through a runtime override file. The
        // verbatim contents go straight to the lint with no other
        // processing.
        vocabularyFindings.push(
          ...lintRenderedSkill(overrideBody, overridePath, rt),
        );
      } else {
        try {
          // Pipeline (Wave A + Wave B):
          //   1. Apply `<!-- requires:* -->` guards FIRST so guard-elided
          //      CALL macros and tokens never reach the renderer (a
          //      Claude-only literal under a guard for `team:agent-teams`
          //      would otherwise break OpenCode's render even though it
          //      should have been elided).
          //   2. Expand `{{CALL ...}}` macros to facade-appropriate
          //      output.
          //   3. Substitute `{{TOKEN}}` placeholders.
          //   4. (Wave B) Elide fenced code blocks tagged
          //      `runtime:claude-only` from non-Claude renders.
          //   5. (Wave B) Run the post-render vocabulary lint against
          //      the bytes that will be written, aggregating findings
          //      so all offenders surface in one diagnostic.
          // Do NOT pass `runtime: rt` to `render()` below — that would
          // double-expand CALL macros after step 2.
          const guardElided = applyRequiresGuards(body, rt, sourcePath);
          const macroExpanded = renderCallMacros(guardElided, rt);
          const tokenExpanded = render(macroExpanded, rt.placeholders, {
            sourcePath,
            runtimeName: rt.name,
          });
          const rendered = elideClaudeOnlyCodeBlocks(tokenExpanded, rt);
          assertNoUnresolvedPlaceholders(rendered, sourcePath, rt.name);
          // Wave B: vocabulary lint runs against the exact bytes about
          // to hit disk. Findings are aggregated, not thrown — the
          // post-loop check below converts the aggregate into a
          // single diagnostic.
          vocabularyFindings.push(
            ...lintRenderedSkill(rendered, sourcePath, rt),
          );
          writeFileSync(outSkillFile, rendered);
          written.add(resolve(outSkillFile));
          variantsWritten++;
        } catch (err) {
          // Re-throw macro validation errors with source file context
          // so the developer knows which skill triggered the failure.
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes(sourcePath)) {
            throw err;
          }
          throw new Error(`CALL macro error in ${sourcePath}: ${msg}`);
        }
      }

      // References: render only those linked from the per-runtime
      // rendered SKILL.md so guard-elided sections don't leak their
      // dependent reference files into runtimes that can't make use of
      // them. Files in `references/` not linked from the rendered
      // SKILL.md are NOT written. This is the Wave A "orphan pruning"
      // pass — see `collectReferencedFiles` below for the link
      // discovery contract.
      //
      // Wave C: surviving Markdown references go through the same
      // renderer pipeline that SKILL.md does (guards → CALL macros →
      // tokens → claude-only fenced-block elision) so Claude-only
      // prose inside a guarded section is invisible to non-Claude
      // runtimes. Non-text references (binary blobs) byte-copy as
      // before so we never corrupt them by re-encoding.
      if (existsSync(join(skillDir, 'references'))) {
        // Re-read the just-written rendered SKILL.md so we scan exactly
        // what reached disk (including override files written verbatim).
        const renderedBody = readFileSync(outSkillFile, 'utf8');
        const linked = collectReferencedFiles(
          renderedBody,
          join(skillDir, 'references'),
          rt,
        );
        const before = written.size;
        renderLinkedReferences(
          join(skillDir, 'references'),
          join(outSkillDir, 'references'),
          linked,
          rt,
          written,
          // Wave C: aggregate vocabulary-lint findings against rendered
          // reference bytes into the same list the SKILL.md pass uses.
          // The build's post-loop check below converts every offender
          // — SKILL.md or reference — into one consolidated diagnostic.
          vocabularyFindings,
        );
        referencesCopied += written.size - before;
      }
    }
  }

  // Wave B: aggregated vocabulary lint check. Every (runtime, skill)
  // pair contributed any forbidden-term occurrences to the shared
  // findings list during the render loop above. If any survived to
  // a non-Claude render, fail the build with one consolidated
  // diagnostic naming every offender. The Claude render (and any
  // other runtime declaring `team:agent-teams: native`) is exempt
  // and contributes no findings — see `runtimeAllowsClaudeOnlyTerms`
  // in `vocabulary-lint.ts` for the exemption rationale.
  if (vocabularyFindings.length > 0) {
    throw new Error(formatVocabularyLintMessage(vocabularyFindings));
  }

  // Stale cleanup: any file under an emitted subtree (`outDir/standard/` or
  // `outDir/<runtime>/`) not written this run is deleted. Scoped to each
  // emitted subtree so we never touch unrelated files that happen to sit
  // under `outDir` for other reasons. This is the pass that removes the
  // per-runtime procedural renders now that procedural skills emit only to
  // `standard/` — their old `outDir/<runtime>/<skill>/` dirs are unwritten
  // this run and get pruned (DR-1).
  for (const [treeName, written] of writtenByRuntime) {
    const treeRoot = join(opts.outDir, treeName);
    if (!existsSync(treeRoot)) continue;
    cleanStaleFiles(treeRoot, written);
  }

  return { variantsWritten, referencesCopied, overridesUsed, warnings };
}

/**
 * Matches a markdown link target pointing into the local `references/`
 * directory: e.g. `[label](references/foo.md)` or `references/foo.md`
 * standalone in prose. Capture group 1 is the path component AFTER the
 * `references/` prefix.
 *
 * The pattern is intentionally permissive — it matches inside markdown
 * link syntax and in bare-text references — because skill authors mix
 * both forms. False positives are harmless (the worst case is copying a
 * file that is named in prose but never visited), while false negatives
 * would silently strip a real reference.
 */

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
 * Renders each `SKILL.md` under `opts.srcDir` into `opts.outDir/<tree>/`. A procedural skill renders once to
 * the `standard` tree, so it must carry no orchestration token or `requires` guard. An orchestration skill
 * renders once for each loaded runtime. Before the renders, it checks token coverage, the placeholder
 * vocabulary, and flat-name clashes, and it throws on no sources.
 *
 * A `SKILL.<runtime>.md` override is copied verbatim. Other sources go through `requires` guards, CALL
 * macros, tokens, and claude-only block elision, in that order, so an elided macro never reaches the
 * renderer. `render()` gets no `runtime`, because that expands the CALL macros a second time. Linked
 * Markdown references get the same pipeline. The vocabulary lint reads each output, overrides included, and
 * fails the build with one error. Last, it deletes each unwritten file under the trees of this build.
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

  assertRuntimeTokenCoverage(runtimes);

  const vocabulary = unionPlaceholderKeys(runtimes);
  const lintResult = lintPlaceholders({
    sourcesDir: opts.srcDir,
    vocabulary,
    enforceCollapsedVocabulary: true,
  });
  if (!lintResult.passed) {
    throw new Error(lintResult.message);
  }

  const writtenByRuntime = new Map<string, Set<string>>();
  for (const rt of runtimes) writtenByRuntime.set(rt.name, new Set());
  writtenByRuntime.set(STANDARD_TREE_NAME, new Set());

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

  const vocabularyFindings: VocabularyLintFinding[] = [];

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
    const skillName = basename(skillDir);
    const sourcePath = toPosix(join(skillDir, 'SKILL.md'));
    const body = readFileSync(sourcePath, 'utf8');

    validateChainTargets(body, sourcePath, validChainTargets);

    const skillClass = classifySkill(body).skillClass;
    if (skillClass === 'procedural') {
      assertProceduralSkill(body, sourcePath);
    }
    const targetRuntimes: RuntimeMap[] =
      skillClass === 'procedural' ? [STANDARD_RUNTIME] : runtimes;

    for (const rt of targetRuntimes) {
      const written = writtenByRuntime.get(rt.name)!;
      const outSkillDir = join(opts.outDir, rt.name, skillName);
      const outSkillFile = join(outSkillDir, 'SKILL.md');
      mkdirSync(outSkillDir, { recursive: true });

      const overridePath = toPosix(join(skillDir, `SKILL.${rt.name}.md`));
      if (existsSync(overridePath)) {
        const overrideBody = readFileSync(overridePath, 'utf8');
        writeFileSync(outSkillFile, overrideBody);
        written.add(resolve(outSkillFile));
        overridesUsed.push(overridePath);
        variantsWritten++;
        vocabularyFindings.push(
          ...lintRenderedSkill(overrideBody, overridePath, rt),
        );
      } else {
        try {
          const guardElided = applyRequiresGuards(body, rt, sourcePath);
          const macroExpanded = renderCallMacros(guardElided, rt);
          const tokenExpanded = render(macroExpanded, rt.placeholders, {
            sourcePath,
            runtimeName: rt.name,
          });
          const rendered = elideClaudeOnlyCodeBlocks(tokenExpanded, rt);
          assertNoUnresolvedPlaceholders(rendered, sourcePath, rt.name);
          vocabularyFindings.push(
            ...lintRenderedSkill(rendered, sourcePath, rt),
          );
          writeFileSync(outSkillFile, rendered);
          written.add(resolve(outSkillFile));
          variantsWritten++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes(sourcePath)) {
            throw err;
          }
          throw new Error(`CALL macro error in ${sourcePath}: ${msg}`);
        }
      }

      if (existsSync(join(skillDir, 'references'))) {
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
          vocabularyFindings,
        );
        referencesCopied += written.size - before;
      }
    }
  }

  if (vocabularyFindings.length > 0) {
    throw new Error(formatVocabularyLintMessage(vocabularyFindings));
  }

  for (const [treeName, written] of writtenByRuntime) {
    const treeRoot = join(opts.outDir, treeName);
    if (!existsSync(treeRoot)) continue;
    cleanStaleFiles(treeRoot, written);
  }

  return { variantsWritten, referencesCopied, overridesUsed, warnings };
}

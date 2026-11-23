/**
 * Evaluates the combinator tree of the v3 enforcement DSL against a diff.
 *
 * The leaves use the `grep`, `structural` and `heuristic` kinds of `../review/check-catalog.ts`
 * and emit its `PluginFinding` type. A node passes when it produces zero findings. `all-of` passes
 * when all children pass, `any-of` when one or more children pass, and `not` when its child
 * fails. `scope` narrows the file glob and gates the subtree on a phase.
 *
 * The leaf switch has a `never` default, so a missing case is a compile error. The schema throws
 * `UnknownCheckKindError` for an unknown `kind` at parse time.
 */
import type { PluginFinding } from '../review/check-catalog.js';
import type { CheckLeaf, CheckNode, LeafKind } from './invariant-schema.js';
import { compileCheckGlob, compileCheckPattern, MatchBudget } from './check-pattern.js';

/**
 * The scope that `scope` nodes pass down a subtree. It holds no `phase`, because the `scope` node
 * itself checks its phase against the current phase.
 */
interface EvalScope {
  fileGlob?: string | undefined;
}

/** One file section of a diff. A section has no path when the diff has no file headers. */
interface DiffSection {
  path?: string | undefined;
  body: string;
}

/** The diff sections of one evaluation and the match budget that all of its leaves share. */
interface EvalContext {
  readonly sections: readonly DiffSection[];
  readonly budget: MatchBudget;
}

/** The compile-time exhaustiveness guard. */
function assertNever(value: never): never {
  throw new Error(`Unreachable: unexpected check kind ${String(value)}`);
}

/**
 * Splits a unified diff into per-file sections, each with the post-image path (`+++ b/<path>`). A
 * diff with no file headers gives one section with no path.
 *
 * A section starts at `diff --git`, or at a `--- ` header once the current section has a path. It
 * does not start at the `+++ b/` line, because then the header lines of a file go into the section
 * before it.
 */
function splitDiffByFile(diff: string): DiffSection[] {
  const lines = diff.split('\n');
  const sections: DiffSection[] = [];
  let current: DiffSection | undefined;

  const begin = (): void => {
    current = { path: undefined, body: '' };
    sections.push(current);
  };

  for (const line of lines) {
    if (
      line.startsWith('diff --git ') ||
      (line.startsWith('--- ') &&
        (current === undefined || current.path !== undefined))
    ) {
      begin();
    }
    const m = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m) {
      if (current === undefined) begin();
      current!.path = m[1];
    }
    if (current === undefined) begin();
    current!.body += `${line}\n`;
  }
  return sections;
}

/** Splits `diff` once for one evaluation. The split is a scan of the diff, so it asks `budget` for permission. */
function contextOf(diff: string, budget: MatchBudget): EvalContext {
  budget.permit(diff.length + 1);
  return { sections: splitDiffByFile(diff), budget };
}

/**
 * Returns the section bodies that `fileGlob` selects. A section without a path always contributes,
 * because the glob cannot apply to it.
 */
function sectionBodiesInScope(ctx: EvalContext, fileGlob: string | undefined): string[] {
  if (fileGlob === undefined) return ctx.sections.map((section) => section.body);
  const glob = compileCheckGlob(fileGlob, ctx.budget);
  return ctx.sections
    .filter((section) => section.path === undefined || glob.test(section.path, ctx.budget))
    .map((section) => section.body);
}

/**
 * True when the leaf is violated. A `grep` leaf stops at the first match. A `structural` or
 * `heuristic` leaf stops counting when the count is more than the threshold.
 */
function leafViolated(leaf: CheckLeaf, ctx: EvalContext, fileGlob: string | undefined): boolean {
  const pattern = compileCheckPattern(leaf.pattern, ctx.budget);
  const bodies = sectionBodiesInScope(ctx, fileGlob);
  const kind: LeafKind = leaf.kind;
  switch (kind) {
    case 'grep':
      return bodies.some((body) => pattern.test(body, ctx.budget));
    case 'structural':
    case 'heuristic': {
      const threshold = leaf.threshold ?? 0;
      const needed = threshold < 0 ? 0 : Math.floor(threshold) + 1;
      let count = 0;
      for (const body of bodies) {
        if (count >= needed) break;
        count += pattern.countUpTo(body, needed - count, ctx.budget);
      }
      return count >= needed;
    }
    default:
      return assertNever(kind);
  }
}

/** Build the single finding emitted by a violating leaf. */
function leafFinding(leaf: CheckLeaf, effectiveGlob?: string): PluginFinding {
  return {
    source: `enforcement:${leaf.kind}`,
    severity: 'MEDIUM',
    file: effectiveGlob,
    message: `Check '${leaf.kind}' violated for pattern /${leaf.pattern}/`,
  };
}

/**
 * Runs one leaf against a diff. A violation gives one finding, and a pass gives `[]`.
 *
 * - `grep`: one or more matches is a violation.
 * - `structural` and `heuristic`: a match count above the leaf `threshold` is a violation. The
 *   default threshold is 0.
 *
 * @param leaf   The leaf check, which the schema already validated.
 * @param diff   The unified diff to scan.
 * @param scope  The scope from an enclosing `scope` node. Its `fileGlob` applies when the leaf has
 *   no `fileGlob`.
 * @param budget The match budget. A search above the unit limit of one search, or a search after
 *   the deadline, throws `MatchBudgetExceededError`.
 */
export function evaluateLeaf(
  leaf: CheckLeaf,
  diff: string,
  scope: EvalScope = {},
  budget: MatchBudget = new MatchBudget(),
): PluginFinding[] {
  return evaluateLeafIn(leaf, contextOf(diff, budget), scope);
}

/** Runs one leaf against the sections of an evaluation. */
function evaluateLeafIn(leaf: CheckLeaf, ctx: EvalContext, scope: EvalScope): PluginFinding[] {
  const fileGlob = leaf.fileGlob ?? scope.fileGlob;
  return leafViolated(leaf, ctx, fileGlob) ? [leafFinding(leaf, fileGlob)] : [];
}

/** A node passes when it emits no findings. */
function nodePasses(
  node: CheckNode,
  ctx: EvalContext,
  scope: EvalScope,
  currentPhase: string | undefined,
): boolean {
  return evaluateTreeScoped(node, ctx, scope, currentPhase).length === 0;
}

/** True when the node is a leaf and not a combinator. */
function isLeaf(node: CheckNode): node is CheckLeaf {
  return 'kind' in node;
}

/**
 * Evaluates a node within a scope. The first passing child of an `any-of` node decides the node, and
 * the later children do not run. Thus the match budget of a later child cannot fail a node that
 * passed. An `any-of` node that fails returns the findings of every child.
 *
 * A `scope` node with a `phase` passes when the current phase is known and different. If the
 * current phase is not known, the subtree applies. A leaf `fileGlob` wins over the scope glob.
 */
function evaluateTreeScoped(
  node: CheckNode,
  ctx: EvalContext,
  scope: EvalScope,
  currentPhase: string | undefined,
): PluginFinding[] {
  if (isLeaf(node)) {
    return evaluateLeafIn(node, ctx, scope);
  }
  if ('all-of' in node) {
    return node['all-of'].flatMap((child) =>
      evaluateTreeScoped(child, ctx, scope, currentPhase),
    );
  }
  if ('any-of' in node) {
    const failures: PluginFinding[] = [];
    for (const child of node['any-of']) {
      const findings = evaluateTreeScoped(child, ctx, scope, currentPhase);
      if (findings.length === 0) return [];
      failures.push(...findings);
    }
    return failures;
  }
  if ('not' in node) {
    return nodePasses(node.not, ctx, scope, currentPhase)
      ? [
          {
            source: 'enforcement:not',
            severity: 'MEDIUM',
            message: 'Negated check passed when it was required to fail',
          },
        ]
      : [];
  }
  if ('scope' in node) {
    if (
      node.scope.phase !== undefined &&
      currentPhase !== undefined &&
      node.scope.phase !== currentPhase
    ) {
      return [];
    }
    const narrowed: EvalScope = {
      fileGlob: node.scope.fileGlob ?? scope.fileGlob,
    };
    return evaluateTreeScoped(node.node, ctx, narrowed, currentPhase);
  }
  return assertNever(node as never);
}

/**
 * Evaluates a combinator tree against a diff and returns all findings. An empty array means that
 * the whole tree passed.
 *
 * @param currentPhase  The SDLC phase of the evaluation. A `scope` node with a different `phase`
 *   passes. If the phase is absent, every subtree applies.
 * @param budget        The match budget. A gate passes one budget to each tree of a run, so the
 *   whole run has one deadline. A search past a limit throws `MatchBudgetExceededError`.
 */
export function evaluateTree(
  node: CheckNode,
  diff: string,
  currentPhase?: string,
  budget: MatchBudget = new MatchBudget(),
): PluginFinding[] {
  return evaluateTreeScoped(node, contextOf(diff, budget), {}, currentPhase);
}

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
import { globToRegExp } from './glob-to-regexp.js';

/**
 * The scope that `scope` nodes pass down a subtree. It holds no `phase`, because the `scope` node
 * itself checks its phase against the current phase.
 */
interface EvalScope {
  fileGlob?: string | undefined;
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
function splitDiffByFile(diff: string): Array<{ path?: string | undefined; body: string }> {
  const lines = diff.split('\n');
  const sections: Array<{ path?: string | undefined; body: string }> = [];
  let current: { path?: string | undefined; body: string } | undefined;

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

/**
 * Count regex matches of `pattern` across the diff, honoring an optional
 * fileGlob: when set, only sections whose path matches the glob contribute.
 * Sections without a path (header-less diff) always contribute — the glob
 * cannot be evaluated, so it is treated as non-restricting.
 */
function countMatches(pattern: string, diff: string, fileGlob?: string): number {
  const re = new RegExp(pattern, 'g');
  const sections = splitDiffByFile(diff);
  let count = 0;
  for (const section of sections) {
    if (
      fileGlob !== undefined &&
      section.path !== undefined &&
      !globToRegExp(fileGlob).test(section.path)
    ) {
      continue;
    }
    const matches = section.body.match(re);
    count += matches ? matches.length : 0;
  }
  return count;
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
 * @param leaf  The leaf check, which the schema already validated.
 * @param diff  The unified diff to scan.
 * @param scope The scope from an enclosing `scope` node. Its `fileGlob` applies when the leaf has
 *   no `fileGlob`.
 */
export function evaluateLeaf(
  leaf: CheckLeaf,
  diff: string,
  scope: EvalScope = {},
): PluginFinding[] {
  const fileGlob = leaf.fileGlob ?? scope.fileGlob;
  const kind: LeafKind = leaf.kind;
  switch (kind) {
    case 'grep': {
      const count = countMatches(leaf.pattern, diff, fileGlob);
      return count > 0 ? [leafFinding(leaf, fileGlob)] : [];
    }
    case 'structural':
    case 'heuristic': {
      const threshold = leaf.threshold ?? 0;
      const count = countMatches(leaf.pattern, diff, fileGlob);
      return count > threshold ? [leafFinding(leaf, fileGlob)] : [];
    }
    default:
      return assertNever(kind);
  }
}

/** A node passes when it emits no findings. */
function nodePasses(
  node: CheckNode,
  diff: string,
  scope: EvalScope,
  currentPhase: string | undefined,
): boolean {
  return evaluateTreeScoped(node, diff, scope, currentPhase).length === 0;
}

/** True when the node is a leaf and not a combinator. */
function isLeaf(node: CheckNode): node is CheckLeaf {
  return 'kind' in node;
}

/**
 * Evaluates a node within a scope. An `any-of` node that fails returns the findings of every child.
 * A `scope` node with a `phase` passes when the current phase is known and different. If the
 * current phase is not known, the subtree applies. A leaf `fileGlob` wins over the scope glob.
 */
function evaluateTreeScoped(
  node: CheckNode,
  diff: string,
  scope: EvalScope,
  currentPhase: string | undefined,
): PluginFinding[] {
  if (isLeaf(node)) {
    return evaluateLeaf(node, diff, scope);
  }
  if ('all-of' in node) {
    return node['all-of'].flatMap((child) =>
      evaluateTreeScoped(child, diff, scope, currentPhase),
    );
  }
  if ('any-of' in node) {
    const childResults = node['any-of'].map((child) =>
      evaluateTreeScoped(child, diff, scope, currentPhase),
    );
    const anyPass = childResults.some((findings) => findings.length === 0);
    return anyPass ? [] : childResults.flat();
  }
  if ('not' in node) {
    return nodePasses(node.not, diff, scope, currentPhase)
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
    return evaluateTreeScoped(node.node, diff, narrowed, currentPhase);
  }
  return assertNever(node as never);
}

/**
 * Evaluates a combinator tree against a diff and returns all findings. An empty array means that
 * the whole tree passed.
 *
 * @param currentPhase  The SDLC phase of the evaluation. A `scope` node with a different `phase`
 *   passes. If the phase is absent, every subtree applies.
 */
export function evaluateTree(
  node: CheckNode,
  diff: string,
  currentPhase?: string,
): PluginFinding[] {
  return evaluateTreeScoped(node, diff, {}, currentPhase);
}

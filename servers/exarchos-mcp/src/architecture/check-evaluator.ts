/**
 * Combinator-tree evaluator for the v3 enforcement DSL (DR-2, DR-9).
 *
 * Leaf execution reuses the `grep | structural | heuristic` vocabulary from
 * `../review/check-catalog.ts` and emits `PluginFinding`s from that module —
 * the DSL composes those leaves, it does not invent new execution semantics.
 *
 * A node "passes" when it produces zero findings. The combinators implement
 * boolean algebra over that pass/fail predicate:
 *   - all-of → conjunction (all children must pass)
 *   - any-of → disjunction (at least one child must pass)
 *   - not    → negation
 *   - scope  → narrows the effective fileGlob/phase for the subtree
 *
 * Fail-closed (DR-9): the leaf switch is exhaustive with a `never` default, so
 * a missing case is a compile error; an invalid `kind` cannot reach here
 * because the schema throws `UnknownCheckKindError` at parse/load time.
 */
import type { PluginFinding } from '../review/check-catalog.js';
import type { CheckLeaf, CheckNode, LeafKind } from './invariant-schema.js';
import { globToRegExp } from './glob-to-regexp.js';

/**
 * Effective scope threaded down a subtree by `scope` nodes.
 *
 * `phase` is NOT carried here: a `scope` node's `phase` is a gate condition
 * (compared against the evaluation's current phase), not a property the inner
 * leaves consume. It is enforced at the `scope` node itself — see
 * `evaluateTreeScoped`.
 */
interface EvalScope {
  fileGlob?: string;
}

/** Compile-time exhaustiveness guard (DR-9 total function). */
function assertNever(value: never): never {
  throw new Error(`Unreachable: unexpected check kind ${String(value)}`);
}

/**
 * Split a unified diff into per-file sections keyed by the post-image path
 * (`+++ b/<path>`). A diff with no file headers yields a single section with
 * an undefined path (glob filtering is skipped for it).
 *
 * The section boundary is the file header (`diff --git a/…` for git diffs, or
 * the `--- ` old-file header for plain unified diffs) — NOT the `+++ b/…` line.
 * Anchoring on the post-image line would push a file's own leading headers
 * (`diff --git`, `index`, `--- a/<path>`) into the PREVIOUS file's section,
 * which can misattribute a pattern match to the wrong file's glob.
 */
function splitDiffByFile(diff: string): Array<{ path?: string; body: string }> {
  const lines = diff.split('\n');
  const sections: Array<{ path?: string; body: string }> = [];
  let current: { path?: string; body: string } | undefined;

  const begin = (): void => {
    current = { path: undefined, body: '' };
    sections.push(current);
  };

  for (const line of lines) {
    // Start a new section at the file boundary so this file's header lines
    // stay with it. `diff --git` is the git boundary; for plain diffs that
    // omit it, the `--- ` old-file header opens the next file — but only once
    // the current section already carries its `+++` path (otherwise the `--- `
    // belongs to a section just opened by `diff --git`).
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
 * Execute a single leaf against a diff, delegating to check-catalog
 * leaf-execution semantics:
 *   - grep: any match over the diff is a violation (one finding).
 *   - structural / heuristic: a violation when match count exceeds the
 *     leaf's threshold (default 0 ⇒ any match violates).
 * A pass produces `[]`.
 *
 * @param leaf  The leaf check (already schema-validated — kind is a LeafKind).
 * @param diff  Unified-diff text to scan.
 * @param scope Optional narrowed scope from an enclosing `scope` node; its
 *   fileGlob takes effect when the leaf does not declare its own.
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

/** Type guard: leaf vs combinator. */
function isLeaf(node: CheckNode): node is CheckLeaf {
  return 'kind' in node;
}

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
    // Conjunction: a failing child contributes its findings.
    return node['all-of'].flatMap((child) =>
      evaluateTreeScoped(child, diff, scope, currentPhase),
    );
  }
  if ('any-of' in node) {
    // Disjunction: passes (no findings) if ANY child passes; otherwise emits
    // every child's findings so the caller sees why all branches failed.
    const childResults = node['any-of'].map((child) =>
      evaluateTreeScoped(child, diff, scope, currentPhase),
    );
    const anyPass = childResults.some((findings) => findings.length === 0);
    return anyPass ? [] : childResults.flat();
  }
  if ('not' in node) {
    // Negation: a passing child becomes one finding; a failing child passes.
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
    // Phase gate: a `scope.phase` declares "this subtree only applies during
    // phase X". When the caller supplies the current phase and it does not
    // match, the subtree is out of scope and therefore passes (no findings).
    // When the caller omits the phase (currentPhase === undefined) the gate is
    // not evaluable, so the subtree applies unconditionally — preserving the
    // pre-enforcement behavior for phase-agnostic callers.
    if (
      node.scope.phase !== undefined &&
      currentPhase !== undefined &&
      node.scope.phase !== currentPhase
    ) {
      return [];
    }
    // Narrow fileGlob for the subtree; an inner leaf declaration still wins
    // over the narrowed scope (leaf.fileGlob ?? scope.fileGlob).
    const narrowed: EvalScope = {
      fileGlob: node.scope.fileGlob ?? scope.fileGlob,
    };
    return evaluateTreeScoped(node.node, diff, narrowed, currentPhase);
  }
  // Unreachable: schema validation guarantees one of the arms above.
  return assertNever(node as never);
}

/**
 * Evaluate a combinator tree against a diff, returning the aggregated
 * findings. An empty array means the whole tree passed.
 *
 * @param currentPhase  The SDLC phase the evaluation runs in. When supplied, a
 *   `scope` node whose `phase` does not match is treated as out of scope (its
 *   subtree passes). When omitted, phase scoping is inert (every subtree
 *   applies) — the gate handler always supplies it.
 */
export function evaluateTree(
  node: CheckNode,
  diff: string,
  currentPhase?: string,
): PluginFinding[] {
  return evaluateTreeScoped(node, diff, {}, currentPhase);
}

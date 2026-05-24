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

/** Effective scope threaded down a subtree by `scope` nodes. */
interface EvalScope {
  fileGlob?: string;
  phase?: string;
}

/** Compile-time exhaustiveness guard (DR-9 total function). */
function assertNever(value: never): never {
  throw new Error(`Unreachable: unexpected check kind ${String(value)}`);
}

/**
 * Convert a fileGlob (e.g. `*.ts`, `servers/**`) to a RegExp. Supports `*`
 * (any run of non-separator chars), `**` (any run incl. separators), and
 * literal path segments. Anchored to the whole path.
 */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if ('.+?^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Split a unified diff into per-file sections keyed by the post-image path
 * (`+++ b/<path>`). A diff with no file headers yields a single section with
 * an undefined path (glob filtering is skipped for it).
 */
function splitDiffByFile(diff: string): Array<{ path?: string; body: string }> {
  const lines = diff.split('\n');
  const sections: Array<{ path?: string; body: string }> = [];
  let current: { path?: string; body: string } | undefined;
  for (const line of lines) {
    const m = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m) {
      current = { path: m[1], body: '' };
      sections.push(current);
      continue;
    }
    if (!current) {
      current = { path: undefined, body: '' };
      sections.push(current);
    }
    current.body += `${line}\n`;
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
function nodePasses(node: CheckNode, diff: string, scope: EvalScope): boolean {
  return evaluateTreeScoped(node, diff, scope).length === 0;
}

/** Type guard: leaf vs combinator. */
function isLeaf(node: CheckNode): node is CheckLeaf {
  return 'kind' in node;
}

function evaluateTreeScoped(
  node: CheckNode,
  diff: string,
  scope: EvalScope,
): PluginFinding[] {
  if (isLeaf(node)) {
    return evaluateLeaf(node, diff, scope);
  }
  if ('all-of' in node) {
    // Conjunction: a failing child contributes its findings.
    return node['all-of'].flatMap((child) =>
      evaluateTreeScoped(child, diff, scope),
    );
  }
  if ('any-of' in node) {
    // Disjunction: passes (no findings) if ANY child passes; otherwise emits
    // every child's findings so the caller sees why all branches failed.
    const childResults = node['any-of'].map((child) =>
      evaluateTreeScoped(child, diff, scope),
    );
    const anyPass = childResults.some((findings) => findings.length === 0);
    return anyPass ? [] : childResults.flat();
  }
  if ('not' in node) {
    // Negation: a passing child becomes one finding; a failing child passes.
    return nodePasses(node.not, diff, scope)
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
    // Narrow fileGlob/phase for the subtree; inner declarations win over the
    // narrowed scope only at the leaf level (leaf.fileGlob ?? scope.fileGlob).
    const narrowed: EvalScope = {
      fileGlob: node.scope.fileGlob ?? scope.fileGlob,
      phase: node.scope.phase ?? scope.phase,
    };
    return evaluateTreeScoped(node.node, diff, narrowed);
  }
  // Unreachable: schema validation guarantees one of the arms above.
  return assertNever(node as never);
}

/**
 * Evaluate a combinator tree against a diff, returning the aggregated
 * findings. An empty array means the whole tree passed.
 */
export function evaluateTree(node: CheckNode, diff: string): PluginFinding[] {
  return evaluateTreeScoped(node, diff, {});
}

// servers/exarchos-mcp/scripts/cli-derivation-guard.ts
//
// DR-5 / G1 — the source-level CLI derivation guard.
//
// POLICY
// ──────
// The CLI composition root contains NO literal `.command('<name>')` call. Every
// command is registered through a derivation helper — `registerActionCommand`,
// the composite-tool loop, or the harness loop — that takes its name from a
// registry declaration. The policy is DATA (`GOVERNED_SOURCES` below, plus the
// allowlist file), not prose in a test body, so the governed surface and the
// tolerated exceptions are both reviewable artifacts.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS GUARD IS SOURCE-LEVEL, AND WHY THE OBVIOUS FORMULATION FAILED
//
// An earlier revision specified G1 as "every command traces to a registry
// declaration", checked by walking the Commander tree built by `buildCli`.
// That policy PASSED ITS OWN KILL FIXTURE, for two independent reasons:
//
//   1. The hand-written `doctor`, `onboard` and `merge-orchestrate` commands all
//      call `addFlagsFromSchema(cmd, action.schema, …)` against the registry
//      action they promote. They genuinely DO trace to a registry declaration.
//      The predicate was true of exactly the code it was written to reject.
//   2. A built Commander tree records no provenance. `program.command('doctor')`
//      and `program.command(cliName)` produce byte-identical nodes, so a
//      tree-walk cannot observe hand-written-versus-derived AT ALL.
//
// It would have shipped green with its real subject surviving — the exact defect
// it existed to remove. The discriminating fact is visible only in the SOURCE
// (a string literal versus an identifier) and is erased by the time a tree
// exists. Hence: parse the composition root, classify each `.command(` argument.
//
// A second, practical consequence: this guard never resolves `buildCli`, so it
// carries no `bun:sqlite` dependency and needs neither Bun nor Vitest's alias
// shim. It runs under plain `node`/`tsx`. See `docs/guides/ci-gate-hosting.md`
// for the host-class decision — this is a "deps tail" gate (it needs
// `typescript` resolvable), NOT a zero-dep-prefix gate.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE TYPESCRIPT PARSER AND NOT A REGEX
//
// This program has been bitten four times by guards that measured source TEXT
// instead of the structural fact: `cli-vocab-guard` measured vocabulary rather
// than derivation; the DR-14 cast census counted the English word "as" in
// comments; DR-27's scanner counted substrings. A regex here would join that
// list on day one, and the failure is already demonstrable: a naive
// `/\.command\(/` over `adapters/cli.ts` reports 15 sites, not 14, because a
// JSDoc block at `cli.ts:55` writes `program.command(...)` in PROSE.
//
// Comments are not "blanked" by a stripping pass here — a hand-rolled stripper
// means re-deriving TypeScript's lexical grammar (template-substitution
// nesting, the regex-literal-versus-division ambiguity, escapes, apostrophes),
// which is how the original defect class arrives. Instead comments are blanked
// STRUCTURALLY: the parser classifies them as trivia, so they never become
// `CallExpression` nodes and the walk below cannot see them. `ts.isCallExpression`
// cannot disagree with the compiler about what a call is.
//
// `scripts/tsconfig-strictness/count-casts.ts` was converted from a regex to the
// parser for exactly this reason; this module follows its idiom, including the
// fail-closed treatment of a recovered parse.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS LIVES IN `scripts/` AND NOT IN `src/architecture/`
//
// It was first written as `src/architecture/cli-derivation-seam.ts`, on the
// reasoning that `*-seam.ts` is an established convention there for
// "test-invoked source-lint gate run against production SOURCE" and would be
// covered by the DR-7 module-intent allowlist class of the same name. Two
// ownership censuses rejected that placement, correctly:
//
//   - `effect-ledger` (P04-01) flagged an INDETERMINATE owner: this module
//     reads files off disk, and `src/**` is SHIPPED source where every
//     filesystem effect must have a declared owner.
//   - `effect-ledger`'s bare-import allowlist flagged `typescript` itself.
//     That is the load-bearing objection: `typescript` is a devDependency, so
//     importing the compiler into `src/**` would make it a RUNTIME dependency
//     of the shipped server and pull it into the compiled binary.
//
// A gate that parses the tree is build/gate tooling, not shipped source. In
// `scripts/` it sits beside `cli-vocab-guard.ts` — the guard whose defect this
// one corrects, governing the same file — where a devDependency import is
// correct and where the module is not a production module at all, so DR-7's
// dead-in-prod question does not arise. Note the sibling is in `scripts/` for a
// different reason (it MUST be `bun run`, because resolving `buildCli` drags in
// `bun:sqlite`); this guard has no such constraint and runs under plain node.
//
// One honest consequence: the DR-30 `@oracle-sources` corpus covers
// `repo/src`, `mcp/src`, `mcp/test` and `mcp/tests` — not `mcp/scripts`. The
// co-located test still declares its two authorities, but nothing currently
// enforces that declaration at this path.

import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Repository root — `<repo>/servers/exarchos-mcp/scripts` → `<repo>`. */
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

// ─── Policy, as data ─────────────────────────────────────────────────────────

/**
 * The governed composition roots, repo-relative and forward-slashed.
 *
 * A list rather than a single constant so that a future composition root (a
 * second adapter, a split of `cli.ts`) is added here as DATA instead of being
 * silently ungoverned. Every entry must exist and must parse; a path that
 * resolves to nothing fails the scan rather than contributing zero sites (see
 * {@link scanGovernedSources}).
 */
export const GOVERNED_SOURCES: readonly string[] = Object.freeze([
  'servers/exarchos-mcp/src/adapters/cli.ts',
]);

/** Repo-relative location of the allowlist data file. */
export const ALLOWLIST_PATH = 'servers/exarchos-mcp/scripts/cli-derivation-allowlist.json';

/**
 * The KILL FIXTURE: command names that may never be allowlisted.
 *
 * `merge-orchestrate` is the guard's live failing subject. It is declared
 * TWICE — once as a registry action (`merge_orchestrate`, carrying
 * `posture: 'shared-mutating'`) and once by hand as `.command('merge-orchestrate')`
 * in the composition root. That duplication is precisely the finding DR-5
 * exists to remove; the registry declaration is the survivor.
 *
 * This constant exists because an earlier revision of the policy put
 * `merge-orchestrate` ON the allowlist. That single line neutralized the very
 * rejection DR-5 requires: the guard kept its kill fixture in the file, kept
 * reporting a number, and no longer rejected the one command whose rejection
 * was the point. A guard with no currently-failing subject has not been shown
 * to work — it has only been shown to run.
 *
 * So the exclusion is a MECHANISM, not a convention:
 *
 *   - {@link findDerivationViolations} never suppresses these names, whatever
 *     the allowlist says — the rejection cannot be switched off from data.
 *   - {@link readAllowlist} REFUSES a policy file that lists one, so the
 *     mistake is rejected loudly at authoring time instead of being silently
 *     ignored and read as consent.
 *
 * The remedy for a kill-fixture name is to DELETE the hand-written command
 * (DR-5's remediation), never to exempt it.
 */
export const KILL_FIXTURE_COMMANDS: readonly string[] = Object.freeze(['merge-orchestrate']);

/** Is `name` a kill-fixture command — one that can never be exempted? */
export function isKillFixture(name: string): boolean {
  return KILL_FIXTURE_COMMANDS.includes(name);
}

// ─── Scan results ────────────────────────────────────────────────────────────

/**
 * How a `.command(…)` site names its command.
 *
 * - `literal`  — a string literal or no-substitution template. The name is
 *   BAKED into the composition root; nothing ties it to a registry declaration.
 * - `derived`  — any other expression (identifier, property access, template
 *   with substitutions). The name is computed, so it comes from wherever that
 *   expression reads — the registry, by construction of the helpers.
 * - `indeterminate` — a `.command()` call with no first argument. The guard
 *   cannot prove derivation, so it fails closed rather than assuming the best.
 */
export type CommandSiteKind = 'literal' | 'derived' | 'indeterminate';

export interface CommandSite {
  /** Repo-relative, forward-slashed path of the file containing the site. */
  readonly file: string;
  /** 1-based line number of the `.command` call. */
  readonly line: number;
  /** 1-based column of the `.command` call. */
  readonly column: number;
  readonly kind: CommandSiteKind;
  /**
   * For a `literal` site, the command NAME — the first whitespace-delimited
   * token of the literal, so `'feedback <message>'` yields `feedback`.
   * Empty for non-literal sites.
   */
  readonly name: string;
  /** The argument's source text, for the failure message. */
  readonly expression: string;
}

export interface DerivationScan {
  /** Every `.command(` call site found, in source order. */
  readonly sites: readonly CommandSite[];
  /** Sites whose name is baked as a literal — the population under policy. */
  readonly literals: readonly CommandSite[];
  /** Sites whose name is computed. */
  readonly derived: readonly CommandSite[];
  /** Sites the guard could not classify. Non-empty is a fail-closed condition. */
  readonly indeterminate: readonly CommandSite[];
}

// ─── Fail-closed parsing ─────────────────────────────────────────────────────

/**
 * Read `parseDiagnostics` without a type assertion.
 *
 * `parseDiagnostics` is not on the public `ts.SourceFile` surface, but it is the
 * only way to tell a CLEAN parse from a RECOVERED one: `createSourceFile` never
 * throws — handed broken input it returns a partial tree with nodes silently
 * missing, which would UNDER-report `.command(` sites and read as a clean run.
 *
 * `Reflect.get` into a local `unknown` keeps this honest under the wave's cast
 * budget (`as const` counts, so does `as X`): the value is narrowed by real
 * runtime checks rather than asserted.
 */
function readParseErrors(sourceFile: ts.SourceFile): { readonly count: number; readonly detail: string } {
  const raw: unknown = Reflect.get(sourceFile, 'parseDiagnostics');
  if (!Array.isArray(raw) || raw.length === 0) return { count: 0, detail: '' };
  const first: unknown = raw[0];
  const messageText: unknown =
    typeof first === 'object' && first !== null ? Reflect.get(first, 'messageText') : undefined;
  return {
    count: raw.length,
    detail: typeof messageText === 'string' ? messageText : '(non-string diagnostic message)',
  };
}

/**
 * Parse `source`, refusing a RECOVERED parse.
 *
 * Exported so a second source-level measurement does not have to re-derive
 * fail-closed parse semantics (task 026's live authority proof reuses it). The
 * `label` prefixes the failure so the message still names the caller; it
 * defaults to this guard, so the existing behaviour and message are unchanged.
 */
export function parseOrThrow(
  source: string,
  fileName: string,
  label: string = 'cli-derivation-guard',
): ts.SourceFile {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );
  const errors = readParseErrors(sourceFile);
  if (errors.count > 0) {
    throw new Error(
      `${label}: ${fileName} did not parse cleanly (${errors.count} syntax ` +
        `error(s); first: ${errors.detail}). Refusing to report a result derived from a ` +
        'recovered parse, which would silently under-report literal command sites.',
    );
  }
  return sourceFile;
}

// ─── Site extraction ─────────────────────────────────────────────────────────

/** Is this call expression a `<something>.command(…)` invocation? */
function isCommandCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  // `x.command(…)` and `x?.command(…)`.
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === 'command';
  // `x['command'](…)` — an evasion route around the property-access form.
  if (ts.isElementAccessExpression(callee)) {
    const arg = callee.argumentExpression;
    return ts.isStringLiteralLike(arg) && arg.text === 'command';
  }
  return false;
}

function classify(arg: ts.Expression | undefined): CommandSiteKind {
  if (arg === undefined) return 'indeterminate';
  return ts.isStringLiteralLike(arg) ? 'literal' : 'derived';
}

/**
 * Parse `source` and return every `.command(` site with its classification.
 *
 * Pure over a source string — the self-tests drive it directly with seeded
 * input, so none of them needs to mutate a file on disk.
 *
 * THROWS on a source that yields ZERO `.command(` sites. This is the non-empty
 * denominator, and it lives HERE rather than in {@link scanGovernedSources}
 * because a tooth installed only in the outer function is bypassed by every
 * direct caller of the pure one: an empty string parses cleanly, returns zero
 * sites, produces zero violations, and reads as a clean run — which is exactly
 * the "moved or renamed composition root silently stops being governed" failure
 * the tooth exists to make impossible. Task 021 reported it as half-installed;
 * task 022 pushed it down. The check is therefore unconditional and has no
 * opt-out parameter: an escape hatch would restore the hole for whoever passed
 * it.
 */
export function scanSourceForCommandSites(source: string, file: string): DerivationScan {
  const sourceFile = parseOrThrow(source, file);
  const sites: CommandSite[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isCommandCall(node)) {
      const arg = node.arguments[0];
      const kind = classify(arg);
      const pos = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile));
      const name = arg !== undefined && ts.isStringLiteralLike(arg) ? firstToken(arg.text) : '';
      sites.push({
        file,
        line: pos.line + 1,
        column: pos.character + 1,
        kind,
        name,
        expression: arg === undefined ? '<no argument>' : arg.getText(sourceFile),
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  if (sites.length === 0) {
    throw new Error(
      `cli-derivation-guard: "${file}" yielded 0 \`.command(\` sites. A source that ` +
        'registers no commands is not a composition root — this is a broken scan (renamed ' +
        'file, changed registration idiom, wrong path), not a clean run. The non-empty ' +
        'denominator is enforced in the pure scanner so no caller can route around it.',
    );
  }

  return {
    sites,
    literals: sites.filter((s) => s.kind === 'literal'),
    derived: sites.filter((s) => s.kind === 'derived'),
    indeterminate: sites.filter((s) => s.kind === 'indeterminate'),
  };
}

/** `'feedback <message>'` → `feedback`; `'doctor'` → `doctor`. */
function firstToken(literal: string): string {
  return literal.trim().split(/\s+/)[0] ?? '';
}

/**
 * Scan every governed source under `repoRoot`.
 *
 * Throws — rather than returning an empty scan — when the source list is empty,
 * a governed file is missing, or a governed file yields ZERO `.command(` sites.
 * A guard that parses nothing reports no violations and passes clean, so a
 * moved or renamed composition root would read as "policy satisfied". The
 * non-empty denominator is the tooth that makes that impossible.
 *
 * The zero-site arm of that tooth is NOT re-implemented here: it lives in
 * {@link scanSourceForCommandSites}, which this function calls per file, so the
 * error surfaces exactly ONCE and names the offending file. A defensive second
 * copy here would be unreachable (dead policy that cannot be shown to work) and,
 * if it ever did fire, would report the same fact twice with two wordings.
 */
export function scanGovernedSources(
  repoRoot: string = REPO_ROOT,
  sources: readonly string[] = GOVERNED_SOURCES,
): DerivationScan {
  if (sources.length === 0) {
    throw new Error(
      'cli-derivation-guard: no governed sources declared. An empty scan finds zero ' +
        'literal command sites and passes the policy clean, so it is rejected rather ' +
        'than trusted.',
    );
  }

  const all: CommandSite[] = [];
  for (const rel of sources) {
    const abs = path.join(repoRoot, rel);
    if (!existsSync(abs)) {
      throw new Error(
        `cli-derivation-guard: governed source "${rel}" does not exist at ${abs}. The CLI ` +
          'composition root was moved or renamed; update GOVERNED_SOURCES. Refusing to ' +
          'report a clean scan over a file that is not there.',
      );
    }
    // `scanSourceForCommandSites` owns the zero-site refusal (see its doc
    // comment) and names `rel` in the message, so nothing is added by checking
    // again here.
    const scan = scanSourceForCommandSites(readFileSync(abs, 'utf8'), rel);
    all.push(...scan.sites);
  }

  return {
    sites: all,
    literals: all.filter((s) => s.kind === 'literal'),
    derived: all.filter((s) => s.kind === 'derived'),
    indeterminate: all.filter((s) => s.kind === 'indeterminate'),
  };
}

// ─── Policy-data file references ─────────────────────────────────────────────
//
// Task 021 found that this policy file's `$comment` pointed at
// `cli-derivation-seam.ts` — a module that had been RENAMED to
// `cli-derivation-guard.ts` and no longer existed. Correcting that one string
// would leave the class open: `$comment` is the text a future author reads to
// decide whether their entry is legitimate, and nothing checked that what it
// named was real. So the reference is BOUND instead — every file a policy file
// names must resolve on disk, or the guard refuses to read the policy at all.
//
// This is not "measuring text instead of structure" (the failure mode this
// program keeps hitting). The text IS the artifact under policy here: a token
// like `servers/.../cli-derivation-guard.ts` is a claim that a file exists, and
// the check verifies exactly that claim. Nothing is inferred about meaning.

/**
 * Extensions that make a token inside policy prose a FILE REFERENCE.
 *
 * Data rather than a baked alternation so a policy file that starts pointing at
 * a workflow YAML or a design doc is covered by the same binding, without the
 * class being reopened one extension at a time.
 */
export const REFERENCED_EXTENSIONS: readonly string[] = Object.freeze([
  'ts',
  'mts',
  'cts',
  'js',
  'mjs',
  'json',
  'md',
  'yml',
  'yaml',
]);

const FILE_REFERENCE_PATTERN = new RegExp(
  `[A-Za-z0-9_@.\\-/]+\\.(?:${REFERENCED_EXTENSIONS.join('|')})\\b`,
  'g',
);

/** Every file reference the policy prose makes, in order of appearance. */
export function extractPolicyFileReferences(commentText: string): readonly string[] {
  return commentText.match(FILE_REFERENCE_PATTERN) ?? [];
}

export interface PolicyReferenceProblem {
  /** The offending token, or `'(none)'` for the empty-denominator case. */
  readonly reference: string;
  readonly detail: string;
}

/**
 * Check every file reference in `commentText` against the tree at `repoRoot`.
 *
 * Two ways to fail:
 *
 *  - **Unverifiable.** A bare basename (`cli-derivation-guard.ts`) names no
 *    single place on disk, so it cannot be checked and cannot be followed by a
 *    reader either. Repo-relative paths are required.
 *  - **Stale.** A repo-relative path that does not exist — the shipped defect.
 *
 * Plus the **non-empty denominator**: prose that names NO file at all is
 * reported too. A policy file whose comment points nowhere gives its reader
 * nothing to follow, and — the load-bearing reason — it is indistinguishable
 * from a broken extractor. Without this arm, a regression in
 * {@link extractPolicyFileReferences} would silently check zero references and
 * report a clean run, which is the same defect one level up.
 */
export function findPolicyReferenceProblems(
  commentText: string,
  repoRoot: string = REPO_ROOT,
): readonly PolicyReferenceProblem[] {
  const references = extractPolicyFileReferences(commentText);
  if (references.length === 0) {
    return [
      {
        reference: '(none)',
        detail:
          'the policy prose names no file at all. It must point at the module that ' +
          'implements the policy, as a repo-relative path, so a reader can follow it and ' +
          'so a rename cannot go unnoticed. Zero references is also what a broken ' +
          'reference extractor looks like, and that must not read as a clean run.',
      },
    ];
  }

  const problems: PolicyReferenceProblem[] = [];
  for (const reference of references) {
    if (!reference.includes('/')) {
      problems.push({
        reference,
        detail:
          'is a bare filename. Write the repo-relative path (e.g. ' +
          '`servers/exarchos-mcp/scripts/<file>`) so the reference can be verified against ' +
          'the tree and followed by a reader.',
      });
      continue;
    }
    if (!existsSync(path.join(repoRoot, reference))) {
      problems.push({
        reference,
        detail:
          'does not exist. A policy file that names a module which is not there sends the ' +
          'next author looking for a file that was renamed or deleted — update the ' +
          'reference, or drop it.',
      });
    }
  }
  return problems;
}

/** Normalize a `$comment` that may be a string or an array of lines. */
function readCommentText(parsed: unknown): string {
  const raw: unknown =
    typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, '$comment') : undefined;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    const lines: string[] = [];
    for (const line of raw) if (typeof line === 'string') lines.push(line);
    return lines.join('\n');
  }
  return '';
}

// ─── Allowlist ───────────────────────────────────────────────────────────────

/**
 * Names tolerated as literals, read from {@link ALLOWLIST_PATH}.
 *
 * The file exists and is READ from day one so the policy seam is real, but it
 * ships EMPTY: on introduction this guard reports all 11 hand-written literals
 * rather than blessing them. Populating it — and making it shrink-only, so an
 * entry can leave but never arrive — is a separate deliverable and is
 * deliberately NOT implemented here.
 *
 * Fails closed on a missing or malformed file: a guard that silently treats an
 * unreadable allowlist as "allow nothing" would be fine, but one that treats it
 * as "allow everything" would not, and an unreadable policy file is a broken
 * gate either way. It also fails closed on a policy file whose `$comment` names
 * a file that does not exist — see {@link findPolicyReferenceProblems}.
 */
export function readAllowlist(repoRoot: string = REPO_ROOT): ReadonlySet<string> {
  const abs = path.join(repoRoot, ALLOWLIST_PATH);
  if (!existsSync(abs)) {
    throw new Error(
      `cli-derivation-guard: allowlist file missing at ${abs}. The policy data is part of ` +
        'the guard; a missing allowlist is a broken gate, not an empty one.',
    );
  }
  const parsed: unknown = JSON.parse(readFileSync(abs, 'utf8'));
  const allowed: unknown =
    typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'allowed') : undefined;
  if (!Array.isArray(allowed) || !allowed.every((v) => typeof v === 'string')) {
    throw new Error(
      `cli-derivation-guard: allowlist at ${ALLOWLIST_PATH} must have an "allowed" array of ` +
        'strings. Refusing to run against a policy file whose shape it cannot verify.',
    );
  }
  const names: string[] = [];
  for (const v of allowed) if (typeof v === 'string') names.push(v);

  // The kill fixture is not exemptible. Refusing the FILE (rather than quietly
  // dropping the entry) is deliberate: a silently-ignored allowlist line reads
  // to its author as granted, and the whole failure mode being guarded against
  // here is an exemption that nobody noticed was load-bearing.
  const exempted = names.filter(isKillFixture);
  if (exempted.length > 0) {
    throw new Error(
      `cli-derivation-guard: ${ALLOWLIST_PATH} allowlists the kill fixture ` +
        `${exempted.map((n) => `"${n}"`).join(', ')}. These names are the guard's live failing ` +
        'subject and must remain rejected — an earlier revision exempted `merge-orchestrate` ' +
        'and thereby neutralized the rejection DR-5 requires. The remedy is to DELETE the ' +
        'hand-written `.command(...)` call from the composition root and let the registry ' +
        'declaration be the single definition, never to add it here.',
    );
  }

  // Every file the policy prose names must exist. Checked AFTER the kill-fixture
  // rejection deliberately: a stale doc pointer must never be the error that
  // surfaces in place of DR-5's load-bearing refusal.
  const referenceProblems = findPolicyReferenceProblems(readCommentText(parsed), repoRoot);
  if (referenceProblems.length > 0) {
    throw new Error(
      `cli-derivation-guard: ${ALLOWLIST_PATH} has ${referenceProblems.length} broken file ` +
        `reference(s) in its "$comment": ` +
        referenceProblems.map((p) => `"${p.reference}" ${p.detail}`).join(' ') +
        ' The comment is what a future author reads to decide whether their entry is ' +
        'legitimate, so a pointer that does not resolve is a broken policy file, not a typo.',
    );
  }

  return new Set(names);
}

// ─── Violations ──────────────────────────────────────────────────────────────

export interface DerivationViolation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly kind: CommandSiteKind;
  readonly name: string;
  readonly detail: string;
}

/**
 * Every site that violates the policy: a baked literal not on the allowlist, or
 * a site the guard could not classify.
 */
export function findDerivationViolations(
  scan: DerivationScan,
  allowlist: ReadonlySet<string> = new Set<string>(),
): readonly DerivationViolation[] {
  const violations: DerivationViolation[] = [];

  for (const site of scan.literals) {
    // The allowlist is consulted for ordinary tracked debt only. A kill-fixture
    // name is reported unconditionally, so the rejection survives the eventual
    // population of the allowlist with the other tolerated literals and cannot
    // be turned off by editing data.
    const killFixture = isKillFixture(site.name);
    if (!killFixture && allowlist.has(site.name)) continue;
    violations.push({
      file: site.file,
      line: site.line,
      column: site.column,
      kind: site.kind,
      name: site.name,
      detail: killFixture
        ? `\`.command(${site.expression})\` is the DR-5 kill fixture: \`${site.name}\` is ` +
          'declared BOTH as a registry action and by hand here. It is not allowlistable. ' +
          'Delete the hand-written command and let the registry declaration — which carries ' +
          "`posture: 'shared-mutating'` — be the single remaining definition."
        : `\`.command(${site.expression})\` bakes the command name into the composition ` +
          'root. Register it through a derivation helper (registerActionCommand, the ' +
          'composite-tool loop, or the harness loop) so the name comes from a registry ' +
          'declaration.',
    });
  }

  for (const site of scan.indeterminate) {
    violations.push({
      file: site.file,
      line: site.line,
      column: site.column,
      kind: site.kind,
      name: site.name,
      detail:
        '`.command()` was called with no argument, so the guard cannot prove the command ' +
        'name is derived. Failing closed.',
    });
  }

  return violations;
}

/** Format one violation for the CLI/report surface. */
export function formatViolation(v: DerivationViolation): string {
  const at = `${v.file}:${v.line}:${v.column}`;
  const label = v.name.length > 0 ? `\`${v.name}\`` : '<unnamed>';
  return `  ✗ ${label} at ${at}\n      ${v.detail}`;
}

// ─── CLI entrypoint ──────────────────────────────────────────────────────────
//
// Runnable so the policy can be executed as a gate, not only imported by its
// co-located test. NOT yet wired into `ci.yml`: on the landing branch it
// reports all 11 literals and would fail the build, which is the accurate
// report but not yet an enforceable budget. Host-class note for whoever wires
// it (see `docs/guides/ci-gate-hosting.md`): this needs `typescript` resolvable,
// so it belongs in the DEPS TAIL of the unfiltered `grep-gates` job, NOT the
// zero-dep prefix. It needs neither Bun nor `bun:sqlite`, unlike the sibling
// `cli-vocab-guard`.

export function runGuard(): number {
  const scan = scanGovernedSources();
  const violations = findDerivationViolations(scan, readAllowlist());

  if (violations.length === 0) {
    process.stdout.write(
      `cli:derivation-guard — OK (${scan.sites.length} \`.command(\` site(s); every command ` +
        'name derives from a registry declaration)\n',
    );
    return 0;
  }

  process.stderr.write(
    `cli:derivation-guard — ${violations.length} literal command name(s) in the CLI ` +
      `composition root (of ${scan.sites.length} total \`.command(\` site(s)):\n`,
  );
  for (const v of violations) process.stderr.write(`${formatViolation(v)}\n`);
  process.stderr.write(
    '\nDR-5: the composition root must contain no literal `.command(\'<name>\')` call.\n' +
      'Register the command through a derivation helper so its name comes from a registry\n' +
      `declaration, or record it as tracked debt in ${ALLOWLIST_PATH}.\n`,
  );
  return 1;
}

const isDirectRun =
  typeof process !== 'undefined' &&
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('cli-derivation-guard.ts') ||
    process.argv[1].endsWith('cli-derivation-guard.js'));

if (isDirectRun) {
  process.exit(runGuard());
}

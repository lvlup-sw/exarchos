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

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { daysBetween, isIsoDay, isoDayUtc } from '../src/architecture/waiver-ledger.js';
import { keySetDigest } from '../src/architecture/waiver-ledger-digest.js';
import {
  CLI_DERIVATION_EXPIRY_HORIZON,
  CLI_DERIVATION_SEED_DIGEST_ALGORITHM,
  CLI_DERIVATION_SEED_KEY_SET_DIGEST,
} from './cli-derivation-seed-pin.js';

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

// ─── Allowlist: the waiver ledger ────────────────────────────────────────────
//
// Task 023 populated this policy file and made it a RATCHET. The shape follows
// the two waiver ledgers this repository already ships — DR-4's
// `src/output-schema-vacuity-allowlist.ts` and DR-2's
// `src/architecture/report-coupling-seed.ts` — deliberately and to the letter:
//
//   • an entry is `{ owner, expires }`, keyed by the thing being waived;
//   • a paid-down entry MOVES to a `retired` graveyard as `{ owner, retiredAt }`;
//   • `expires` is capped by ONE pinned horizon, so no entry can renew itself;
//   • the digest of `allowed ∪ retired` is pinned, so the list cannot grow or
//     be swapped in place;
//   • the finding codes are the same words.
//
// That sameness is the point. Three subjects under one rule is one authority;
// three subjects each with their own field names, their own notion of "expired"
// and their own repair advice would be three authorities for one policy, which
// is the multiple-authority defect DR-6 exists to detect. The primitives are
// still COPIED rather than shared across the three — recorded as a finding in
// task 023's report, with the extraction that would collapse them.

/** One tolerated hand-written verb: who owns removing it, and by when. */
export interface CliWaiverEntry {
  /** Subsystem accountable for registering the verb through a derivation helper. */
  readonly owner: string;
  /**
   * ISO date (YYYY-MM-DD) after which the waiver is expired — live THROUGH this
   * day and dead the next. ENFORCED by {@link auditCliDerivationExpiry}, and
   * capped by `CLI_DERIVATION_EXPIRY_HORIZON`: a date later than the horizon
   * fails, so an entry cannot buy itself more time. Bringing a date FORWARD is
   * always legal — it only shortens the debt's life.
   */
  readonly expires: string;
}

/**
 * One PAID-DOWN verb.
 *
 * The graveyard exists for one reason: it keeps the SEED KEY SET invariant. The
 * pinned digest is taken over `keys(allowed) ∪ keys(retired)`, so a legal
 * paydown is a MOVE (digest unchanged) and an illegal addition is a GROWTH
 * (digest changed). That is the whole difference between "the list shrank" and
 * "the list was swapped", and it is not derivable from today's parse alone.
 *
 * It is not a suppression list. A retired verb that is STILL a hand-written
 * literal is not waived — {@link auditCliAllowlistMembership} reports it as
 * `RETIRED_BUT_LIVE`, so moving an entry here without doing the work fails
 * louder than leaving it alone.
 */
export interface CliRetiredEntry {
  /** Subsystem that owned the paydown. Carried over from the waiver. */
  readonly owner: string;
  /** ISO date (YYYY-MM-DD) on which the entry left `allowed`. */
  readonly retiredAt: string;
}

export interface CliDerivationPolicy {
  readonly allowed: Readonly<Record<string, CliWaiverEntry>>;
  readonly retired: Readonly<Record<string, CliRetiredEntry>>;
}

/**
 * Read one plain-object field off parsed JSON, without a type assertion.
 *
 * `Reflect.get` into a local `unknown` narrowed by real runtime checks keeps
 * this inside the wave's cast budget (`as const` counts, so does `as X`) and —
 * more importantly — means a policy file of the wrong SHAPE is refused rather
 * than reinterpreted. An array is rejected explicitly: `typeof [] === 'object'`,
 * so the obvious check admits the pre-task-023 `"allowed": []` shape and would
 * silently resolve zero waivers from it.
 */
function readObjectField(
  parsed: unknown,
  field: string,
): Readonly<Record<string, unknown>> | undefined {
  const raw: unknown =
    typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, field) : undefined;
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) out[key] = Reflect.get(raw, key);
  return out;
}

/** The string at `value[field]`, or `undefined` if it is absent or not a string. */
function readStringField(value: unknown, field: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw: unknown = Reflect.get(value, field);
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * The whole policy — waivers and graveyard — read from {@link ALLOWLIST_PATH}.
 *
 * Fails closed on a missing or malformed file: a guard that silently treats an
 * unreadable allowlist as "allow nothing" would be fine, but one that treats it
 * as "allow everything" would not, and an unreadable policy file is a broken
 * gate either way. It also fails closed on a policy file whose `$comment` names
 * a file that does not exist — see {@link findPolicyReferenceProblems}.
 *
 * SHAPE is enforced here; CONTENT is enforced by the audits. An entry missing
 * `owner` or `expires` entirely is a broken file (the JSON has no type system to
 * catch it, which is what DR-4 gets for free from a `.ts` seed); an entry with
 * an EMPTY owner or an unparseable date is a finding, so the expiry audit can be
 * driven with those cases directly instead of only through a file on disk.
 */
export function readPolicy(repoRoot: string = REPO_ROOT): CliDerivationPolicy {
  const abs = path.join(repoRoot, ALLOWLIST_PATH);
  if (!existsSync(abs)) {
    throw new Error(
      `cli-derivation-guard: allowlist file missing at ${abs}. The policy data is part of ` +
        'the guard; a missing allowlist is a broken gate, not an empty one.',
    );
  }
  const parsed: unknown = JSON.parse(readFileSync(abs, 'utf8'));

  const allowedRaw = readObjectField(parsed, 'allowed');
  if (allowedRaw === undefined) {
    throw new Error(
      `cli-derivation-guard: allowlist at ${ALLOWLIST_PATH} must have an "allowed" OBJECT ` +
        'mapping each tolerated command name to `{ "owner": "…", "expires": "YYYY-MM-DD" }`. ' +
        'Refusing to run against a policy file whose shape it cannot verify. (The pre-ratchet ' +
        'shape was a bare array of names, which carried neither an owner nor a deadline.)',
    );
  }
  const retiredRaw = readObjectField(parsed, 'retired');
  if (retiredRaw === undefined) {
    throw new Error(
      `cli-derivation-guard: allowlist at ${ALLOWLIST_PATH} must have a "retired" OBJECT ` +
        'mapping each paid-down command name to `{ "owner": "…", "retiredAt": "YYYY-MM-DD" }`. ' +
        'It may be empty, but it may not be ABSENT: the graveyard is half of the pinned seed ' +
        'key set, and a missing one silently shrinks the set the digest is taken over.',
    );
  }

  const allowed: Record<string, CliWaiverEntry> = {};
  for (const name of Object.keys(allowedRaw)) {
    const value = allowedRaw[name];
    const owner = readStringField(value, 'owner');
    const expires = readStringField(value, 'expires');
    if (owner === undefined || expires === undefined) {
      throw new Error(
        `cli-derivation-guard: "${name}" in ${ALLOWLIST_PATH} "allowed" must carry a string ` +
          '"owner" and a string "expires". A waiver without an owner has nobody the debt comes ' +
          'due for, and one without a deadline is a permanent exemption wearing a name.',
      );
    }
    allowed[name] = { owner, expires };
  }

  const retired: Record<string, CliRetiredEntry> = {};
  for (const name of Object.keys(retiredRaw)) {
    const value = retiredRaw[name];
    const owner = readStringField(value, 'owner');
    const retiredAt = readStringField(value, 'retiredAt');
    if (owner === undefined || retiredAt === undefined) {
      throw new Error(
        `cli-derivation-guard: "${name}" in ${ALLOWLIST_PATH} "retired" must carry a string ` +
          '"owner" and a string "retiredAt". The graveyard records who paid the debt down and ' +
          'when; an entry without them is not a record of anything.',
      );
    }
    retired[name] = { owner, retiredAt };
  }

  // The kill fixture is not exemptible, in EITHER map. Refusing the FILE (rather
  // than quietly dropping the entry) is deliberate: a silently-ignored allowlist
  // line reads to its author as granted, and the whole failure mode being
  // guarded against here is an exemption that nobody noticed was load-bearing.
  // `retired` is covered too because "retire it without doing the work" is the
  // same act one map over — and the digest would reject it anyway, with a
  // message about hashes rather than about DR-5.
  const exempted = [...Object.keys(allowed), ...Object.keys(retired)].filter(isKillFixture);
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

  return Object.freeze({ allowed: Object.freeze(allowed), retired: Object.freeze(retired) });
}

/**
 * Names tolerated as literals — the key set of {@link readPolicy}'s `allowed`.
 *
 * Kept as a distinct, set-shaped view because that is what
 * {@link findDerivationViolations} consumes: the DERIVATION policy only asks
 * whether a name is tracked, and giving it the whole ledger would let a future
 * edit make the derivation verdict depend on an owner or a date.
 */
export function readAllowlist(repoRoot: string = REPO_ROOT): ReadonlySet<string> {
  return new Set(Object.keys(readPolicy(repoRoot).allowed));
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

// ═══ THE RATCHET (task 023) ══════════════════════════════════════════════════
//
// Everything above answers "is this command name derived?". Everything below
// answers a different question — "may this tolerated set change, and how?" —
// and the two verdicts are deliberately separate because only ONE of them can
// be green today. `merge-orchestrate` is still hand-written in the composition
// root and is not allowlistable, so the derivation policy has a live failing
// subject BY DESIGN until DR-19 deletes it. The ratchet below is green now and
// is the part wired blocking into CI, through
// `servers/exarchos-mcp/scripts/cli-derivation-ratchet-guard.ts`.
//
// Three teeth, plus the non-empty denominators:
//   1. MEMBERSHIP, both directions. An untracked literal fails; a tracked name
//      that is no longer a literal goes STALE and must be deleted. There is no
//      way to park a paid-down entry.
//   2. SEED KEY-SET INTEGRITY. Tooth 1 compares the policy against TODAY, and
//      therefore cannot see an in-place swap. The pinned digest can.
//   3. EXPIRY, enforced rather than advisory, capped by one pinned horizon so a
//      waiver cannot renew itself.

// ─── Dates ───────────────────────────────────────────────────────────────────
//
// Dates are compared as ISO `YYYY-MM-DD` STRINGS, never as `Date` values.
// Lexicographic order on that format is calendar order, so the comparison has
// no timezone, no DST, no leap-second and no millisecond component — a guard
// whose verdict depended on which side of midnight UTC the runner started would
// be its own flake class.

// The day rule is the shared ledger's, not this guard's. It was duplicated here
// when task 023 declined to extract rather than let this guard acquire a
// `bun:sqlite` edge; DR-6's ledger imports nothing, so that reason is gone and
// the copy with it. Re-exported because five modules take these names from here.
export { isIsoDay, isoDayUtc };

// ─── Tooth 1: membership, in both directions ─────────────────────────────────

/** A disagreement between the tracked set and the live parse. */
export type CliMembershipFinding =
  | { readonly code: 'UNTRACKED_LITERAL'; readonly name: string; readonly message: string }
  | { readonly code: 'STALE_WAIVER'; readonly name: string; readonly message: string }
  | { readonly code: 'RETIRED_BUT_LIVE'; readonly name: string; readonly message: string };

export interface CliMembershipAudit {
  readonly ok: boolean;
  /** Literal command names in the live parse, EXCLUDING kill fixtures. Zero is a failure upstream. */
  readonly literals: readonly string[];
  /** Names tracked as tolerated debt. */
  readonly tracked: readonly string[];
  readonly untracked: readonly string[];
  readonly stale: readonly string[];
  readonly retiredButLive: readonly string[];
  readonly findings: readonly CliMembershipFinding[];
}

/**
 * Pin the policy against the live parse, in BOTH directions.
 *
 * The count this guard reports is DERIVED from the scan on every run and is
 * written down nowhere: a census whose subject count is a literal reports the
 * same number after the composition root is renamed, emptied, or fails to
 * parse. `scanSourceForCommandSites` already refuses a zero-site parse, so the
 * denominator here cannot be empty for the reason that matters.
 *
 * Kill fixtures are excluded from BOTH sides. They are not tracked debt — they
 * are a standing rejection, reported unconditionally by
 * {@link findDerivationViolations}, and folding them in here would make the
 * ratchet demand an allowlist entry for exactly the name that may not have one.
 */
export function auditCliAllowlistMembership(
  scan: DerivationScan,
  policy: CliDerivationPolicy,
): CliMembershipAudit {
  const findings: CliMembershipFinding[] = [];
  const literals = [...new Set(scan.literals.map((s) => s.name).filter((n) => !isKillFixture(n)))].sort();
  const liveSet = new Set(literals);
  const tracked = Object.keys(policy.allowed).sort();
  const trackedSet = new Set(tracked);
  const retiredNames = Object.keys(policy.retired).sort();

  const untracked = literals.filter((n) => !trackedSet.has(n));
  for (const name of untracked) {
    findings.push({
      code: 'UNTRACKED_LITERAL',
      name,
      message:
        `'${name}' is a hand-written \`.command('${name}')\` literal in the composition root ` +
        'that no allowlist entry tracks. Register it through a derivation helper so its name ' +
        'comes from a registry declaration. Adding an entry is NOT the repair — the seed key ' +
        'set is pinned, so a new entry fails with SEED_KEY_SET_DRIFT.',
    });
  }

  const stale = tracked.filter((n) => !liveSet.has(n));
  for (const name of stale) {
    findings.push({
      code: 'STALE_WAIVER',
      name,
      message:
        `'${name}' holds a waiver but is no longer a hand-written literal in the composition ` +
        'root. If it was paid down, MOVE its entry to "retired" with a `retiredAt` date — the ' +
        'seed key set is the union of both maps, so a move keeps the pin valid and a deletion ' +
        'does not. There is deliberately no way to park a paid-down entry here.',
    });
  }

  const retiredButLive = retiredNames.filter((n) => liveSet.has(n));
  for (const name of retiredButLive) {
    findings.push({
      code: 'RETIRED_BUT_LIVE',
      name,
      message:
        `'${name}' is recorded as retired but is STILL a hand-written literal in the ` +
        'composition root. Retiring an entry without doing the work fails louder than leaving ' +
        'it alone, which is the point: the graveyard is a record of paydowns, not a ' +
        'suppression list.',
    });
  }

  return Object.freeze({
    ok: findings.length === 0,
    literals: Object.freeze(literals),
    tracked: Object.freeze(tracked),
    untracked: Object.freeze(untracked),
    stale: Object.freeze(stale),
    retiredButLive: Object.freeze(retiredButLive),
    findings: Object.freeze(findings),
  });
}

/** Render the membership audit for a human or an agent. */
export function formatCliMembershipAudit(audit: CliMembershipAudit): string {
  const lines: string[] = [
    `CLI derivation membership: ${audit.tracked.length} tracked waiver(s) against ` +
      `${audit.literals.length} live hand-written literal(s) — ${audit.ok ? 'OK' : 'FAILED'}.`,
  ];
  if (audit.findings.length > 0) {
    lines.push(`  ${audit.findings.length} finding(s):`);
    for (const finding of audit.findings) {
      lines.push(`    [${finding.code}] ${finding.name}: ${finding.message}`);
    }
  }
  return lines.join('\n');
}

// ─── Tooth 2: the seed key set is pinned ─────────────────────────────────────

/** A condition that means the SEED's key set is no longer the one that was pinned. */
export type CliSeedFinding =
  | { readonly code: 'SEED_KEY_SET_DRIFT'; readonly message: string }
  | { readonly code: 'RETIRED_AND_WAIVED'; readonly name: string; readonly message: string };

export interface CliSeedIntegrityAudit {
  /** True when the live key set hashes to the pinned digest and the maps are disjoint. */
  readonly ok: boolean;
  /** `|allowed ∪ retired|` — the seed's size, which legal edits do not change. */
  readonly keySetSize: number;
  readonly digest: string;
  readonly pinnedDigest: string;
  /** Names present in BOTH maps. A paydown is a MOVE, never a copy. */
  readonly overlapping: readonly string[];
  readonly findings: readonly CliSeedFinding[];
}

/**
 * The seed key set's digest: `sha256` over the sorted, deduplicated names
 * joined by newlines.
 *
 * Order- and duplicate-insensitive on purpose — the pinned quantity is a SET,
 * so re-sorting the policy file or writing a name twice must not move the
 * digest. Only membership does.
 */
export function cliDerivationSeedDigest(names: readonly string[]): string {
  return keySetDigest(names, CLI_DERIVATION_SEED_DIGEST_ALGORITHM);
}

/**
 * Audit the seed's key set against its frozen pin.
 *
 * All three inputs are injectable for the same reason the scanner is pure: a
 * self-test has to pose an in-place swap, and a swap cannot be posed against
 * the real policy file without editing the real policy file.
 */
export function auditCliDerivationSeedIntegrity(
  waived: readonly string[],
  retired: readonly string[],
  pinnedDigest: string = CLI_DERIVATION_SEED_KEY_SET_DIGEST,
): CliSeedIntegrityAudit {
  const findings: CliSeedFinding[] = [];
  const waivedSet = new Set(waived);
  const overlapping = [...new Set(retired)].filter((n) => waivedSet.has(n)).sort();
  const keySet = [...new Set([...waived, ...retired])].sort();
  const digest = cliDerivationSeedDigest(keySet);

  if (digest !== pinnedDigest) {
    findings.push({
      code: 'SEED_KEY_SET_DRIFT',
      message:
        `The CLI-derivation seed's key set no longer matches its frozen pin: ${keySet.length} ` +
        `name(s) hash to ${digest}, pinned ${pinnedDigest}. The seed key set is ` +
        'ALLOWED ∪ RETIRED, and it is invariant under every legal edit — paying a verb down ' +
        'MOVES its entry from "allowed" to "retired", it does not delete it. A drift therefore ' +
        'means a name was ADDED (a new hand-written verb smuggled in as a swap, which no ' +
        'comparison against the live parse can see) or DELETED (a paydown recorded as a ' +
        'deletion, which destroys the prior state this tooth is made of). Do NOT regenerate ' +
        'the pin to go green.',
    });
  }

  for (const name of overlapping) {
    findings.push({
      code: 'RETIRED_AND_WAIVED',
      name,
      message:
        `'${name}' is in BOTH the allowlist and the retirement record. A paydown is a MOVE, ` +
        'not a copy — delete the "allowed" entry. Left as is, the verb reads as retired while ' +
        'still holding a live waiver.',
    });
  }

  return Object.freeze({
    ok: findings.length === 0,
    keySetSize: keySet.length,
    digest,
    pinnedDigest,
    overlapping: Object.freeze(overlapping),
    findings: Object.freeze(findings),
  });
}

/** Render the seed-integrity audit for a human or an agent. */
export function formatCliSeedIntegrityAudit(audit: CliSeedIntegrityAudit): string {
  const lines: string[] = [
    `CLI derivation seed integrity: ${audit.keySetSize} name(s), digest ${audit.digest} ` +
      `against pin ${audit.pinnedDigest} — ${audit.ok ? 'OK' : 'FAILED'}.`,
  ];
  if (audit.findings.length > 0) {
    lines.push(`  ${audit.findings.length} finding(s):`);
    for (const finding of audit.findings) {
      const subject = 'name' in finding ? ` ${finding.name}:` : '';
      lines.push(`    [${finding.code}]${subject} ${finding.message}`);
    }
  }
  return lines.join('\n');
}

// ─── Tooth 3: the expiry is ENFORCED, not advisory ───────────────────────────
//
// This tooth is deliberately separate from the two above because it is the only
// one that is a function of TIME:
//
//   • membership and seed integrity are STRUCTURAL — same verdict forever, for
//     a fixed pair of inputs. They belong in the unit suite, and they are there.
//   • expiry is TEMPORAL — the same repository is green today and red in March
//     2027, which is the entire point of a deadline. A wall-clock read inside
//     the unit suite would turn "the debt came due" into "the test suite stopped
//     working", and a developer who cannot run tests fixes the CLOCK, not the
//     debt. So NOTHING in this module reads `new Date()`: `today` is a required
//     first parameter, and the single production clock read lives at the gate
//     entrypoint (`servers/exarchos-mcp/scripts/cli-derivation-ratchet-guard.ts`),
//     which is the artifact that blocks the merge.

/** A condition that makes an allowlist entry's deadline invalid or past due. */
export type CliExpiryFinding =
  | { readonly code: 'EMPTY_ALLOWLIST'; readonly message: string }
  | { readonly code: 'UNREADABLE_CLOCK'; readonly message: string }
  | { readonly code: 'MALFORMED_HORIZON'; readonly message: string }
  | { readonly code: 'MALFORMED_WAIVER'; readonly name: string; readonly message: string }
  | { readonly code: 'WAIVER_BEYOND_HORIZON'; readonly name: string; readonly message: string }
  | { readonly code: 'EXPIRED_WAIVER'; readonly name: string; readonly message: string };

export interface CliExpiryAudit {
  /** True when every entry is well-formed, within the horizon, and not past due. */
  readonly ok: boolean;
  /** The instant the verdict was taken at, echoed so a report is self-describing. */
  readonly today: string;
  readonly horizon: string;
  /** Entries examined. Zero is a failure, never a clean run. */
  readonly entryCount: number;
  /** Names whose `expires` is strictly before `today`. The deadline, bitten. */
  readonly expired: readonly string[];
  /** Names whose `expires` is later than the pinned horizon — a self-granted renewal. */
  readonly beyondHorizon: readonly string[];
  /** Names with an empty owner or an unparseable `expires`. Fails closed. */
  readonly malformed: readonly string[];
  /** Whole days from `today` to `horizon`; negative once the horizon itself is past. */
  readonly daysToHorizon: number;
  readonly findings: readonly CliExpiryFinding[];
}

/**
 * Audit every allowlist entry's deadline as of a NAMED day.
 *
 * `today` is required and has no default — see the section header. The
 * production call is `auditCliDerivationExpiry(isoDayUtc(new Date()), …)`, made
 * once, at the gate entrypoint.
 *
 * Four teeth:
 *   1. NON-EMPTY DENOMINATOR. An allowlist that resolves to zero entries makes
 *      "no expired waiver" true for the worst possible reason — a moved file, a
 *      broken parse, a renamed field. It FAILS. The legitimate zero state exists
 *      (DR-19, the debt fully paid), and it is not this: reaching zero deletes
 *      the policy file, the pin and this audit in one commit.
 *   2. WELL-FORMEDNESS. An empty owner or an `expires` that is not a real
 *      calendar day fails closed. An unowned waiver has nobody to come due for,
 *      and an unparseable date cannot be compared — neither may read as "fine".
 *   3. HORIZON. `expires` later than `CLI_DERIVATION_EXPIRY_HORIZON` fails. This
 *      is what stops a waiver from renewing itself: the entry cannot name a date
 *      of its own choosing, so extending the debt means moving ONE pinned
 *      constant in a file of frozen values, not ten lines in a policy file.
 *   4. EXPIRY. `expires` strictly before `today` fails. Inclusive of the expiry
 *      day itself — an entry marked `2027-02-28` is live THROUGH 2027-02-28 and
 *      dead on 2027-03-01, matching the field's documented meaning.
 */
export function auditCliDerivationExpiry(
  today: string,
  entries: Readonly<Record<string, CliWaiverEntry>>,
  horizon: string = CLI_DERIVATION_EXPIRY_HORIZON,
): CliExpiryAudit {
  const findings: CliExpiryFinding[] = [];
  const names = Object.keys(entries).sort();
  const clockOk = isIsoDay(today);
  const horizonOk = isIsoDay(horizon);

  if (!clockOk) {
    findings.push({
      code: 'UNREADABLE_CLOCK',
      message:
        `The expiry audit was handed '${today}' as the current day, which is not a real ` +
        'calendar date in YYYY-MM-DD form. Every deadline comparison below would be ' +
        'meaningless, so the audit fails rather than reporting the waivers live.',
    });
  }
  if (!horizonOk) {
    findings.push({
      code: 'MALFORMED_HORIZON',
      message:
        `The pinned expiry horizon '${horizon}' is not a real calendar date in YYYY-MM-DD ` +
        'form. CLI_DERIVATION_EXPIRY_HORIZON in ' +
        'servers/exarchos-mcp/scripts/cli-derivation-seed-pin.ts is the one deadline every ' +
        'waiver is measured against; an unreadable horizon disables the tooth that stops a ' +
        'waiver renewing itself, so it fails closed.',
    });
  }
  if (names.length === 0) {
    findings.push({
      code: 'EMPTY_ALLOWLIST',
      message:
        'The CLI-derivation allowlist resolved ZERO entries, so the expiry audit has an empty ' +
        'denominator and proves nothing — "no expired waiver" is trivially true over no ' +
        'waivers. That is what a moved policy file or a renamed field looks like, so it fails ' +
        'rather than reporting clean. If the debt really did reach zero at DR-19, the policy ' +
        'file, its pin and this audit are DELETED in the same commit.',
    });
  }

  const expired: string[] = [];
  const beyondHorizon: string[] = [];
  const malformed: string[] = [];

  for (const name of names) {
    const entry = entries[name];
    if (entry === undefined) continue;

    if (entry.owner.trim().length === 0 || !isIsoDay(entry.expires)) {
      malformed.push(name);
      findings.push({
        code: 'MALFORMED_WAIVER',
        name,
        message:
          `'${name}' carries owner '${entry.owner}' and expires '${entry.expires}'. A waiver ` +
          'needs a non-empty owner (someone the debt comes due for) and a real calendar date ' +
          'in YYYY-MM-DD form (something the deadline can be compared against). Neither can be ' +
          'inferred, so the entry fails closed.',
      });
      continue;
    }

    if (horizonOk && entry.expires > horizon) {
      beyondHorizon.push(name);
      findings.push({
        code: 'WAIVER_BEYOND_HORIZON',
        name,
        message:
          `'${name}' expires ${entry.expires}, later than the pinned horizon ${horizon}. A ` +
          'waiver may not name its own deadline — that is renewal without a decision. Pay the ' +
          'verb down (register it through a derivation helper and MOVE its entry to "retired"), ' +
          'or move CLI_DERIVATION_EXPIRY_HORIZON in ' +
          'servers/exarchos-mcp/scripts/cli-derivation-seed-pin.ts as a deliberate, isolated ' +
          'commit that re-dates the WHOLE outstanding debt.',
      });
    }

    if (clockOk && entry.expires < today) {
      expired.push(name);
      findings.push({
        code: 'EXPIRED_WAIVER',
        name,
        message:
          `'${name}' (owner: ${entry.owner}) expired on ${entry.expires}; today is ${today}. ` +
          'DR-5: the expiry is ENFORCED, not advisory. Register the verb through a derivation ' +
          'helper and MOVE its entry to "retired". Bumping the date is not the fix — the entry ' +
          `cannot exceed the pinned horizon ${horizon}.`,
      });
    }
  }

  return Object.freeze({
    ok: findings.length === 0,
    today,
    horizon,
    entryCount: names.length,
    expired: Object.freeze(expired),
    beyondHorizon: Object.freeze(beyondHorizon),
    malformed: Object.freeze(malformed),
    daysToHorizon: daysBetween(today, horizon),
    findings: Object.freeze(findings),
  });
}

/** Render the expiry audit for a human or an agent. */
export function formatCliExpiryAudit(audit: CliExpiryAudit): string {
  const lines: string[] = [
    `CLI derivation waiver expiry: ${audit.entryCount} waiver(s) as of ${audit.today}, ` +
      `horizon ${audit.horizon} (${audit.daysToHorizon} day(s)) — ${audit.ok ? 'OK' : 'FAILED'}.`,
  ];
  if (audit.findings.length > 0) {
    lines.push(`  ${audit.findings.length} finding(s):`);
    for (const finding of audit.findings) {
      const subject = 'name' in finding ? ` ${finding.name}:` : '';
      lines.push(`    [${finding.code}]${subject} ${finding.message}`);
    }
  }
  return lines.join('\n');
}

// ─── The composed ratchet verdict ────────────────────────────────────────────

export interface CliRatchetVerdict {
  readonly ok: boolean;
  readonly membership: CliMembershipAudit;
  readonly seed: CliSeedIntegrityAudit;
  readonly expiry: CliExpiryAudit;
  /** Every finding code raised, across all three teeth, in tooth order. */
  readonly findings: readonly string[];
}

/**
 * Compose the three teeth into one verdict at a NAMED day.
 *
 * Separate from the audits so each stays independently drivable, and separate
 * from the gate entrypoint so the composition itself is testable without a
 * clock. `ok` is the conjunction — a ratchet that passed while one tooth failed
 * would be the presence-not-substance defect this program keeps removing.
 */
export function auditCliRatchetAsOf(
  today: string,
  scan: DerivationScan,
  policy: CliDerivationPolicy,
  pinnedDigest: string = CLI_DERIVATION_SEED_KEY_SET_DIGEST,
  horizon: string = CLI_DERIVATION_EXPIRY_HORIZON,
): CliRatchetVerdict {
  const membership = auditCliAllowlistMembership(scan, policy);
  const seed = auditCliDerivationSeedIntegrity(
    Object.keys(policy.allowed),
    Object.keys(policy.retired),
    pinnedDigest,
  );
  const expiry = auditCliDerivationExpiry(today, policy.allowed, horizon);
  return Object.freeze({
    ok: membership.ok && seed.ok && expiry.ok,
    membership,
    seed,
    expiry,
    findings: Object.freeze([
      ...membership.findings.map((f) => f.code),
      ...seed.findings.map((f) => f.code),
      ...expiry.findings.map((f) => f.code),
    ]),
  });
}

// ─── CLI entrypoint ──────────────────────────────────────────────────────────
//
// Runnable so the DERIVATION policy can be executed, not only imported. It is
// still NOT wired into `.github/workflows/ci.yml`, and after task 023 that is a
// narrower and more precise statement than it was before:
//
//   Before, it exited 1 on all ELEVEN hand-written literals, because the
//   allowlist was empty. Now ten of the eleven are tracked debt with an owner
//   and an enforced deadline, and the ONE remaining violation is
//   `merge-orchestrate` — the kill fixture, which is not allowlistable and must
//   stay rejected. DR-5's own remediation for it is DELETION of the hand-written
//   `.command('merge-orchestrate')` call, and no Wave-1 task owns that edit (see
//   task 023's report). Until it lands, this entrypoint reports exactly one
//   violation and exits 1 — which is the guard working, not the guard broken.
//
// The RATCHET half — the part that is green today and enforceable now — has its
// own entrypoint at `servers/exarchos-mcp/scripts/cli-derivation-ratchet-guard.ts`,
// which is wired blocking and unfiltered. This mirrors DR-4's split between the
// census library and `servers/exarchos-mcp/scripts/output-schema-ratchet-guard.ts`.
//
// Host-class note for whoever wires THIS entrypoint once the kill fixture is
// deleted (see `docs/guides/ci-gate-hosting.md`): it needs `typescript`
// resolvable, so it belongs in the DEPS TAIL of the unfiltered `grep-gates` job,
// NOT the zero-dep prefix. It needs neither Bun nor `bun:sqlite`, unlike the
// sibling `cli-vocab-guard`.

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

// THE ENTRYPOINT TAIL — and why it is not a filename comparison (task 074)
//
// The predicate used to be `process.argv[1].endsWith('cli-derivation-guard.ts')`,
// which couples self-execution to the FILE'S NAME. Renaming the file — and
// updating the `run:` step in ci.yml to match, which is what a rename means —
// leaves a CI step that still exists, still runs, still resolves, prints NOTHING
// and exits 0. Task 018 measured that on the sibling `output-schema-ratchet-guard`
// and this guard reproduced it: a byte-identical copy under any other name
// produced 0 bytes on stdout, 0 bytes on stderr, exit 0.
//
// {@link canonicalPath} also resolves symlinks, because Node reports the main
// module's realpath while `argv[1]` keeps the link — comparing the two unresolved
// would trade a filename-shaped silent no-op for a symlink-shaped one.
//
// NOTE FOR ANYONE EDITING BELOW: `process.exit` must stay a TOP-LEVEL call.
// `scripts/guard-inventory.ts` classifies a module as a runnable gate by finding
// exactly that (`hasDirectRunExit`, an AST walk that rejects a `process.exit`
// nested inside a function), and a gate it cannot see drops out of DR-24's
// CI-reachability proof.

/**
 * A canonical absolute path for comparison: symlinks resolved where possible,
 * falling back to plain resolution for a path that does not exist on disk (so
 * an exotic `argv[1]` degrades to "not the entrypoint" rather than throwing).
 */
function canonicalPath(candidate: string): string {
  const absolute = path.resolve(candidate);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

const isDirectRun =
  typeof process !== 'undefined' &&
  typeof process.argv[1] === 'string' &&
  canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url));

if (isDirectRun) {
  // `exitCode`, never `exit(…)` — see report-coupling-ratchet-guard.ts: exiting
  // can sever stdout before the diagnostics drain.
  process.exitCode = runGuard();
}

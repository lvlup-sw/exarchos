import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * P04-01 — effect ownership ledger (structural census).
 *
 * The unified remediation plan (PROGRAM-04) mandates that **every effect has one
 * typed owner, idempotency boundary, and repair or compensation contract**. This
 * module is the structural-conformance harness for that mandate: a string-aware
 * static scan of the shipped source that enumerates every *effect occurrence*
 * and maps it to a declared typed owner via {@link EFFECT_OWNERSHIP}. Any
 * occurrence that no ownership rule claims is an `INDETERMINATE_OWNER` and fails
 * the census; any ownership rule that claims no live occurrence is a
 * `STALE_OWNERSHIP` phantom and also fails (no stale cover — the same "no-mask"
 * ratchet as `architecture/import-cycles.ts`).
 *
 * It follows the established `verbs/gates/gate-ownership-census.ts` pattern: a
 * string-aware source scan producing a typed verdict over the *real* tree, so a
 * regression (a new unowned effect site) trips it rather than a hand-maintained
 * mirror.
 *
 * ── Effect classes ──────────────────────────────────────────────────────────
 * The scan classifies the three effect *primitives* that are statically
 * detectable from a module's import surface: `filesystem` (`node:fs`), `process`
 * (`node:child_process`), and `network` (see {@link classifySpecifier} for the
 * widened network subject). The plan's other named effects — `vcs` and
 * `install` — are process *owners*, not separate primitives: a `process`
 * occurrence under `vcs/**` is owned by the VCS effect owner, one under an
 * install module by the install owner. Ownership is therefore where `vcs` /
 * `install` are named (see {@link EFFECT_OWNERSHIP}).
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * "Shipped source" excludes test, fixture, benchmark and evaluation harnesses
 * (see {@link EXCLUDED_DIRS} / {@link isScannableFile}); those are not shipped
 * and carry their own effect surface. Filesystem persistence is pervasive, so
 * its ownership is declared at layer granularity; process and network are
 * declared at the crisp module/owner granularity their "one typed owner" mandate
 * warrants.
 *
 * ── DR-13: effect detection is not evadable by import shape ─────────────────
 * The pre-DR-13 detector keyed off an exact specifier list
 * (`node:http|https|net|tls|dgram`, `undici`) plus a bare `fetch(` regex. That
 * is trivially evaded: `node:http2`, `axios`/`got`/`ws`/`node-fetch`, a private
 * `@scope/transport` package and an aliased global were all invisible, so a
 * module could perform network I/O and the census would stay green. The
 * widening replaces the denylist with a CLOSED-WORLD subject:
 *
 *   1. the full set of network-capable runtime builtins
 *      (`http`/`https`/`http2`/`net`/`tls`/`dgram`/`dns`, `node:`- or
 *      `bun:`-prefixed or bare) — {@link NETWORK_BUILTIN};
 *   2. a curated set of well-known third-party HTTP/socket clients, aligned
 *      with the repo's existing `config/toolchains.ts` `third-party-http`
 *      signature — {@link THIRD_PARTY_NETWORK_CLIENTS};
 *   3. **every other bare package specifier that is not on the vetted-inert
 *      allowlist** {@link INERT_DEPENDENCIES}. This is the rule that actually
 *      closes the defect: a client can be published under ANY name, so the only
 *      non-evadable rule is one that fails closed on names nobody has vetted;
 *   4. remote-URL imports (`https://…`, `wss://…`), which fetch over the wire
 *      by construction;
 *   5. ambient globals reached without an import — `fetch(…)`,
 *      `<globalRoot>.fetch` (where `<globalRoot>` is any spelling of the global
 *      object: `globalThis`/`global`/`self`/`window`), `const f = fetch`,
 *      `const { fetch } = <globalRoot>`, `new WebSocket(…)` — see
 *      {@link AMBIENT_NETWORK_RULES} — plus the Bun ambient runtime object,
 *      whose I/O needs no import at all: `Bun.serve`/`Bun.connect` (network),
 *      `Bun.spawn` (process), `Bun.write`/`Bun.file` (filesystem) — see
 *      {@link AMBIENT_BUN_RULES}.
 *
 * Rule 3 deliberately inverts the list: an allowlist of *inert* dependencies
 * grows only when a human consciously asserts "this package performs no I/O",
 * whereas the old denylist grew only when someone remembered a client name. It
 * is decidable HERE because the shipped bare-import surface is small and fixed
 * (see {@link INERT_DEPENDENCIES}); it is not a general-purpose rule. The
 * `network` classification it assigns is CONSERVATIVE, not a claim of fact — an
 * unvetted package's effect surface is unknowable from source, so the ledger
 * charges it to the widest primitive and carries the specifier in `evidence`
 * (`unvetted-dependency:<pkg>`) so the diagnostic names exactly what was
 * admitted. The fix is either to vet the package into {@link
 * INERT_DEPENDENCIES} or to declare an owner for it.
 *
 * ── DR-13 trust boundary — what this scan does NOT see ──────────────────────
 * DR-13's second acceptance criterion allows an evasion class to be scoped out
 * *provided the boundary is documented explicitly*. These are scoped out, each
 * because it is not soundly decidable from a single module's source text. They
 * are stated here so the carve-out cannot silently grow, and each is pinned by a
 * test in `effect-ledger.test.ts` so a future widening has to delete the pin:
 *
 *   - INJECTED CLIENTS. A client passed in as a constructor/function parameter
 *     (`constructor(private http: HttpLike)`, `run(deps: { post: Poster })`) is
 *     INVISIBLE and cannot be made visible by a source scan: the parameter's
 *     effect surface is a property of the *caller*, which a per-module scan
 *     never sees, and its type may be a structural interface with no effectful
 *     import anywhere. The ledger's coverage of injection is INDIRECT: whichever
 *     module constructs the real client must name it (rules 1–4) or reach an
 *     ambient global (rule 5), and THAT module is the effect site. This is the
 *     deliberate seam — the injection point is a port, the constructor is the
 *     adapter, and the adapter is what the ledger owns.
 *   - TRANSITIVE ATTRIBUTION. A re-export of an effect primitive IS detected —
 *     `export { request } from 'node:https'` names the primitive, so the
 *     re-exporting module is an effect site and needs an owner. What is NOT
 *     detected is the *consumer* of that re-export: effects are attributed to
 *     the module that names the primitive, never propagated along the import
 *     graph. Attribution is intentionally per-module because that is where an
 *     owner, an idempotency contract and a compensation contract can live.
 *   - COMPUTED / STRING-INDEXED ACCESS. `globalThis['fet' + 'ch']`,
 *     `Reflect.get(globalThis, name)` and a `fetch` reference smuggled through a
 *     shape none of {@link AMBIENT_NETWORK_RULES} matches (e.g. the object
 *     shorthand `const c = { fetch }`) are not matched. Computed member access
 *     is undecidable in general; the shorthand is excluded on purpose because a
 *     bare `fetch` identifier rule false-positives on ordinary property keys and
 *     interface members.
 *
 * Everything above is a FALSE-NEGATIVE boundary, never a false positive: the
 * census can under-report a smuggled effect, but it never invents one.
 *
 * ── DR-26 / task 065: the lexical question is INVERTED to the caller ────────
 * The sentence above was, until task 065, **false**, and a fourth carve-out
 * ("TEMPLATE-LITERAL INTERPOLATION") claimed a false-negative the module did not
 * actually have. Both were artefacts of the same thing: this module used to
 * answer "what does this source import, and which of its characters are code?"
 * with two hand-rolled lexers whose own headers admitted the regex-versus-
 * division rule was a heuristic. Measured on the tree at task 065:
 *
 *   • FALSE POSITIVE. `` export const d = `outer ${ `inner from 'node:child_process' text` } end`; ``
 *     imports nothing. The heuristic toggled on every backtick, so the NESTED
 *     template's body read as code and it reported one `process` occurrence —
 *     the census inventing an effect, which the paragraph above swore it could
 *     never do.
 *   • FALSE NEGATIVE, the dangerous direction. A regex literal containing a
 *     backtick in a position the heuristic scored as division
 *     (`return /` + backtick + `/.test(s);`) opened a phantom template literal
 *     that ran to EOF, so a following real `import { readFile } from 'node:fs'`
 *     was invisible and the module scanned as effect-free. That is exactly the
 *     evasion DR-13's closed-world rule exists to prevent, reachable by
 *     accident rather than by malice.
 *
 * The sound answer is to parse: a specifier inside a comment, a string or a
 * template is not an import NODE, and a `${…}` substitution IS code, so both
 * follow by construction rather than by another filter. But the only instrument
 * that cannot disagree with the compiler about TypeScript's grammar is the
 * compiler, and `typescript` is a devDependency while this is shipped `src/`.
 * Task 062 measured the consequence directly: adding `import ts from 'typescript'`
 * to a module under `architecture/` fails this very census with one
 * `INDETERMINATE_OWNER`, because `typescript` is not in {@link
 * INERT_DEPENDENCIES}; and vetting it inert would be FALSE at the granularity
 * this list vets, since `import ts` puts `ts.sys` — full filesystem and process
 * access — one property access away.
 *
 * So the lexer is a REQUIRED PORT ({@link ModuleLexer}), exactly as the
 * filesystem walk already is and exactly as `architecture/import-cycles.ts`
 * takes dependency-cruiser JSON rather than running it. This module keeps the
 * POLICY — which specifier is an effect, which shape is an ambient global, who
 * owns what — and owns no lexing mechanism at all. The implementation is
 * `test-helpers/module-lexer.ts`, the one directory both skipped by {@link
 * EXCLUDED_DIRS} and inside `tsconfig.json`'s `include`, so it is still
 * typechecked. The superseded heuristic is retained ONLY as
 * `test-helpers/superseded-source-lexer.ts`, so the kill fixture can assert both
 * numbers rather than asking a reader to take the gap on faith.
 *
 * The port is REQUIRED everywhere it appears. A default would have to be either
 * the retired heuristic (the defect, retained) or a throwing stub (a runtime
 * failure where the checker could have spoken), and an optional lexer is exactly
 * how a caller silently gets the old answers back.
 */

/** The three statically-detectable effect primitives. */
export type EffectClass = 'filesystem' | 'process' | 'network';

/** A single effect occurrence: module M performs effect class C, per `evidence`. */
export interface EffectOccurrence {
  /** Repo-relative to the scan root, forward-slashed. */
  readonly module: string;
  readonly effectClass: EffectClass;
  /** The import specifier or token that evidences the effect. */
  readonly evidence: string;
}

/**
 * A declared ownership rule. `match` is either an exact module path or a
 * directory prefix ending in `/`. A rule claims every occurrence of its
 * `effectClass` whose module the `match` covers. `owner` is the single typed
 * owner; `idempotency` and `compensation` record the two remaining contracts the
 * plan requires of every effect.
 */
export interface EffectOwnershipRule {
  readonly effectClass: EffectClass;
  readonly match: string;
  readonly owner: string;
  readonly idempotency: string;
  readonly compensation: string;
}

export type EffectLedgerDiagnostic =
  | {
      readonly code: 'INDETERMINATE_OWNER';
      readonly module: string;
      readonly effectClass: EffectClass;
      readonly evidence: string;
      readonly message: string;
    }
  | {
      readonly code: 'STALE_OWNERSHIP';
      readonly effectClass: EffectClass;
      readonly match: string;
      readonly owner: string;
      readonly message: string;
    }
  | {
      readonly code: 'EMPTY_MODULE_POPULATION';
      readonly message: string;
    }
  | {
      readonly code: 'EMPTY_SPECIFIER_DENOMINATOR';
      readonly message: string;
    };

export interface EffectLedgerResult {
  readonly ok: boolean;
  /** Modules the scan visited — the population. Zero is a failure, never a pass. */
  readonly moduleCount: number;
  /**
   * Module specifiers the lexer resolved across the whole population — the
   * denominator. Zero over a non-empty population is a failure, never a pass.
   */
  readonly specifierCount: number;
  readonly occurrenceCount: number;
  readonly diagnostics: readonly EffectLedgerDiagnostic[];
}

/**
 * An already-collected effect scan: the occurrences plus the two denominators
 * that say whether the numbers underneath them mean anything.
 *
 * Both counts are REQUIRED, never optional or derived. `occurrences` alone
 * cannot distinguish "the tree performs no unowned effect" (the success state)
 * from "the walk resolved no modules" or "the lexer resolved no specifiers"
 * (a broken instrument), and all three present as an empty array. An optional
 * field defaulting to "unknown" would hand every caller the vacuity back.
 */
export interface EffectScan {
  readonly occurrences: readonly EffectOccurrence[];
  readonly moduleCount: number;
  readonly specifierCount: number;
}

// ─── Detection ──────────────────────────────────────────────────────────────

/** Directories whose contents are not shipped source (test/bench/eval harnesses). */
export const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '__tests__',
  '__fixtures__',
  '__mocks__',
  'test-helpers',
  'bench',
  'benchmarks',
  'evals',
]);

/** True for a shipped-source TypeScript module (not a test/decl/bench file). */
export function isScannableFile(name: string): boolean {
  return (
    name.endsWith('.ts') &&
    !name.endsWith('.test.ts') &&
    !name.endsWith('.d.ts') &&
    !name.endsWith('.bench.ts')
  );
}

const FS_SPEC = /^fs(?:\/promises)?$/;
const PROCESS_SPEC = /^child_process$/;

/**
 * Network-capable runtime builtins (DR-13 rule 1), matched on the *unprefixed*
 * module name so `node:http2`, `bun:http2` and a bare `http2` are all the same
 * subject. `http2` and `dns` were the two the pre-DR-13 list missed outright.
 * `dns` counts: name resolution is a packet on the wire and is the classic
 * exfiltration channel for a process that is otherwise "offline".
 */
const NETWORK_BUILTIN = /^(?:http|https|http2|net|tls|dgram|dns)(?:\/promises)?$/;

/** Remote-URL module specifiers (DR-13 rule 4) — importing one IS a fetch. */
const REMOTE_URL_SPEC = /^(?:https?|wss?):\/\//;

/**
 * Runtime-builtin schemes. A specifier carrying one of these is resolved by the
 * runtime, never by the package manager, so it is judged by {@link
 * NETWORK_BUILTIN} / {@link FS_SPEC} / {@link PROCESS_SPEC} alone and is never
 * an "unvetted dependency" (rule 3). `bun:sqlite` — the shipped SQLite
 * substrate — is the live example.
 */
const BUILTIN_SCHEME = /^(node|bun):/;

/**
 * Node builtins reachable WITHOUT the `node:` prefix. Needed so the closed-world
 * rule 3 does not mistake a bare `util` or `child_process` import (both live in
 * the shipped tree) for an unvetted npm package. Subpath forms (`fs/promises`)
 * normalise to their head segment before lookup.
 */
const NODE_BUILTINS: ReadonlySet<string> = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os',
  'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline',
  'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'trace_events',
  'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

/**
 * Well-known third-party HTTP/socket clients (DR-13 rule 2). The membership list
 * is the same vocabulary `config/toolchains.ts` already uses for its
 * `third-party-http` hermetic-dependency signature, plus the socket clients that
 * signature has no reason to name.
 *
 * For the *verdict* this set is subsumed by rule 3 (none of these is inert), and
 * that is deliberate: the set exists so the diagnostic can say "axios" rather
 * than "unvetted dependency", i.e. so a real client is named as a network
 * primitive and not merely as an un-audited package. Keeping it separate also
 * means a future narrowing of rule 3 cannot silently un-detect the named
 * clients.
 */
const THIRD_PARTY_NETWORK_CLIENTS: ReadonlySet<string> = new Set([
  'axios', 'got', 'ky', 'needle', 'node-fetch', 'phin', 'request', 'superagent',
  'undici', 'unfetch', 'isomorphic-fetch', 'cross-fetch', 'bent', 'wreck',
  'ws', 'socket.io-client', 'websocket', 'eventsource', 'grpc', '@grpc/grpc-js',
]);

/**
 * The VETTED-INERT dependency allowlist — the closed world rule 3 is closed
 * against. Every bare package specifier the shipped tree imports is listed here
 * with the reason it performs no ambient I/O of its own; anything else is an
 * `unvetted-dependency` network occurrence until a human vets it.
 *
 * This IS an exact-specifier list, but it grows in the SAFE direction: a
 * forgotten entry fails the census (loud), whereas a forgotten entry in the old
 * client denylist silently passed it. Match is on the PACKAGE name, so every
 * subpath of a listed package (`@modelcontextprotocol/server/stdio`) is
 * covered by one entry.
 *
 *   (`@modelcontextprotocol/sdk` — the v1 SDK — was REMOVED from this list by
 *   task 049 along with the dependency itself. It was a declared owner with no
 *   live import site, which is precisely the stale-cover condition the census
 *   fails on; leaving it would have been an allowlist entry vouching for a
 *   package that is not installed.)
 *
 *   - `@modelcontextprotocol/client` — the v2 MCP client package, added by task
 *     049 so the integration proofs could drive a v2 server without a
 *     cross-generation transport pair. The judgement is the same shape as the
 *     `server` entry and just as checkable: the seam draws exactly `Client` and
 *     `StdioClientTransport`, and `connectV2Client` accepts only a branded
 *     `V2Transport`, of which the seam constructs only stdio and in-memory
 *     halves. The package's network-capable surface —
 *     `SSEClientTransport`, `StreamableHTTPClientTransport`, `withOAuth`,
 *     `auth`, `createFetchWithInit` and the OAuth discovery/token helpers — is
 *     not re-exported and therefore unreachable from shipped code. Re-exporting
 *     any of those invalidates this entry and requires an `EFFECT_OWNERSHIP`
 *     rule naming the owner.
 *   - `@modelcontextprotocol/server` — the v2 MCP server package, reached ONLY
 *     through the owned SDK seam (`contract/sdk/seam.ts`, DR-26). The same judgement as
 *     v1 applies, and here it is narrower and checkable: the seam re-exports
 *     `McpServer`, `Server`, `InMemoryTransport` and `StdioServerTransport` and
 *     nothing else. The package's network-capable surface —
 *     `WebStandardStreamableHTTPServerTransport`,
 *     `PerRequestHTTPServerTransport`, `createMcpHandler`, `requireBearerAuth`,
 *     `createFetchWithInit` and the OAuth-metadata helpers — is not re-exported
 *     and therefore unreachable from shipped code. If the seam ever re-exports
 *     one of those, this entry stops being true and must be replaced by an
 *     `EFFECT_OWNERSHIP` rule naming the owner.
 *   - `@modelcontextprotocol/core` — VETTED by DR-0 / task 051, which is the
 *     first shipped import of it. The list's prior note said core was omitted
 *     because nothing imported it, and that the census would fail loudly on the
 *     first import; it did exactly that, and this entry is the human vetting act
 *     it demanded rather than a silencing of it.
 *     The judgement is narrower than the `server` entry, and checkable the same
 *     way: `contract/sdk/seam.ts` draws exactly ONE symbol from core — `TaskStatusSchema`,
 *     a Zod enum of five string literals, read once at module scope for
 *     `V2_TASK_STATUS_VALUES`. Core's network-capable surface (`createFetchWithInit`,
 *     the OAuth client/metadata helpers, `SdkHttpError`) is not imported and not
 *     re-exported, so it is unreachable from shipped code. Widening that single
 *     import invalidates this entry and requires an `EFFECT_OWNERSHIP` rule
 *     naming the owner.
 *   - `better-sqlite3` — embedded file-backed SQLite driver; the filesystem
 *     effect it performs is already owned at `storage/` granularity. (The
 *     `bun:sqlite` sibling needs no entry: it carries a builtin SCHEME and is
 *     judged by {@link BUILTIN_SCHEME}, never by this allowlist.)
 *   - `commander`  — argv parser; pure string/AST work.
 *   - `gray-matter`— front-matter parser over a string the caller already read.
 *   - `pino`       — structured logger writing to an injected stream.
 *   - `vitest`     — the type-test / GWT-harness DSL imported by shipped
 *                    `*.type-test.ts` and `projections/gwt.ts`; test infra.
 *   - `yaml`, `yazl`, `zod` — YAML codec, in-memory zip writer, schema
 *                    validator. All pure data transforms.
 */
export const INERT_DEPENDENCIES: ReadonlySet<string> = new Set([
  '@modelcontextprotocol/client',
  '@modelcontextprotocol/core',
  '@modelcontextprotocol/server',
  'better-sqlite3',
  'commander',
  'gray-matter',
  'pino',
  'vitest',
  'yaml',
  'yazl',
  'zod',
]);

/**
 * The npm package name of a bare specifier: `@scope/pkg/sub/x.js` → `@scope/pkg`,
 * `pkg/sub` → `pkg`. Used so allowlist membership is per package, not per
 * subpath.
 */
export function packageNameOf(spec: string): string {
  const parts = spec.split('/');
  if (spec.startsWith('@')) return parts.slice(0, 2).join('/');
  return parts[0] ?? spec;
}

/**
 * Classify an import specifier to an effect class, or undefined if inert.
 * Returns the `evidence` string alongside the class so the closed-world rule can
 * mark itself as a conservative judgement (`unvetted-dependency:<pkg>`) rather
 * than masquerading as a named network primitive.
 *
 * Order matters: remote URLs first, then builtin schemes and builtin names (so
 * `bun:sqlite` and a bare `util` are inert, not "unvetted"), then relative
 * in-repo paths (inert — the imported module is scanned on its own account),
 * then the curated client set, then the closed-world fallback.
 */
export function classifySpecifier(
  spec: string,
): { readonly effectClass: EffectClass; readonly evidence: string } | undefined {
  const network = (evidence: string): { effectClass: EffectClass; evidence: string } => ({
    effectClass: 'network',
    evidence,
  });

  if (REMOTE_URL_SPEC.test(spec)) return network(spec);

  const scheme = BUILTIN_SCHEME.exec(spec);
  const bare = scheme === null ? spec : spec.slice(scheme[0].length);
  const head = packageNameOf(bare);
  if (scheme !== null || NODE_BUILTINS.has(head)) {
    if (FS_SPEC.test(bare)) return { effectClass: 'filesystem', evidence: spec };
    if (PROCESS_SPEC.test(bare)) return { effectClass: 'process', evidence: spec };
    if (NETWORK_BUILTIN.test(bare)) return network(spec);
    return undefined;
  }

  // Relative / absolute in-repo paths: the target module is scanned separately
  // and owns its own effects (attribution is per module, never transitive).
  if (spec.startsWith('.') || spec.startsWith('/')) return undefined;

  const pkg = packageNameOf(spec);
  if (THIRD_PARTY_NETWORK_CLIENTS.has(pkg)) return network(spec);
  if (INERT_DEPENDENCIES.has(pkg)) return undefined;
  return network(`unvetted-dependency:${pkg}`);
}

/** One import/export specifier occurrence at code position. */
export interface ImportRef {
  /** The literal specifier text (`node:fs`, `./x.js`, `axios`). */
  readonly specifier: string;
  /**
   * True for `import type … from '…'`, `export type … from '…'`,
   * `import T = require('…')` in type position, and an `import('…')` TYPE QUERY.
   * All are fully erased at compile time and carry NO runtime binding, so they
   * perform no effect — `import type { Server } from 'node:http'` is not a
   * network site.
   *
   * A per-specifier `type` modifier (`import { type A, connect } from '…'`) does
   * NOT set this: the statement still emits, so it is charged as a value import.
   * That is the fail-closed direction.
   */
  readonly typeOnly: boolean;
}

/**
 * Everything about ONE module's lexical structure that this census needs and
 * that only a real parse can answer.
 */
export interface LexedModule {
  /**
   * Every module specifier the module actually imports or re-exports, in source
   * order. A specifier inside a comment, a string or a template literal is not
   * an import NODE, so it is absent BY CONSTRUCTION rather than by filtering.
   */
  readonly imports: readonly ImportRef[];
  /**
   * `source` with every comment, string literal, template-literal TEXT part and
   * regex literal blanked to spaces (newlines preserved, offsets aligned), so
   * the ambient-shape rules see only real code.
   *
   * A `${…}` substitution IS code and is deliberately not blanked. That is the
   * one place the retired heuristic's "mask the template whole" rule was both
   * wrong — it un-masked the body of a NESTED template, which is the false
   * positive recorded in the module header — and needlessly blind.
   */
  readonly maskedSource: string;
}

/**
 * The lexer port. See the module header for why this is a REQUIRED parameter
 * everywhere it appears rather than something this module does for itself, and
 * for the two measured defects that made the inversion necessary.
 *
 * `fileName` reaches the implementation's diagnostics only; it has no effect on
 * the answer.
 */
export type ModuleLexer = (source: string, fileName?: string) => LexedModule;

/**
 * The specifiers `lex` resolved for `source`.
 *
 * An ACCESSOR, not a lexer: it holds no knowledge of TypeScript's grammar and
 * must never re-acquire any. Retained under its pre-065 name because that is
 * what the DR-13 pins and the sibling censuses bind to.
 */
export function extractImports(source: string, lex: ModuleLexer): readonly ImportRef[] {
  return lex(source).imports;
}

/**
 * Every module specifier at code position, type-only ones included.
 *
 * `layer-boundaries-seam.ts` depends on the full import surface — a type-only
 * cross-layer import is still a layer edge, and so is an `import('…')` type
 * query. The effect scan filters to value imports itself.
 */
export function extractImportSpecifiers(source: string, lex: ModuleLexer): string[] {
  return lex(source).imports.map((ref) => ref.specifier);
}

/**
 * `source` with every non-code span blanked — see {@link LexedModule.maskedSource}.
 *
 * The same kind of accessor as {@link extractImports}, retained for the same
 * reason. Before task 065 this was a SECOND hand-rolled lexer, a near-duplicate
 * of the first, and the two could drift apart silently; on a nested template
 * they were in fact wrong in the same way at the same time. One port answers
 * both questions from one parse, so they can no longer disagree.
 */
export function maskNonCode(source: string, lex: ModuleLexer): string {
  return lex(source).maskedSource;
}

/**
 * Ambient network globals reached WITHOUT an import (DR-13 rule 5). Judged on
 * {@link maskNonCode} output, so a token in a string, comment or regex literal
 * never counts.
 *
 * Each rule is a SHAPE, not a bare token, and each is false-positive-free on the
 * live tree for a stated reason:
 *
 *   - `fetch(`               — a call. `fetchPrData(` / `getOrFetchRoots(` do
 *                              not match (the negative lookahead requires a
 *                              non-identifier after `fetch`, and the lookbehind
 *                              rejects a `.fetch` member call).
 *   - `<globalRoot>.<global>` — the reflective escape hatch, for EVERY spelling
 *                              of the global object: `globalThis`, `global`
 *                              (Node), `self` (workers), `window`. A
 *                              literal-`globalThis` rule was an open evasion —
 *                              `global.fetch(url)` scanned clean because rule 1
 *                              rejects `.fetch` member calls and nothing else
 *                              matched. The live tree contains none of these.
 *   - `= fetch`              — the alias binding DR-13 names (`const f = fetch`,
 *                              `const f = fetch.bind(globalThis)`). Requires
 *                              `fetch` immediately after `=`, so
 *                              `= client.fetch` and `= fetchPrData(…)` do not
 *                              match.
 *   - `{ … fetch … } = <globalRoot>` — the destructured form, over the same
 *                              global-object spellings as the member-access rule.
 *   - `new WebSocket(`       — an ambient socket client, the import-free
 *                              equivalent of the `ws` package.
 *
 * A bare `fetch` identifier rule was deliberately REJECTED: it matches ordinary
 * property keys (`{ fetch: … }`) and interface members, which would make the
 * ratchet unusable. That gap is stated in the module's trust boundary.
 */
const AMBIENT_NETWORK_RULES: readonly { readonly re: RegExp; readonly evidence: string }[] = [
  { re: /(?<![\w$.])fetch\s*\(/, evidence: 'fetch' },
  {
    re: /(?<![\w$.])(?:globalThis|global|self|window)\s*\.\s*(?:fetch|WebSocket|EventSource|XMLHttpRequest)(?![\w$])/,
    evidence: 'globalThis.fetch',
  },
  { re: /=\s*fetch(?![\w$])/, evidence: 'fetch (aliased binding)' },
  {
    re: /\{[^{}]*(?<![\w$.])fetch(?![\w$])[^{}]*\}\s*=\s*(?:globalThis|global|self|window)(?![\w$])/,
    evidence: 'fetch (destructured from globalThis)',
  },
  {
    re: /(?<![\w$.])new\s+(?:WebSocket|EventSource|XMLHttpRequest)\s*\(/,
    evidence: 'new WebSocket',
  },
];

/**
 * Bun's ambient runtime object performs I/O with NO import at all, so the
 * import-surface rules (1–4) never see it and the fetch-shaped ambient rules
 * above cover only the network class. Each rule is a member-CALL shape rooted
 * at the `Bun` identifier (optionally reached through a global-object root),
 * judged on {@link maskNonCode} output — `myBun.serve(` and a `Bun.spawn`
 * inside a string/comment never match:
 *
 *   - `Bun.serve(` / `Bun.connect(` / `Bun.listen(` / `Bun.udpSocket(`
 *     — sockets (server and client) → network.
 *   - `Bun.spawn(` / `Bun.spawnSync(` — child processes → process.
 *   - `Bun.write(` / `Bun.file(` — filesystem I/O → filesystem.
 */
const AMBIENT_BUN_RULES: readonly {
  readonly re: RegExp;
  readonly evidence: string;
  readonly effectClass: EffectClass;
}[] = [
  {
    re: /(?<![\w$.])(?:(?:globalThis|global|self|window)\s*\.\s*)?Bun\s*\.\s*(?:serve|connect|listen|udpSocket)\s*\(/,
    evidence: 'Bun.serve',
    effectClass: 'network',
  },
  {
    re: /(?<![\w$.])(?:(?:globalThis|global|self|window)\s*\.\s*)?Bun\s*\.\s*spawn(?:Sync)?\s*\(/,
    evidence: 'Bun.spawn',
    effectClass: 'process',
  },
  {
    re: /(?<![\w$.])(?:(?:globalThis|global|self|window)\s*\.\s*)?Bun\s*\.\s*(?:write|file)\s*\(/,
    evidence: 'Bun.write',
    effectClass: 'filesystem',
  },
];

/**
 * Enumerate the distinct effect classes a single module performs. Deduped to one
 * occurrence per (module, class): ownership is per module, so a module that reads
 * fs twice is one filesystem occurrence.
 *
 * One `lex` call answers both halves — which specifiers are imports, and which
 * characters are code — so the import surface and the ambient-shape surface can
 * never be judged against two different readings of the same file.
 *
 * @param module Repo-relative module path, reported on the occurrence.
 * @param source Module source text.
 * @param lex    The lexer port. Required; see {@link ModuleLexer}.
 */
export function detectModuleEffects(
  module: string,
  source: string,
  lex: ModuleLexer,
): EffectOccurrence[] {
  const found = new Map<EffectClass, string>();
  const lexed = lex(source, module);

  for (const ref of lexed.imports) {
    // Type-only imports are erased at compile time — no runtime binding, no
    // effect. `import type { Server } from 'node:http'` is not a network site.
    if (ref.typeOnly) continue;
    const hit = classifySpecifier(ref.specifier);
    if (hit !== undefined && !found.has(hit.effectClass)) {
      found.set(hit.effectClass, hit.evidence);
    }
  }

  // Ambient globals (no import) are effects too — judged on fully masked
  // source so a token in a string/comment/regex is not counted. The fetch
  // shaped rules cover only the network class; the Bun ambient rules span all
  // three classes, so they are checked per-class.
  if (
    !found.has('network') ||
    !found.has('process') ||
    !found.has('filesystem')
  ) {
    const masked = lexed.maskedSource;
    if (!found.has('network')) {
      const ambient = AMBIENT_NETWORK_RULES.find((r) => r.re.test(masked));
      if (ambient !== undefined) found.set('network', ambient.evidence);
    }
    for (const rule of AMBIENT_BUN_RULES) {
      if (!found.has(rule.effectClass) && rule.re.test(masked)) {
        found.set(rule.effectClass, rule.evidence);
      }
    }
  }

  return [...found.entries()]
    .map(([effectClass, evidence]) => ({ module, effectClass, evidence }))
    .sort((a, b) => (a.effectClass < b.effectClass ? -1 : 1));
}

async function collectScannableFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name));
      } else if (entry.isFile() && isScannableFile(entry.name)) {
        files.push(join(dir, entry.name));
      }
    }
  };
  await walk(root);
  return files.sort();
}

/**
 * Scan the shipped source under `sourceRoot` and return every effect occurrence
 * ALONGSIDE the two denominators that say whether the occurrence set means
 * anything: how many modules the walk visited, and how many module specifiers
 * `lex` resolved across all of them.
 *
 * The counts are collected here rather than derived later because this is the
 * only place that sees the population. Downstream, an empty occurrence array is
 * indistinguishable from a broken walk or a lexer that resolved nothing — and
 * both of those read as "the tree performs no unowned effect", which is a pass.
 */
export async function scanEffectTree(
  sourceRoot: string,
  lex: ModuleLexer,
): Promise<EffectScan> {
  const files = await collectScannableFiles(sourceRoot);
  const perFile = await Promise.all(
    files.map(async (file) => {
      const module = relative(sourceRoot, file).replaceAll('\\', '/');
      const source = await readFile(file, 'utf8');
      return {
        occurrences: detectModuleEffects(module, source, lex),
        specifierCount: lex(source, module).imports.length,
      };
    }),
  );
  return Object.freeze({
    occurrences: Object.freeze(
      perFile.flatMap((entry) => entry.occurrences).sort((a, b) =>
        a.module === b.module
          ? a.effectClass < b.effectClass
            ? -1
            : 1
          : a.module < b.module
            ? -1
            : 1,
      ),
    ),
    moduleCount: files.length,
    specifierCount: perFile.reduce((sum, entry) => sum + entry.specifierCount, 0),
  });
}

/**
 * Just the occurrences from {@link scanEffectTree}, for the sibling censuses
 * (`effect-port-seam`, `adapter-ownership-seam`) whose own verdicts range over
 * occurrences and carry their own denominators.
 */
export async function scanEffectOccurrences(
  sourceRoot: string,
  lex: ModuleLexer,
): Promise<readonly EffectOccurrence[]> {
  return (await scanEffectTree(sourceRoot, lex)).occurrences;
}

// ─── Ownership model ────────────────────────────────────────────────────────

/** Does `rule` claim `occurrence`? */
export function ruleClaims(rule: EffectOwnershipRule, occurrence: EffectOccurrence): boolean {
  if (rule.effectClass !== occurrence.effectClass) return false;
  if (rule.match.endsWith('/')) return occurrence.module.startsWith(rule.match);
  return occurrence.module === rule.match;
}

/**
 * Pure census verdict over an already-collected scan and rule set.
 *
 * Four independent, complementary checks, each with its own diagnostic:
 *   - INDETERMINATE_OWNER        — an occurrence no rule claims;
 *   - STALE_OWNERSHIP            — a rule that claims no occurrence (phantom cover);
 *   - EMPTY_MODULE_POPULATION    — the walk visited no modules at all, so every
 *     count below it is zero for a reason that has nothing to do with the tree
 *     (moved scan root, renamed package directory, broken walker);
 *   - EMPTY_SPECIFIER_DENOMINATOR — modules were visited but the lexer resolved
 *     no module specifier in ANY of them. Since task 065 the lexer is a
 *     caller-supplied port ({@link ModuleLexer}), so a caller can pass one that
 *     silently answers nothing; the import half of the detector would then see
 *     an empty surface everywhere and the ambient half would carry the census
 *     alone. No real source tree imports nothing.
 *
 * The last two are the non-empty-denominator teeth. They exist because the
 * SUCCESS state of this census is "no diagnostics", which is also what a
 * completely broken instrument produces. The `STALE_OWNERSHIP` tooth happens to
 * cover the live tree today (40-odd rules would all go stale), but only because
 * the live rule set is non-empty — it is coincidental cover, not a denominator.
 */
export function runEffectLedgerCensus(
  scan: EffectScan,
  rules: readonly EffectOwnershipRule[] = EFFECT_OWNERSHIP,
): EffectLedgerResult {
  const diagnostics: EffectLedgerDiagnostic[] = [];
  const occurrences = scan.occurrences;

  if (scan.moduleCount <= 0) {
    diagnostics.push({
      code: 'EMPTY_MODULE_POPULATION',
      message:
        'The effect ledger census visited ZERO modules. Every count it reports is ' +
        'therefore zero for a reason unrelated to the tree — a moved scan root, a ' +
        'renamed package directory or a broken walker all present this way, and all ' +
        'three read as "no unowned effect", which is a pass. Reported as a failure ' +
        'instead (DR-26 non-empty denominator).',
    });
  } else if (scan.specifierCount <= 0) {
    diagnostics.push({
      code: 'EMPTY_SPECIFIER_DENOMINATOR',
      message:
        `The effect ledger census visited ${scan.moduleCount} module(s) but the lexer ` +
        'resolved ZERO module specifiers across all of them. Import-shape rules 1–4 ' +
        'therefore ranged over nothing, so the only evidence still reaching the verdict ' +
        'is the ambient-shape half. A lexer that answers nothing looks exactly like a ' +
        'tree that imports nothing, and no real source tree imports nothing. Reported ' +
        'as a failure rather than a clean scan (DR-26 non-empty denominator).',
    });
  }

  for (const occurrence of occurrences) {
    const owned = rules.some((rule) => ruleClaims(rule, occurrence));
    if (!owned) {
      diagnostics.push({
        code: 'INDETERMINATE_OWNER',
        module: occurrence.module,
        effectClass: occurrence.effectClass,
        evidence: occurrence.evidence,
        message:
          `Module "${occurrence.module}" performs a ${occurrence.effectClass} effect ` +
          `(via "${occurrence.evidence}") that no ownership rule claims. Every effect ` +
          `must have one typed owner — declare it in EFFECT_OWNERSHIP.`,
      });
    }
  }

  for (const rule of rules) {
    const claimsSomething = occurrences.some((occurrence) => ruleClaims(rule, occurrence));
    if (!claimsSomething) {
      diagnostics.push({
        code: 'STALE_OWNERSHIP',
        effectClass: rule.effectClass,
        match: rule.match,
        owner: rule.owner,
        message:
          `Ownership rule for ${rule.effectClass} "${rule.match}" (owner "${rule.owner}") ` +
          `claims no live effect occurrence — stale cover. Remove it or restore the effect.`,
      });
    }
  }

  return Object.freeze({
    ok: diagnostics.length === 0,
    moduleCount: scan.moduleCount,
    specifierCount: scan.specifierCount,
    occurrenceCount: occurrences.length,
    diagnostics,
  });
}

/**
 * Collect the live scan and return the census verdict over the real tree.
 *
 * @param sourceRoot Directory to walk.
 * @param lex        The lexer port. Required; see {@link ModuleLexer}.
 * @param rules      Ownership rules; defaults to the declared ledger.
 */
export async function auditEffectOwnership(
  sourceRoot: string,
  lex: ModuleLexer,
  rules: readonly EffectOwnershipRule[] = EFFECT_OWNERSHIP,
): Promise<EffectLedgerResult> {
  return runEffectLedgerCensus(await scanEffectTree(sourceRoot, lex), rules);
}

// ─── The declared effect ledger ─────────────────────────────────────────────
//
// One entry per (effectClass, module-or-layer). Process and network are declared
// at owner granularity (the crisp "one typed owner" surface); filesystem
// persistence is declared at layer granularity. Adding a new effect site to a
// layer with no rule fails the census until an owner is consciously declared.

const rule = (
  effectClass: EffectClass,
  match: string,
  owner: string,
  idempotency: string,
  compensation: string,
): EffectOwnershipRule => ({ effectClass, match, owner, idempotency, compensation });

/**
 * The effect ownership ledger — the census's single source of truth for who owns
 * each effect. Populated in {@link registerLedger} against the live tree.
 */
export const EFFECT_OWNERSHIP: readonly EffectOwnershipRule[] = registerLedger();

function registerLedger(): readonly EffectOwnershipRule[] {
  return Object.freeze([
    // ── network (crisp: exact modules) ──────────────────────────────────────
    rule(
      'network',
      'workflow/feedback.ts',
      'workflow-feedback-network',
      'idempotent: feedback read/post keyed by operation marker',
      'marker-scan reconciliation dedupes a retried post',
    ),

    // ── process (owner granularity) ─────────────────────────────────────────
    rule(
      'process',
      'utils/process.ts',
      'process-spawn-primitive',
      'boundary: the single cross-OS spawn primitive; callers own idempotency',
      'supervised child exposes kill() for teardown',
    ),
    rule(
      'process',
      'vcs/',
      'vcs-process-owner',
      'idempotent: git/gh reads; writes guarded by the VCS provider',
      'VCS provider surfaces failures; no partial local state',
    ),
    rule(
      'process',
      'workflow/compensation.ts',
      'compensation-process-owner',
      'idempotent: teardown re-run is a no-op when already absent',
      'this IS the compensation effect (saga repair)',
    ),
    rule(
      'process',
      'verbs/',
      'orchestrate-process-owner',
      'per-call: orchestrate probes/gates own their re-run semantics',
      'orchestrate saga steps carry their own compensation',
    ),
    rule(
      'process',
      'config/',
      'config-probe-owner',
      'idempotent: config toolchain probes are read-only',
      'none: probes mutate no state',
    ),
    rule(
      'process',
      'hooks/',
      'hook-process-owner',
      'best-effort: hook subprocesses are side-channel',
      'none: hooks are advisory, not on the compensation path',
    ),
    rule(
      'process',
      'launcher/',
      'launcher-process-owner',
      'idempotent: teardown/liveness probes tolerate re-run',
      'launcher lifecycle owns child kill/teardown',
    ),
    rule(
      'process',
      'lifecycle/',
      'cli-process-owner',
      'per-command: CLI verification runners own re-run semantics',
      'none: verification is read-only over the worktree',
    ),

    // ── filesystem (layer granularity) ──────────────────────────────────────
    rule('filesystem', 'index.ts', 'server-entry-fs', 'startup read-only', 'none'),
    rule(
      'filesystem',
      'storage/artifacts/',
      'artifact-store-fs',
      'content-addressed: idempotent by digest',
      'orphan artifacts are GC-swept; no compensation needed',
    ),
    rule(
      'filesystem',
      'storage/',
      'storage-layer-fs',
      'atomic writes; idempotent by key',
      'atomic rename leaves no partial state',
    ),
    rule(
      'filesystem',
      'events/',
      'event-store-fs',
      'append-only; sequence-guarded idempotency',
      'atomic append; a failed append leaves the log unchanged',
    ),
    rule(
      'filesystem',
      'config/',
      'config-load-fs',
      'read-only config load; idempotent',
      'none: config reads mutate nothing',
    ),
    rule(
      'filesystem',
      'verbs/',
      'orchestrate-fs',
      'worktree/state writes carry saga idempotency',
      'orchestrate compensation reverses worktree/state writes',
    ),
    rule(
      'filesystem',
      'workflow/',
      'workflow-fs',
      'state writes guarded by state-retry',
      'workflow compensation reverses partial writes',
    ),
    rule(
      'filesystem',
      'architecture/',
      'architecture-scan-fs',
      'read-only static scans; idempotent',
      'none: scans mutate nothing',
    ),
    rule(
      'filesystem',
      'projections/session/',
      'session-fs',
      'session state writes; idempotent by session id',
      'session teardown removes state',
    ),
    rule(
      'filesystem',
      'projections/',
      'projection-fs',
      'derived read-model writes; rebuildable from the log',
      'projection rebuild reconstructs state',
    ),
    rule(
      'filesystem',
      'projections/views/',
      'view-fs',
      'read-only derived views; idempotent',
      'none: views are derived',
    ),
    rule('filesystem', 'dispatch/core/', 'core-fs', 'read-only bootstrap/context', 'none'),
    rule('filesystem', 'utils/', 'utils-fs', 'pure fs helpers; caller owns idempotency', 'caller-owned'),
    rule('filesystem', 'lib/', 'lib-fs', 'pure fs helpers; caller owns idempotency', 'caller-owned'),
    rule('filesystem', 'launcher/', 'launcher-fs', 'startup/teardown fs; idempotent', 'launcher teardown'),
    rule('filesystem', 'agents/', 'agents-fs', 'agent definition reads; read-only', 'none'),
    rule('filesystem', 'sync/', 'sync-fs', 'outbox writes; idempotent by op id', 'outbox reconciliation'),
    rule('filesystem', 'runtime/', 'runtime-fs', 'runtime resource reads; read-only', 'none'),
    rule('filesystem', 'projections/telemetry/', 'telemetry-fs', 'append-only telemetry; best-effort', 'none: telemetry is advisory'),
    rule('filesystem', 'workflow/topology/', 'topology-fs', 'topology reads; read-only', 'none'),
    rule('filesystem', 'lifecycle/', 'cli-fs', 'worktree reads/writes; per-command', 'none: read-mostly'),
    rule('filesystem', 'adapters/', 'adapters-fs', 'adapter io; caller owns idempotency', 'caller-owned'),
    rule('filesystem', 'onramp/', 'onramp-fs', 'onboarding scaffold writes; idempotent', 'scaffold is re-runnable'),
    rule('filesystem', 'workspace/', 'workspace-fs', 'workspace reads/writes; idempotent by path', 'caller-owned'),
    rule(
      'filesystem',
      'contract/',
      'contract-authority-fs',
      'authority digests recomputed from content; lock writes are whole-file replacements',
      'a failed lock write leaves the previous approved lock intact',
    ),
    rule(
      'filesystem',
      'extensions/',
      'extension-trust-fs',
      'version-ledger high-water marks advance monotonically; re-record is a no-op',
      'a corrupt or failed ledger write fails closed and blocks admission',
    ),
    rule(
      'filesystem',
      'install/',
      'install-identity-fs',
      'identity collection is read-only; the TOFU lock write is a whole-file replacement',
      'a failed lock write leaves the previous recorded identity intact',
    ),
    rule(
      'filesystem',
      'release/',
      'release-manifest-fs',
      'manifest/asset reads are content-addressed and idempotent',
      'verification is read-only; a rejected release publishes nothing',
    ),
  ]);
}

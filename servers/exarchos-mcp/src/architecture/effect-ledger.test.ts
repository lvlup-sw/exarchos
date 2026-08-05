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
  maskNonCode,
  packageNameOf,
  classifySpecifier,
  scanEffectOccurrences,
  ruleClaims,
  isScannableFile,
  EFFECT_OWNERSHIP,
  EXCLUDED_DIRS,
  INERT_DEPENDENCIES,
  type EffectLedgerDiagnostic,
  type EffectOccurrence,
  type EffectOwnershipRule,
} from './effect-ledger.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('detectModuleEffects', () => {
  it('classifies fs / process / network imports', () => {
    const occ = detectModuleEffects(
      'x/y.ts',
      `import { readFile } from 'node:fs/promises';
       import { execFile } from 'node:child_process';
       import net from 'node:net';`,
    );
    const classes = occ.map((o) => o.effectClass).sort();
    expect(classes).toEqual(['filesystem', 'network', 'process']);
  });

  it('detects a global fetch as a network effect', () => {
    const occ = detectModuleEffects('x/y.ts', `export async function f() { return fetch('http://x'); }`);
    expect(occ.map((o) => o.effectClass)).toContain('network');
  });

  it('does NOT classify a specifier that only appears in a comment or string', () => {
    const occ = detectModuleEffects(
      'x/y.ts',
      `// import { x } from 'node:fs';\nconst s = "from 'node:child_process'"; export const y = 1;`,
    );
    expect(occ).toHaveLength(0);
  });

  it('dedupes multiple fs imports into one filesystem occurrence', () => {
    const occ = detectModuleEffects(
      'x/y.ts',
      `import { readFile } from 'node:fs/promises';\nimport { existsSync } from 'node:fs';`,
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
    const result = runEffectLedgerCensus(occ, rules);
    expect(result.ok).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain('INDETERMINATE_OWNER');
    const indeterminate = result.diagnostics.find((d) => d.code === 'INDETERMINATE_OWNER');
    expect(indeterminate && 'module' in indeterminate && indeterminate.module).toBe('mystery/rogue.ts');
  });

  it('flags a rule that claims nothing as STALE_OWNERSHIP', () => {
    const result = runEffectLedgerCensus([], rules);
    expect(result.diagnostics.map((d) => d.code)).toContain('STALE_OWNERSHIP');
  });

  it('passes when every occurrence is claimed and every rule claims something', () => {
    const occ: EffectOccurrence[] = [
      { module: 'vcs/shell.ts', effectClass: 'process', evidence: 'node:child_process' },
    ];
    expect(runEffectLedgerCensus(occ, rules).ok).toBe(true);
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
    const result = await auditEffectOwnership(SRC_ROOT);
    // Surfacing the diagnostics array makes any regression self-describing.
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.occurrenceCount).toBeGreaterThan(0);
  });

  it('(b) a planted unowned effect FAILS the census against the live rules', async () => {
    const occurrences = await scanEffectOccurrences(SRC_ROOT);
    const planted: EffectOccurrence = {
      module: 'channel/rogue-emitter.ts',
      effectClass: 'filesystem',
      evidence: 'node:fs',
    };
    const result = runEffectLedgerCensus([...occurrences, planted], EFFECT_OWNERSHIP);
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

/** The owner-shaped module planted in every fixture so no STALE_OWNERSHIP noise. */
const OWNER_MODULE = 'owner/network-client.ts';
const OWNER_SOURCE = `
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
    const result = await auditEffectOwnership(root, SCOPED_RULES);
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

    const result = await auditEffectOwnership(root, SCOPED_RULES);

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

    const result = await auditEffectOwnership(root, SCOPED_RULES);

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

    const result = await auditEffectOwnership(root, SCOPED_RULES);

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
      // orchestrate/validate-pr-body.ts — an identifier that merely STARTS with
      // fetch; and workspace/discovery.ts — one that merely contains "Fetch".
      'orchestrate/validate-pr-body.ts': `
        function fetchPrData(pr: number): number { return pr; }
        async function getOrFetchRoots(): Promise<number> { return 1; }
        export const data = fetchPrData(1) + (await getOrFetchRoots());
      `,
      // contract/oracle/fixtures.ts — an effect RECORD naming a fetch URL.
      'contract/oracle/fixtures.ts': `
        export const record = (ctx: { effects: { record: (a: string, b: string) => void } }): void =>
          ctx.effects.record('network', 'fetch:https://exfil.example/telemetry');
      `,
      // orchestrate/mock-boundary.ts — doc comment naming a bare specifier.
      'orchestrate/mock-boundary.ts': `
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
      expect(detectModuleEffects(module, source), `${module} must yield no occurrence`).toEqual([]);
    }

    // Integration-level: a whole tree of them, with a real owner, stays GREEN.
    const root = await plant({ ...incidental, [OWNER_MODULE]: OWNER_SOURCE });
    const result = await auditEffectOwnership(root, SCOPED_RULES);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('EffectLedger_TypeOnlyNetworkImport_YieldsNoOccurrence', async () => {
    // Focused pin for the type-only guard on its own, so it cannot be masked by
    // a sibling expectation in the false-positive sweep above.
    expect(detectModuleEffects('x/y.ts', `import type { Server } from 'node:http2';`)).toEqual([]);
    expect(detectModuleEffects('x/y.ts', `export type { Socket } from 'node:net';`)).toEqual([]);
    expect(detectModuleEffects('x/y.ts', `import type Axios from 'axios';`)).toEqual([]);
    // …but the VALUE form of the very same specifier is still an effect site.
    expect(detectModuleEffects('x/y.ts', `import { connect } from 'node:http2';`)).toEqual([
      { module: 'x/y.ts', effectClass: 'network', evidence: 'node:http2' },
    ]);
    // A `type` modifier must not leak across statements.
    const mixed = `export type Foo = number;\nimport got from 'got';`;
    expect(detectModuleEffects('x/y.ts', mixed).map((o) => o.evidence)).toEqual(['got']);

    const root = await plant({
      [OWNER_MODULE]: OWNER_SOURCE,
      'types/net.ts': `
        import type { Http2Session } from 'node:http2';
        export type Session = Http2Session | null;
      `,
    });
    const result = await auditEffectOwnership(root, SCOPED_RULES);
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
    expect(extractImports(sameLine)).toEqual([]);
    expect(detectModuleEffects('architecture/detector.ts', sameLine)).toEqual([]);

    // The conservative heuristic's known blind spot: `return /…/` scores the `/`
    // as division (previous significant char is `n`), so regex mode is NOT
    // entered. Line-bounded `'`/`"` are what stop the resulting phantom string
    // from running past end-of-line and dragging later lines into the scan.
    const blindSpot = [
      `export function isQuote(x: string): boolean { return /(['"])/.test(x); }`,
      `// historical: import axios from 'axios';`,
      `import { connect } from 'node:http2';`,
    ].join('\n');
    expect(extractImports(blindSpot).map((r) => r.specifier)).toEqual(['node:http2']);
    expect(detectModuleEffects('x/y.ts', blindSpot).map((o) => o.evidence)).toEqual(['node:http2']);

    // Same for a same-line BLOCK comment.
    const blockSameLine =
      "const RE = /(['\"`])x\\1/; /* was: import axios from 'axios' */ export const a = 1;";
    expect(detectModuleEffects('architecture/detector.ts', blockSameLine)).toEqual([]);

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
    expect(maskNonCode(selfShape)).not.toContain('fetch');
    expect(detectModuleEffects('architecture/effect-ledger.ts', selfShape)).toEqual([]);

    // A `/` in DIVISION position must NOT be mistaken for a regex opener — that
    // would swallow real code and cause a false NEGATIVE (the dangerous
    // direction for a ratchet).
    const division = `const ratio = total / count;\nimport { connect } from 'node:http2';`;
    expect(detectModuleEffects('x/y.ts', division).map((o) => o.evidence)).toEqual(['node:http2']);
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
    expect(detectModuleEffects('x/reporter.ts', injected)).toEqual([]);

    // 2. COMPUTED / STRING-INDEXED GLOBAL ACCESS — undecidable in general.
    const computed = `
      const g = globalThis as unknown as Record<string, (u: string) => Promise<unknown>>;
      const key = 'fet' + 'ch';
      export const go = (url: string): Promise<unknown> => (g[key] as (u: string) => Promise<unknown>)(url);
    `;
    expect(detectModuleEffects('x/computed.ts', computed)).toEqual([]);

    // 3. OBJECT SHORTHAND — excluded on purpose: a bare `fetch` identifier rule
    //    false-positives on ordinary property keys and interface members, which
    //    would make the ratchet unusable. Both shapes below must stay inert.
    expect(detectModuleEffects('x/keys.ts', `export const c = { fetch: 1, post: 2 };`)).toEqual([]);
    expect(
      detectModuleEffects('x/iface.ts', `export interface Deps { fetch: (u: string) => void }`),
    ).toEqual([]);
  });

  it('EffectLedger_ClosedWorldAllowlist_IsPerPackageNotPerSubpath', () => {
    // `@modelcontextprotocol/sdk/server/mcp.js` must be covered by the ONE
    // `@modelcontextprotocol/sdk` allowlist entry, or every SDK subpath would be
    // an unvetted dependency and the live tree would go red.
    expect(packageNameOf('@modelcontextprotocol/sdk/server/mcp.js')).toBe(
      '@modelcontextprotocol/sdk',
    );
    expect(packageNameOf('gray-matter')).toBe('gray-matter');
    expect(packageNameOf('yaml/dist/x.js')).toBe('yaml');

    expect(classifySpecifier('@modelcontextprotocol/sdk/types.js')).toBeUndefined();
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
    const result = await auditEffectOwnership(SRC_ROOT);
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
    const result = await auditEffectOwnership(SRC_ROOT, [...EFFECT_OWNERSHIP, phantom]);
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
      for (const ref of extractImports(await readFile(file, 'utf8'))) {
        const hit = classifySpecifier(ref.specifier);
        if (hit !== undefined && hit.evidence.startsWith('unvetted-dependency:')) {
          unvetted.add(`${hit.evidence} (${file})`);
        }
      }
    }
    expect([...unvetted]).toEqual([]);
  });
});

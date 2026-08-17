#!/usr/bin/env tsx
/**
 * Regenerate the vendored `package-manager-detector` lockfile map.
 *
 * Fetches `src/constants.ts` + `LICENSE` from the pinned upstream tag, extracts
 * the `LOCKS` and `INSTALL_METADATA` tables, and writes:
 *   - src/config/vendor/package-manager-detector/lockfiles.generated.ts
 *   - src/config/vendor/package-manager-detector/LICENSE
 *
 * Usage (from the repo root):
 *   npm run vendor:sync:pm-detector     # regenerate
 *   npm run vendor:check:pm-detector    # CI drift guard: exit 1 if stale
 *
 * Why this exists: we vendor the small lockfile→agent DATA table rather than
 * depend on the (async-only) library, to keep our resolver synchronous. See
 * src/config/vendor/package-manager-detector/README.md.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Pin ────────────────────────────────────────────────────────────────────
// Bump these two together when refreshing against a new upstream release.
const VENDOR_REPO = 'antfu-collective/package-manager-detector';
const VENDOR_VERSION = 'v1.6.0';
const VENDOR_COMMIT = '59047a20315252c7350d846dbad3d18a99e45906';
// ──────────────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = join(__dirname, '../../../src/config/vendor/package-manager-detector');
const GENERATED_PATH = join(VENDOR_DIR, 'lockfiles.generated.ts');
const LICENSE_PATH = join(VENDOR_DIR, 'LICENSE');

const RAW = (file: string): string =>
  `https://raw.githubusercontent.com/${VENDOR_REPO}/${VENDOR_VERSION}/${file}`;

const PM_AGENT_ORDER = ['npm', 'yarn', 'pnpm', 'bun', 'deno'] as const;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
  return res.text();
}

// Allowlist for extracted keys/values. We re-emit these verbatim into a TS
// string literal, so anything outside this set (notably a backslash or quote)
// could corrupt or inject into the generated file. Fail loudly instead.
const SAFE_VENDOR_TOKEN = /^[A-Za-z0-9._/@-]+$/;

/** Extract a flat `export const NAME ... = { 'k': 'v', ... }` table, order-preserving. */
function extractMap(src: string, name: string): Array<[string, string]> {
  const block = src.match(new RegExp(`export const ${name}\\b[^=]*=\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!block) throw new Error(`could not locate \`export const ${name}\` in upstream constants.ts`);
  // `block[1]` / `m[1]` / `m[2]` are `string | undefined` under
  // `noUncheckedIndexedAccess`. Narrow rather than assert: this module already
  // fails loudly on anything it did not expect from upstream, and a capture
  // group that did not participate is exactly that case.
  const body = block[1];
  if (body === undefined) {
    throw new Error(`\`export const ${name}\` matched with no body capture — upstream format changed?`);
  }
  const pairs: Array<[string, string]> = [];
  for (const m of body.matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)) {
    const [, key, value] = m;
    if (key === undefined || value === undefined) {
      throw new Error(`malformed entry in ${name}: ${JSON.stringify(m[0])} — upstream format changed?`);
    }
    pairs.push([key, value]);
  }
  if (pairs.length === 0) throw new Error(`extracted 0 entries for ${name} — upstream format changed?`);
  for (const [k, v] of pairs) {
    if (!SAFE_VENDOR_TOKEN.test(k) || !SAFE_VENDOR_TOKEN.test(v)) {
      throw new Error(
        `unsafe token in ${name}: ${JSON.stringify([k, v])} — fails the extraction allowlist ${SAFE_VENDOR_TOKEN}`,
      );
    }
  }
  return pairs;
}

function renderEntries(pairs: Array<[string, string]>): string {
  return pairs.map(([k, v]) => `  '${k}': '${v}',`).join('\n');
}

function deriveUnion(...maps: Array<Array<[string, string]>>): string {
  const present = new Set(maps.flat().map(([, v]) => v));
  const ordered = PM_AGENT_ORDER.filter((a) => present.has(a));
  const unknown = [...present].filter((v) => !PM_AGENT_ORDER.includes(v as never));
  if (unknown.length > 0) throw new Error(`unexpected agent(s) in upstream maps: ${unknown.join(', ')}`);
  return ordered.map((a) => `'${a}'`).join(' | ');
}

function renderGenerated(locks: Array<[string, string]>, install: Array<[string, string]>): string {
  const union = deriveUnion(locks, install);
  return `// SPDX-License-Identifier: MIT
//
// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Vendored lockfile→package-manager map from \`package-manager-detector\`.
//   upstream: https://github.com/${VENDOR_REPO}
//   license:  MIT © Anthony Fu — see ./LICENSE
//   version:  ${VENDOR_VERSION}
//   commit:   ${VENDOR_COMMIT}
//   source:   src/constants.ts (LOCKS, INSTALL_METADATA)
//
// Why vendored, not depended-upon: package-manager-detector's detect() is
// async-only, but our test-runtime resolver is synchronous (multiple sync
// consumers). We need only the small, stable lockfile→agent data table, not
// the async fs traversal. See ./README.md.
//
// To update: bump VENDOR_VERSION/VENDOR_COMMIT in
// scripts/sync-vendor-pm-detector.ts and run \`npm run vendor:sync:pm-detector\`.

export type PmAgentName = ${union};

/**
 * Lockfile basename → package-manager agent.
 * Order matters: more-specific entries first (upstream invariant).
 */
export const LOCKS: Readonly<Record<string, PmAgentName>> = {
${renderEntries(locks)}
};

/**
 * Installed-state markers (dependencies installed but lockfile absent) → agent.
 * Order matters: more-specific entries first (upstream invariant).
 */
export const INSTALL_METADATA: Readonly<Record<string, PmAgentName>> = {
${renderEntries(install)}
};
`;
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');

  let constants: string;
  let license: string;
  try {
    [constants, license] = await Promise.all([
      fetchText(RAW('src/constants.ts')),
      fetchText(RAW('LICENSE')),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // In --check, a network/upstream failure is an OUTAGE, not drift. Don't
    // fail the build on it — that would flag an unreachable GitHub as stale.
    if (check) {
      console.warn(`vendor:check:pm-detector skipped — upstream unreachable (${msg}). Not treated as drift.`);
      return;
    }
    throw err;
  }

  const locks = extractMap(constants, 'LOCKS');
  const install = extractMap(constants, 'INSTALL_METADATA');
  const generated = renderGenerated(locks, install);

  if (check) {
    const errors: string[] = [];
    for (const [path, want] of [
      [GENERATED_PATH, generated],
      [LICENSE_PATH, license],
    ] as const) {
      const have = existsSync(path) ? readFileSync(path, 'utf8') : '';
      if (have !== want) errors.push(path);
    }
    if (errors.length > 0) {
      console.error(
        `vendor drift: the following are stale vs ${VENDOR_REPO}@${VENDOR_VERSION}:\n` +
          errors.map((e) => `  - ${e}`).join('\n') +
          `\nRun \`npm run vendor:sync:pm-detector\` and commit.`,
      );
      process.exit(1);
    }
    console.log(`vendor up to date with ${VENDOR_REPO}@${VENDOR_VERSION} (${locks.length} locks, ${install.length} install markers).`);
    return;
  }

  mkdirSync(VENDOR_DIR, { recursive: true });
  writeFileSync(GENERATED_PATH, generated, 'utf8');
  writeFileSync(LICENSE_PATH, license, 'utf8');
  console.log(
    `regenerated vendor from ${VENDOR_REPO}@${VENDOR_VERSION} (${VENDOR_COMMIT.slice(0, 10)}): ` +
      `${locks.length} lockfile + ${install.length} install-marker entries.`,
  );
}

main().catch((err: unknown) => {
  console.error(`sync-vendor-pm-detector failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

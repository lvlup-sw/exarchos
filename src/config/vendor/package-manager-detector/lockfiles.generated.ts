// SPDX-License-Identifier: MIT
//
// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Vendored lockfile→package-manager map from `package-manager-detector`.
//   upstream: https://github.com/antfu-collective/package-manager-detector
//   license:  MIT © Anthony Fu — see ./LICENSE
//   version:  v1.6.0
//   commit:   59047a20315252c7350d846dbad3d18a99e45906
//   source:   src/constants.ts (LOCKS, INSTALL_METADATA)
//
// Why vendored, not depended-upon: package-manager-detector's detect() is
// async-only, but our test-runtime resolver is synchronous (multiple sync
// consumers). We need only the small, stable lockfile→agent data table, not
// the async fs traversal. See ./README.md.
//
// To update: bump VENDOR_VERSION/VENDOR_COMMIT in
// scripts/sync-vendor-pm-detector.ts and run `npm run vendor:sync:pm-detector`.

export type PmAgentName = 'npm' | 'yarn' | 'pnpm' | 'bun' | 'deno';

/**
 * Lockfile basename → package-manager agent.
 * Order matters: more-specific entries first (upstream invariant).
 */
export const LOCKS: Readonly<Record<string, PmAgentName>> = {
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
  'deno.lock': 'deno',
  'pnpm-lock.yaml': 'pnpm',
  'pnpm-workspace.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
};

/**
 * Installed-state markers (dependencies installed but lockfile absent) → agent.
 * Order matters: more-specific entries first (upstream invariant).
 */
export const INSTALL_METADATA: Readonly<Record<string, PmAgentName>> = {
  'node_modules/.deno/': 'deno',
  'node_modules/.pnpm/': 'pnpm',
  'node_modules/.yarn-state.yml': 'yarn',
  'node_modules/.yarn_integrity': 'yarn',
  'node_modules/.package-lock.json': 'npm',
  '.pnp.cjs': 'yarn',
  '.pnp.js': 'yarn',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
};

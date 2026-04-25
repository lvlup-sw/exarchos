/**
 * Cross-compile target matrix for the v2.9 install rewrite.
 *
 * Lifted out of `scripts/build-binary.ts` so `scripts/ci-binary-matrix.test.ts`
 * (and any other contract gate) can import the canonical TARGETS tuple
 * without dragging in the `bun` SDK or the script's top-level build
 * dispatch — vitest's tsx loader can't resolve `import { $ } from 'bun'`,
 * so the test would fail at module-evaluation time before reaching any
 * assertion.
 *
 * Single source of truth for:
 *   1. `scripts/build-binary.ts` — the `bun build --compile` invoker.
 *   2. `.github/workflows/ci.yml` `binary-matrix.strategy.matrix.target`.
 *   3. `.github/workflows/release.yml` `binary-matrix.strategy.matrix.target`.
 *   4. `scripts/ci-binary-matrix.test.ts` — drift gate.
 *
 * Editing this tuple without updating items 2 and 3 will fail the contract
 * tests (`scripts/ci-binary-matrix.test.ts`, `scripts/release-workflow.test.ts`).
 */

export interface Target {
  readonly os: 'linux' | 'darwin' | 'windows';
  readonly arch: 'x64' | 'arm64';
  readonly bunTarget:
    | 'bun-linux-x64'
    | 'bun-linux-arm64'
    | 'bun-darwin-x64'
    | 'bun-darwin-arm64'
    | 'bun-windows-x64';
}

export const TARGETS: readonly Target[] = [
  { os: 'linux', arch: 'x64', bunTarget: 'bun-linux-x64' },
  { os: 'linux', arch: 'arm64', bunTarget: 'bun-linux-arm64' },
  { os: 'darwin', arch: 'x64', bunTarget: 'bun-darwin-x64' },
  { os: 'darwin', arch: 'arm64', bunTarget: 'bun-darwin-arm64' },
  { os: 'windows', arch: 'x64', bunTarget: 'bun-windows-x64' },
] as const;

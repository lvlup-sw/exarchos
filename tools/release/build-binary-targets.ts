/**
 * Lists the cross-compile targets of the release binary.
 *
 * The tuple is in its own file so that tests can import it without the `bun` SDK.
 * The vitest loader cannot resolve `import { $ } from 'bun'` in `tools/release/build-binary.ts`.
 *
 * `tools/release/build-binary.ts` reads this tuple. The `matrix.target` lists in
 * `.github/workflows/ci.yml` and `.github/workflows/release.yml` must match it.
 * `tests/scripts/ci-binary-matrix.test.ts` and `tests/scripts/release-workflow.test.ts` fail on drift.
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

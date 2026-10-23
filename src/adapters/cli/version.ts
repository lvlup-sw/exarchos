/**
 * Reads the version of the running binary. The entry imports this module before its fast paths,
 * so it imports only node built-ins and loads no part of the CLI.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Build-time injected version. `tools/release/build-binary.ts` passes
 * `--define EXARCHOS_BUILD_VERSION="<version>"` to `bun build --compile`
 * so the compiled binary advertises the right version even though the
 * bundle has no on-disk `package.json` to walk up to. Stays `undefined`
 * for `bun run` / `node` invocations, which fall through to the runtime
 * `package.json` walk below.
 */
declare const EXARCHOS_BUILD_VERSION: string | undefined;

/**
 * Resolves the version of the running binary, in this order:
 *   1. The build-time `EXARCHOS_BUILD_VERSION` constant. It is the source for the compiled binary.
 *   2. The `version` field of the nearest `package.json` at or above this module.
 *   3. `'unknown'`.
 * `--version` and the `version` subcommand both use it, so they always agree.
 */
export function resolvePackageVersion(): string {
  if (
    typeof EXARCHOS_BUILD_VERSION === 'string' &&
    EXARCHOS_BUILD_VERSION.length > 0
  ) {
    return EXARCHOS_BUILD_VERSION;
  }
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    let dir = here;
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, 'package.json');
      if (fs.existsSync(candidate)) {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as {
          version?: unknown;
        };
        if (typeof parsed.version === 'string') return parsed.version;
        break;
      }
      const parent = path.resolve(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
  }
  return 'unknown';
}

import { emitAuthoredArtifacts } from '../build-authored-artifacts.js';
import { emitCommandAliases } from '../build-command-aliases.js';
import { type MainDeps, resolveMainDeps } from '../cli-helpers.js';
import { join } from 'node:path';
import { type BuildReport, buildAllSkills } from './build-all.js';
import { countRuntimesFromOutDir } from './out-dir.js';

export type { MainDeps } from '../cli-helpers.js';

/**
 * `npm run build:skills` entry point. Resolves default paths relative
 * to `deps.cwd()`, runs `buildAllSkills`, prints a one-line summary on
 * success, and exits with code 1 on any error (printed to stderr).
 *
 * Exported so the CLI test harness can invoke it with mocked deps. The
 * self-invocation guard lives on the published barrel (`../build-skills.ts`)
 * because `package.json` runs that file, not this one.
 *
 * @param _argv - Currently unused; reserved for future flag parsing
 *   (e.g. `--srcDir`, `--outDir`). Named with a leading underscore to
 *   silence the no-unused-vars lint while preserving the public shape.
 * @param deps - Optional injected side-effecting collaborators.
 */
export function main(_argv: string[], deps: MainDeps = {}): void {
  const { cwd, exit, log, errLog } = resolveMainDeps(deps);

  const root = cwd();
  const srcDir = join(root, 'content');
  const outDir = join(root, 'rendered', 'skills');
  const runtimesDir = join(root, 'content/harness/runtimes');
  const commandsDir = join(root, 'rendered', 'commands');
  const aliasOutDir = join(root, 'rendered', 'command-aliases');

  let report: BuildReport;
  let aliasFilesWritten = 0;
  let authoredFilesWritten = 0;
  try {
    report = buildAllSkills({ srcDir, outDir, runtimesDir });

    // Commands and rules are authored per domain like skills, but carry no
    // placeholders, so their emit is a flatten-copy. It runs before the alias
    // pass, which reads the flat `commands/` tree this produces.
    const authoredReport = emitAuthoredArtifacts({
      contentDir: srcDir,
      outRoot: join(root, 'rendered'),
    });
    authoredFilesWritten = Object.values(authoredReport.written).reduce((a, b) => a + b, 0);

    // T2 (#1472): emit canonical-name command alias files for any runtime
    // declaring `capabilities.canonicalCommandAliases` (opencode this
    // cycle). The gate is the declared capability, not a name literal
    // (INV-4). The generated `command-aliases/<runtime>/*.md` tree is a
    // build artifact like `skills/` — deterministic and drift-guarded
    // (T4). `emitCommandAliases` performs the emit + per-runtime stale
    // cleanup as one deterministic pass shared with `skills:guard`.
    const aliasReport = emitCommandAliases({
      runtimesDir,
      commandsDir,
      outDir: aliasOutDir,
    });
    aliasFilesWritten = aliasReport.filesWritten;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errLog(`[build:skills] error: ${msg}`);
    exit(1);
    return; // unreachable in production; in tests exit throws
  }

  // Count distinct runtime names in the output path set so the summary
  // does not need `buildAllSkills` to carry a separate runtime counter.
  const runtimeCount = countRuntimesFromOutDir(outDir);
  log(
    `[build:skills] wrote ${report.variantsWritten} variants across ${runtimeCount} runtimes`,
  );
  if (report.overridesUsed.length > 0) {
    log(`[build:skills] used ${report.overridesUsed.length} runtime override(s)`);
  }
  if (authoredFilesWritten > 0) {
    log(`[build:skills] wrote ${authoredFilesWritten} authored artifact(s)`);
  }
  if (aliasFilesWritten > 0) {
    log(`[build:skills] wrote ${aliasFilesWritten} canonical command alias(es)`);
  }
  for (const warning of report.warnings) {
    errLog(`[build:skills] warning: ${warning}`);
  }
}

/**
 * Count how many direct subdirectories of `outDir` exist. Each subdir
 * corresponds to one rendered runtime. Returns 0 if `outDir` is absent.
 */

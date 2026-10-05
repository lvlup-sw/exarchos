import { emitAuthoredArtifacts } from '../build-authored-artifacts.js';
import { emitCommandAliases } from '../build-command-aliases.js';
import { type MainDeps, resolveMainDeps } from '../cli-helpers.js';
import { join } from 'node:path';
import { type BuildReport, buildAllSkills } from './build-all.js';
import { countRuntimesFromOutDir } from './out-dir.js';

export type { MainDeps } from '../cli-helpers.js';

/**
 * The `npm run build:skills` entry point. It resolves its paths from `deps.cwd()`.
 * It renders the skills, then copies the authored artifacts, then emits the command aliases.
 * The alias pass reads the flat `commands/` tree from the copy step.
 * Only a runtime that declares `capabilities.canonicalCommandAliases` gets alias files.
 * On an error, it prints the message to stderr and exits with code 1.
 *
 * The self-invocation guard is in `../build-skills.ts`, because `package.json` runs that file.
 *
 * @param _argv - Not used. It keeps the public signature.
 * @param deps - Injected side-effecting collaborators.
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

    const authoredReport = emitAuthoredArtifacts({
      contentDir: srcDir,
      outRoot: join(root, 'rendered'),
    });
    authoredFilesWritten = Object.values(authoredReport.written).reduce((a, b) => a + b, 0);

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
    return;
  }

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

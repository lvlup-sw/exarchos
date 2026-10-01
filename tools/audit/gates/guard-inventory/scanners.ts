import { type Dirent, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasDirectRunExit, isTestArtifact, selfTestCandidates } from './artifact-predicates.js';
import { GUARD_SUITE_ROOTS, MCP_SCRIPTS_DIR, REPO_ROOT } from './paths.js';

export interface McpScriptScan {
  readonly gatesWithSelfTest: readonly string[];
  readonly runnableWithoutSelfTest: readonly string[];
}

/**
 * Lists the runnable gates in `MCP_SCRIPTS_DIR`, as {@link hasDirectRunExit}
 * decides, split on whether each has a self-test. An unreadable directory
 * throws, so a failed scan never reads as "no guards here".
 */
export function scanMcpScriptGates(repoRoot: string = REPO_ROOT): McpScriptScan {
  const dir = join(repoRoot, MCP_SCRIPTS_DIR);
  const gatesWithSelfTest: string[] = [];
  const runnableWithoutSelfTest: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`${MCP_SCRIPTS_DIR}: cannot enumerate (${err instanceof Error ? err.message : String(err)})`);
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.[cm]?[jt]s$/.test(entry.name)) continue;
    const rel = `${MCP_SCRIPTS_DIR}/${entry.name}`;
    if (isTestArtifact(rel)) continue;
    const source = readFileSync(join(dir, entry.name), 'utf8');
    if (!hasDirectRunExit(source, rel)) continue;
    const hasSelfTest = selfTestCandidates(rel).some((c) => existsSync(join(repoRoot, c)));
    if (hasSelfTest) gatesWithSelfTest.push(rel);
    else runnableWithoutSelfTest.push(rel);
  }
  return {
    gatesWithSelfTest: gatesWithSelfTest.sort(),
    runnableWithoutSelfTest: runnableWithoutSelfTest.sort(),
  };
}

export interface GuardSuiteScan {
  /** Suite modules carrying a co-located self-test — the guards. */
  readonly modulesWithSelfTest: readonly string[];
  /**
   * Suite modules with no co-located self-test, such as data tables and CLI
   * entrypoints. The scan reports them, so the population boundary stays
   * visible and is not a silent filter.
   */
  readonly modulesWithoutSelfTest: readonly string[];
}

/**
 * Every module under {@link GUARD_SUITE_ROOTS}, split on whether it has a
 * co-located self-test.
 *
 * It fails closed. An empty root list throws, and so does a root that it cannot
 * read. A root that it reads but that yields zero guards also throws. A
 * mistargeted root looks like that, and its silence shrinks the inventory
 * denominator.
 */
export function scanGuardSuiteRoots(
  repoRoot: string = REPO_ROOT,
  roots: readonly string[] = GUARD_SUITE_ROOTS,
): GuardSuiteScan {
  if (roots.length === 0) {
    throw new Error(
      'guard-suite roots are EMPTY — an empty root list is the one way this scan can ' +
        'contribute nothing without failing, which is the silence it exists to prevent',
    );
  }
  const modulesWithSelfTest: string[] = [];
  const modulesWithoutSelfTest: string[] = [];

  const walk = (dir: string, into: string[]): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(join(repoRoot, dir), { withFileTypes: true });
    } catch (err) {
      throw new Error(
        `${dir}: declared guard-suite root cannot be enumerated ` +
          `(${err instanceof Error ? err.message : String(err)}) — retarget GUARD_SUITE_ROOTS`,
      );
    }
    for (const entry of entries) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(rel, into);
      } else if (entry.isFile() && /\.[cm]?ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
        into.push(rel);
      }
    }
  };

  for (const root of roots) {
    const files: string[] = [];
    walk(root, files);
    const before = modulesWithSelfTest.length;
    for (const file of files) {
      if (isTestArtifact(file)) continue;
      if (selfTestCandidates(file).some((c) => existsSync(join(repoRoot, c)))) modulesWithSelfTest.push(file);
      else modulesWithoutSelfTest.push(file);
    }
    if (modulesWithSelfTest.length === before) {
      throw new Error(
        `${root}: declared guard-suite root contributed ZERO guards — a root that matches ` +
          'nothing reports success forever; retarget GUARD_SUITE_ROOTS or drop the entry',
      );
    }
  }

  return {
    modulesWithSelfTest: modulesWithSelfTest.sort(),
    modulesWithoutSelfTest: modulesWithoutSelfTest.sort(),
  };
}

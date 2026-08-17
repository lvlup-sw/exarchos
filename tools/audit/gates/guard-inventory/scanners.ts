import { type Dirent, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasDirectRunExit, isTestArtifact, selfTestCandidates } from './artifact-predicates.js';
import { GUARD_SUITE_ROOTS, MCP_SCRIPTS_DIR, REPO_ROOT } from './paths.js';

export interface McpScriptScan {
  readonly gatesWithSelfTest: readonly string[];
  readonly runnableWithoutSelfTest: readonly string[];
}

export function scanMcpScriptGates(repoRoot: string = REPO_ROOT): McpScriptScan {
  const dir = join(repoRoot, MCP_SCRIPTS_DIR);
  const gatesWithSelfTest: string[] = [];
  const runnableWithoutSelfTest: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // Fail closed: a scan that cannot read its root must not contribute an
    // empty channel that reads as "no guards here".
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

// ─── Channel 4: modules of a declared guard suite ────────────────────────────

export interface GuardSuiteScan {
  /** Suite modules carrying a co-located self-test — the guards. */
  readonly modulesWithSelfTest: readonly string[];
  /**
   * Suite modules with NO co-located self-test: data tables, CLI entrypoints and
   * composition-root bindings. Reported for the same reason channel 3 reports
   * its own exclusions — so the boundary of the population stays reviewable
   * rather than becoming a silent filter.
   */
  readonly modulesWithoutSelfTest: readonly string[];
}

/**
 * Every module under {@link GUARD_SUITE_ROOTS}, split on whether it has a
 * co-located self-test.
 *
 * Fails CLOSED twice, and the second one is the point. A root that cannot be
 * read throws, exactly as {@link scanMcpScriptGates} does. But a root that reads
 * fine and yields ZERO guards also throws, because that is what a mistargeted
 * root looks like from the inside: the scan succeeds, the channel contributes
 * nothing, and the inventory it feeds reports a clean run over a smaller
 * denominator. An empty channel is indistinguishable from a channel that was
 * never needed, so it is not allowed to be silent.
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

// ─── Vitest include globs → suite identity ───────────────────────────────────

// One package since task 019. The alias is kept (rather than inlined as the
// literal 'root') because the suite is a real concept in this file's model —
// what collapsed is the SET of suites, not the idea of one.

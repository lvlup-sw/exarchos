/**
 * Where every event is appended, measured from the source tree.
 *
 * A `capability` registration names a `provider`, and a provider names an area
 * of the tree. The module that appends the event must live inside that area.
 * The provider check in `registration-validate.ts` compares two declarations and
 * never reads the append site. Thus agreement between the two declarations proves
 * nothing about the append site. This census reads the append sites.
 *
 * The population comes from a parse of the tree, not from a maintained table.
 * The caller injects the parser, because `typescript` is a devDependency and
 * must not become a runtime dependency. The implementation is
 * `tools/test-helpers/evidence-emission-scanner.ts`.
 *
 * The census reports an append whose discriminant does not reduce to a string, and
 * never drops it.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type { EvidenceEmissionScanner } from '../verbs/gates/gate-ownership-census.js';

/**
 * The append-site scanner port. It is the same type as the evidence census port,
 * so one definition of an append site serves both.
 */
export type AppendSiteScanner = EvidenceEmissionScanner;

/** An append whose event type did not reduce to a string. */
export interface UnresolvedAppendSite {
  /** Source module, relative to the scan root, forward-slashed. */
  readonly module: string;
  /** 1-based line of the `.append(` call. */
  readonly line: number;
}

/** Every module that appends each event, and every site that the scan cannot read. */
export interface AppendSiteCensus {
  /** Event type → the modules that append it, sorted and de-duplicated. */
  readonly modulesByEvent: ReadonlyMap<string, readonly string[]>;
  /** Append sites whose discriminant is a runtime value. */
  readonly unresolved: readonly UnresolvedAppendSite[];
  /**
   * Every module the scan read, sorted. A consumer uses it to tell a module
   * that appends nothing from a module that was never in scope.
   */
  readonly scannedModules: readonly string[];
  /** Modules scanned — the DENOMINATOR, so a shrunken scan cannot read as a clean tree. */
  readonly scannedModuleCount: number;
}

/**
 * Every non-test TypeScript module under `root`, sorted. The filter matches file
 * suffixes, because a file that the build never emits cannot be a shipped append site.
 */
async function collectSources(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        await walk(full);
        continue;
      }
      if (
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.bench.ts') &&
        !entry.name.endsWith('.d.ts')
      ) {
        files.push(full);
      }
    }
  };
  await walk(root);
  return files.sort();
}

/**
 * Scan `root` and group every resolved append site by the event it appends.
 * The same tree and scanner give the same census. This function does not judge
 * whether a site is a fault.
 */
export async function scanAppendSites(
  root: string,
  scan: AppendSiteScanner,
  knownConstants: ReadonlyMap<string, string>,
): Promise<AppendSiteCensus> {
  const files = await collectSources(root);
  const byEvent = new Map<string, Set<string>>();
  const unresolved: UnresolvedAppendSite[] = [];
  const scannedModules: string[] = [];

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const module = relative(root, file).replaceAll('\\', '/');
    scannedModules.push(module);
    for (const site of scan(source, { fileName: module, knownConstants })) {
      if (site.discriminant === undefined) {
        unresolved.push({ module, line: site.line });
        continue;
      }
      const modules = byEvent.get(site.discriminant) ?? new Set<string>();
      modules.add(module);
      byEvent.set(site.discriminant, modules);
    }
  }

  const modulesByEvent = new Map<string, readonly string[]>();
  for (const [event, modules] of byEvent) {
    modulesByEvent.set(event, Object.freeze([...modules].sort()));
  }
  return Object.freeze({
    modulesByEvent,
    unresolved: Object.freeze(
      unresolved.sort((a, b) => a.module.localeCompare(b.module) || a.line - b.line),
    ),
    scannedModules: Object.freeze(scannedModules.sort()),
    scannedModuleCount: files.length,
  });
}

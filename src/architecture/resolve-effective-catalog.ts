/**
 * Builds the effective invariant catalog for one `(phase, workflowType, touchedFiles)` key. All
 * callers use this one function, so they get the same payload. Each call loads and folds again
 * from source, with no cache.
 *
 * The pipeline loads each registered catalog source and adds the compiled-in sdlc layer. Then it
 * calls `mergeCatalogs` and `applyOverrides`, drops each granted disable, and calls
 * `projectCatalog`.
 *
 * `applyOverrides` keeps an entry with `enabled: false`. This module drops that entry when its
 * floor is `disable` or `none`. An `advisory` or `immutable` floor keeps it.
 *
 * A registered source that is absent or does not load is a warning and an entry of
 * `unresolvedSources`. Thus a caller can refuse on the data, not on the text of a warning.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExarchosConfigInput } from '../config/exarchos-config-schema.js';
import { loadInvariants, type InvariantEntry } from './invariants-loader.js';
import { loadSdlcCatalog } from './sdlc-catalog.js';
import { resolveCatalogSources } from './catalog-sources.js';
import {
  mergeCatalogs,
  applyOverrides,
  resolveFloor,
  isReservedUserId,
  type InvariantOverride,
} from './catalog-merge.js';
import { projectCatalog } from './project-catalog.js';

/** The input of {@link resolveEffectiveCatalog}. */
export interface ResolveEffectiveCatalogContext {
  /**
   * The root that relative catalog paths resolve against. The default is two directories above
   * this module.
   */
  repoRoot?: string | undefined;
  /**
   * The resolved `.exarchos.yml` config. It supplies the `invariants.catalogs` registrations and
   * the per-invariant `overrides`. If it is absent, only the sdlc layer applies, with no overrides.
   */
  config?: ExarchosConfigInput | undefined;
  /** The SDLC phase of the projection. */
  phase: string;
  /** The workflow type of the projection. */
  workflowType: string;
  /** The files that the current task touches. Only the delegate phase uses them. */
  touchedFiles?: string[] | undefined;
}

/** One registered catalog source that did not resolve. Its warning is also in the `warnings` of the result. */
export interface UnresolvedCatalogSource {
  /** The path as the config registers it. */
  path: string;
  /** The path that the resolver tried to read. */
  resolved: string;
  tier: 'dev' | 'user';
  /** `not-found`: no file at the resolved path. `load-failed`: the file did not load. */
  cause: 'not-found' | 'load-failed';
  /** The warning of the source, as `warnings` holds it. */
  warning: string;
}

/** Result of `resolveEffectiveCatalog`: projected entries plus merge/override warnings. */
export interface ResolveEffectiveCatalogResult {
  entries: InvariantEntry[];
  warnings: string[];
  /** Each registered source that is absent or does not load, in registration order. */
  unresolvedSources: UnresolvedCatalogSource[];
}

/** Returns the directory two levels above this module. */
function defaultRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../..');
}

/**
 * Builds the effective invariant catalog for one SDLC context.
 *
 * A missing or failed dev or user source adds a warning and an unresolved source, and the other layers still apply. The
 * function skips a user entry with a reserved id and adds a warning, so `mergeCatalogs` does not
 * throw. The loader gets `config ?? {}`, so an absent config never starts its disk walk-up. The
 * sdlc layer parses at module load, so a corrupt sdlc catalog fails at server start.
 */
export function resolveEffectiveCatalog(
  ctx: ResolveEffectiveCatalogContext,
): ResolveEffectiveCatalogResult {
  const repoRoot = ctx.repoRoot ?? defaultRepoRoot();
  const config = ctx.config;

  const loadWarnings: string[] = [];
  const unresolvedSources: UnresolvedCatalogSource[] = [];

  const sources = resolveCatalogSources(config);
  const dev: InvariantEntry[] = [];
  const user: InvariantEntry[] = [];
  for (const source of sources) {
    const layerLabel = source.tier === 'dev' ? 'Dev' : 'User';
    const resolved = path.isAbsolute(source.path)
      ? source.path
      : path.join(repoRoot, source.path);
    if (!fs.existsSync(resolved)) {
      const warning =
        `${layerLabel} invariant catalog '${source.path}' was not found at ` +
        `'${resolved}' and was skipped; evaluated remaining layers only.`;
      loadWarnings.push(warning);
      unresolvedSources.push({ path: source.path, resolved, tier: source.tier, cause: 'not-found', warning });
      continue;
    }
    let loaded: InvariantEntry[];
    try {
      loaded = loadInvariants(resolved, { configRoot: repoRoot }, config ?? {});
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const warning =
        `${layerLabel} invariant catalog '${source.path}' failed to load and ` +
        `was skipped; evaluated remaining layers only. Reason: ${reason}`;
      loadWarnings.push(warning);
      unresolvedSources.push({ path: source.path, resolved, tier: source.tier, cause: 'load-failed', warning });
      continue;
    }
    if (source.tier === 'dev') {
      dev.push(...loaded);
      continue;
    }
    for (const entry of loaded) {
      if (isReservedUserId(entry.id)) {
        loadWarnings.push(
          `User invariant catalog '${source.path}' entry '${entry.id}' uses a ` +
            `reserved id namespace (INV-*, SDLC-*) and was skipped; those ` +
            `prefixes are reserved for built-in invariants — rename it.`,
        );
        continue;
      }
      user.push(entry);
    }
  }

  const sdlc: InvariantEntry[] = loadSdlcCatalog();

  const merged = mergeCatalogs({ dev, sdlc, user });
  const overrides: Record<string, InvariantOverride> =
    config?.invariants?.overrides ?? {};
  const { entries: clamped, warnings: overrideWarnings } = applyOverrides(
    merged,
    overrides,
  );
  const warnings = [...loadWarnings, ...overrideWarnings];

  const survived = clamped.filter((entry) => {
    const override = overrides[entry.id];
    if (override?.enabled !== false) return true;
    const floor = resolveFloor(entry);
    return !(floor === 'disable' || floor === 'none');
  });

  const entries = projectCatalog(survived, {
    phase: ctx.phase,
    workflowType: ctx.workflowType,
    touchedFiles: ctx.touchedFiles,
  });

  return { entries, warnings, unresolvedSources };
}

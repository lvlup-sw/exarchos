import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventStore } from '../event-store/store.js';
import { SnapshotStore } from '../views/snapshot-store.js';
import type { DispatchContext } from './dispatch.js';
import type { StorageBackend } from '../storage/backend.js';
import {
  ANTHROPIC_NATIVE_CACHING,
  createInMemoryResolver,
  type CapabilityResolver,
} from '../capabilities/resolver.js';

// NOTE: `../config/loader.js`, `../config/yaml-loader.js`, `../config/resolve.js`,
// `../config/register.js`, `../vcs/factory.js`, and `../hooks/config-hooks.js`
// are intentionally NOT imported at module top-level. They are dynamic-imported
// below only when the caller provides a `projectRoot` AND a config file is
// actually present. For CLI cold-start on projects without `.exarchos.yml` /
// `exarchos.config.ts` (and for unit tests that pass no projectRoot) this
// avoids the ~10ms module-graph cost. See DR-5 / task 021 cold-start budget.

// EventStore is now threaded via DispatchContext — no module-level injection needed
import { configureCleanupSnapshotStore } from '../workflow/cleanup.js';
import { configureStateStoreBackend } from '../workflow/state-store.js';
import { loadTopology } from '../topology/loader.js';

// ─── Config Detection ──────────────────────────────────────────────────────

const JS_PROJECT_CONFIG_FILES = ['exarchos.config.ts', 'exarchos.config.js'] as const;

/**
 * Returns true when a JS/TS user-authored config file is physically present
 * in projectRoot. Used to skip the expensive `config/loader.js` + register
 * module-graph load on CLI cold-starts that have no JS config.
 *
 * YAML project config (`.exarchos.yml`) is always attempted via
 * `loadProjectConfig` — the YAML loader is cheap when the file is absent
 * (just a couple of `fs.existsSync` calls) and it is required to produce
 * the default `projectConfig` even when no file exists.
 */
function hasJsProjectConfig(projectRoot: string): boolean {
  for (const name of JS_PROJECT_CONFIG_FILES) {
    if (fs.existsSync(path.join(projectRoot, name))) return true;
  }
  return false;
}

/**
 * Resolve the runtime capability set used by composite tools to decide
 * whether to emit cache-control hints (T051, DR-14).
 *
 * Default behaviour is "always-on": every dispatch context reports
 * `anthropic_native_caching`, so consumers that understand the hint
 * (Anthropic-native runtimes wrapping the response in `cache_control:
 * { type: 'ephemeral', ttl: '1h' }` around the stable prefix) get the
 * boundary signal, and consumers that don't ignore the field per the
 * standard JSON-wire convention. The followups doc (T051) treats this
 * as the safe default — extending the resolver to a real protocol
 * handshake is a follow-up enhancement, not a blocker.
 *
 * Set `EXARCHOS_DISABLE_CACHE_HINTS=1` to opt out — the resolver
 * returns empty and `applyCacheHints` becomes a no-op. Useful when a
 * downstream consumer is observed mishandling the field, or for
 * benchmarks that want the minimal envelope shape.
 */
function buildDefaultCapabilityResolver(): CapabilityResolver {
  if (process.env.EXARCHOS_DISABLE_CACHE_HINTS === '1') {
    return createInMemoryResolver([]);
  }
  return createInMemoryResolver([ANTHROPIC_NATIVE_CACHING]);
}

// ─── Context Options ────────────────────────────────────────────────────────

export interface InitializeContextOptions {
  /**
   * Optional storage backend for test injection. Production callers
   * always thread an initialized SqliteBackend in (post-v2.11 DR-3
   * substrate-cut: SQLite is the sole substrate, no JSONL fallback).
   */
  readonly backend?: StorageBackend;
  /** Optional project root directory to load exarchos.config.ts/.js from. */
  readonly projectRoot?: string;
}

// ─── Context Initialization ─────────────────────────────────────────────────

/**
 * Creates a DispatchContext by initializing the EventStore, configuring
 * module-level stores, and determining telemetry settings.
 *
 * Extracted from createServer() to enable shared initialization between
 * MCP and CLI adapters.
 */
export async function initializeContext(
  stateDir: string,
  options?: InitializeContextOptions,
): Promise<DispatchContext> {
  const backend = options?.backend;

  // Configure the module-level storage backend for state operations
  configureStateStoreBackend(backend);

  const eventStore = new EventStore(stateDir, { backend });
  await eventStore.initialize();

  // SnapshotStore is still module-level (out of scope for EventStore threading)
  configureCleanupSnapshotStore(new SnapshotStore(stateDir));

  const enableTelemetry = process.env.EXARCHOS_TELEMETRY !== 'false';
  const capabilityResolver = buildDefaultCapabilityResolver();

  // ─── Fast exit: no projectRoot → no config/vcs/hooks work ────────────────
  if (!options?.projectRoot) {
    return { stateDir, eventStore, enableTelemetry, capabilityResolver, storage: backend };
  }

  // ─── Cold-start aware config path ────────────────────────────────────────
  // The YAML loader + resolveConfig + VCS factory + hook runner together
  // always populate sensible defaults, so callers that provide `projectRoot`
  // always observe `projectConfig`, `vcsProvider`, and `hookRunner` to be
  // defined. We lazy-import those four always.
  //
  // The JS/TS `loadConfig` (and its heavy `register*` siblings) is only
  // invoked when an `exarchos.config.ts` / `.js` file is physically present.
  // Skipping it in the common CLI cold-start case (no config file) avoids
  // the ~10ms module-graph load that would otherwise push us over the
  // DR-5 / task 021 p95=250ms budget.
  const projectRoot = options.projectRoot;
  const hasJsConfig = hasJsProjectConfig(projectRoot);

  const [
    { loadProjectConfig },
    { resolveConfig },
    { createVcsProvider },
    { createConfigHookRunner },
  ] = await Promise.all([
    import('../config/yaml-loader.js'),
    import('../config/resolve.js'),
    import('../vcs/factory.js'),
    import('../hooks/config-hooks.js'),
  ]);

  const projectConfig = resolveConfig(loadProjectConfig(projectRoot));
  const vcsProvider = await createVcsProvider({ config: projectConfig });
  const hookRunner = createConfigHookRunner(projectConfig);

  // DR-4 — apply the resolved storage durability posture before the first
  // append (the lazily-created appender reads it at construction). The
  // EventStore was built above before `.exarchos.yml` was loaded, so this is
  // the wiring point that honours `storage.synchronous`.
  eventStore.setStorageDurability(projectConfig.storage.synchronous);

  // T58 / DR-7 — load `<projectRoot>/topology.yaml` once at lifecycle start.
  // v2.11 hard-cut: the loader THROWS on any phase missing a `staleness`
  // block. We swallow that throw here so a malformed topology does not
  // take down the substrate-bearing startup path; the operator sees the
  // structured error log line emitted by the loader and downstream
  // callers see `getTopology()` continue to throw "load before".
  // The cold-start fast-exit above (no projectRoot) already bypasses
  // topology entirely — this branch is the only place wired.
  await loadTopologyIfPresent(projectRoot, eventStore);

  if (!hasJsConfig) {
    // Still populate `config = {}` so callers that use `(ctx.config ?? {})`
    // and tests that assert the field is defined keep passing.
    return {
      stateDir,
      eventStore,
      enableTelemetry,
      capabilityResolver,
      storage: backend,
      config: {},
      projectConfig,
      vcsProvider,
      hookRunner,
    };
  }

  // ─── JS/TS config present: lazy-load its loader + registrar ─────────────
  const [
    { loadConfig },
    { registerCustomWorkflows, registerCustomViews, registerCustomTools },
  ] = await Promise.all([
    import('../config/loader.js'),
    import('../config/register.js'),
  ]);

  const config = await loadConfig(projectRoot);

  if (config) {
    if (config.workflows || config.events) {
      registerCustomWorkflows(config);
    }
    if (config.views) {
      await registerCustomViews(config, projectRoot);
    }
    if (config.tools) {
      await registerCustomTools(config, projectRoot);
    }
  }

  return { stateDir, eventStore, enableTelemetry, capabilityResolver, storage: backend, config, projectConfig, vcsProvider, hookRunner };
}

/**
 * Lifecycle wiring for the topology loader (T58, DR-7).
 *
 * The design specifies the typed loader is *"called once at lifecycle start"*.
 * The loader itself owns the cache; this helper is the wiring step that
 * supplies the canonical project topology path (`<projectRoot>/topology.yaml`).
 *
 * v2.11 (Phase 5c, DR-7) behavior:
 *   - File absent → silent no-op. Repos without a `topology.yaml` see no
 *     startup error and `getTopology()` continues to throw "load before".
 *   - File present + complete → call `loadTopology()`; the loader's cache
 *     makes the parse fire exactly once per process.
 *   - File present + missing-contract → loader THROWS (DR-7 hard-cut).
 *     We swallow the throw here so a malformed topology does not bring
 *     down the substrate-bearing startup path; operators see the
 *     structured error log line emitted by the loader. The pruner cannot
 *     score in this state because `getTopology()` will continue to throw.
 *
 * The unused `eventStore` parameter is retained on the signature for
 * binary compatibility with v2.10 callers; the v2.11 loader no longer
 * emits any events, so no emit adapter is wired.
 */
async function loadTopologyIfPresent(
  projectRoot: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _eventStore: EventStore,
): Promise<void> {
  const topologyPath = path.join(projectRoot, 'topology.yaml');
  try {
    await fs.promises.access(topologyPath);
  } catch {
    // File absent (or unreadable) → skip topology loading entirely.
    return;
  }

  try {
    await loadTopology({ topologyPath });
  } catch {
    // The loader already emits a structured error log line when the
    // YAML is malformed or contains phases missing the `staleness`
    // block (DR-7 hard-cut). Swallow here so a bad topology doesn't
    // take down the substrate-bearing startup path. Downstream callers
    // see `getTopology()` continue to throw "load before".
  }
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventStore } from '../../events/store.js';
import { SnapshotStore } from '../../projections/views/snapshot-store.js';
import type { DispatchContext } from './dispatch.js';
import type { StorageBackend } from '../../storage/backend.js';
import {
  buildDefaultProcessResolver,
  type CapabilityResolver,
} from '../../workflow/capabilities/resolver.js';
import { configureCutoverAutoExport } from '../../workflow/admission/cutover-auto-export.js';
import { configureCleanupSnapshotStore } from '../../workflow/cleanup.js';
import { configureStateStoreBackend } from '../../workflow/state-store.js';
import { loadTopology } from '../../workflow/topology/loader.js';
import { assertRegistrationWeldsAtStartup } from '../../events/registration-validate.js';

const JS_PROJECT_CONFIG_FILES = ['exarchos.config.ts', 'exarchos.config.js'] as const;

/**
 * True when `exarchos.config.ts` or `exarchos.config.js` is in `projectRoot`. Without one, the
 * context skips the costly load of `config/loader.js` and the registrars.
 */
function hasJsProjectConfig(projectRoot: string): boolean {
  for (const name of JS_PROJECT_CONFIG_FILES) {
    if (fs.existsSync(path.join(projectRoot, name))) return true;
  }
  return false;
}

/**
 * Resolves the process capability set. The local CLI and the MCP server both change this machine,
 * so the default grant is the shared-mutating posture and the cache-hint token.
 * `EXARCHOS_DISABLE_CACHE_HINTS=1` drops only the hint token.
 */
function buildDefaultCapabilityResolver(): CapabilityResolver {
  return buildDefaultProcessResolver();
}

export interface InitializeContextOptions {
  /**
   * The storage backend, for test injection. Production callers pass an initialized SQLite
   * backend, which is the only substrate.
   */
  readonly backend?: StorageBackend;
  /** Optional project root directory to load exarchos.config.ts/.js from. */
  readonly projectRoot?: string;
}

/**
 * Creates the DispatchContext for the MCP and CLI adapters. It first checks the event
 * registration welds, so an unresolvable `EffectProviderId` halts startup before the first append.
 *
 * Without `projectRoot`, it skips config, VCS, and hooks. With it, it lazy-imports the YAML
 * config, VCS, and hook modules, and applies the storage durability before the first append.
 * It imports the JS/TS config loader and the registrars only when a JS/TS config file is present.
 * This keeps the CLI cold start fast. Without that file, `config` is `{}`.
 */
export async function initializeContext(
  stateDir: string,
  options?: InitializeContextOptions,
): Promise<DispatchContext> {
  assertRegistrationWeldsAtStartup();

  const backend = options?.backend;

  configureStateStoreBackend(backend);

  const eventStore = new EventStore(stateDir, backend !== undefined ? { backend } : {});
  await eventStore.initialize();

  configureCleanupSnapshotStore(new SnapshotStore(stateDir));

  configureCutoverAutoExport({ store: eventStore, stateDir });

  const enableTelemetry = process.env.EXARCHOS_TELEMETRY !== 'false';
  const capabilityResolver = buildDefaultCapabilityResolver();

  if (!options?.projectRoot) {
    return { stateDir, eventStore, enableTelemetry, capabilityResolver, ...(backend !== undefined ? { storage: backend } : {}) };
  }

  const projectRoot = options.projectRoot;
  const hasJsConfig = hasJsProjectConfig(projectRoot);

  const [
    { loadProjectConfig },
    { resolveConfig },
    { createVcsProvider },
    { createConfigHookRunner },
  ] = await Promise.all([
    import('../../config/yaml-loader.js'),
    import('../../config/resolve.js'),
    import('../../vcs/factory.js'),
    import('../../hooks/config-hooks.js'),
  ]);

  const projectConfig = resolveConfig(loadProjectConfig(projectRoot));
  const vcsProvider = await createVcsProvider({ config: projectConfig });
  const hookRunner = createConfigHookRunner(projectConfig);

  eventStore.setStorageDurability(projectConfig.storage.synchronous);

  await loadTopologyIfPresent(projectRoot, eventStore);

  if (!hasJsConfig) {
    return {
      stateDir,
      eventStore,
      enableTelemetry,
      capabilityResolver,
      ...(backend !== undefined ? { storage: backend } : {}),
      config: {},
      projectConfig,
      vcsProvider,
      hookRunner,
    };
  }

  const [
    { loadConfig },
    { registerCustomWorkflows, registerCustomViews, registerCustomTools },
  ] = await Promise.all([
    import('../../config/loader.js'),
    import('../../config/register.js'),
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

  return { stateDir, eventStore, enableTelemetry, capabilityResolver, ...(backend !== undefined ? { storage: backend } : {}), config, projectConfig, vcsProvider, hookRunner };
}

/**
 * Loads `<projectRoot>/topology.yaml` at startup. The loader caches the parse. An absent or
 * unreadable file is a no-op, and `getTopology()` then throws.
 *
 * The loader logs a structured error and throws on a malformed file. This function swallows that
 * throw, so a bad topology does not stop startup. The `_eventStore` parameter is unused.
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
    return;
  }

  try {
    await loadTopology({ topologyPath });
  } catch {
  }
}

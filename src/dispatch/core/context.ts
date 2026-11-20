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
import { logger } from '../../logger.js';
import type { VerificationHostConnector } from '../../contract/verification/harness-verification.js';
import type { ResolvedProjectConfig } from '../../config/resolve.js';

/** The executable configuration files that startup no longer evaluates. */
const EXECUTABLE_CONFIG_FILES: readonly string[] = ['exarchos.config.ts', 'exarchos.config.js'];

/**
 * The migration finding of a project that still holds executable configuration or configured event hooks.
 * Startup checks only that a configuration file exists. It never imports the file and never runs a hook.
 * The finding is one warning on the startup logger, and it appends no event.
 */
function warnRetiredExecutableConfiguration(projectRoot: string, projectConfig: ResolvedProjectConfig): void {
  const files = EXECUTABLE_CONFIG_FILES.filter((name) => fs.existsSync(path.join(projectRoot, name)));
  const hookEvents = Object.keys(projectConfig.hooks.on);
  if (files.length === 0 && hookEvents.length === 0) return;
  logger.warn(
    { finding: 'executable-configuration-retired', projectRoot, files, hookEvents },
    'Exarchos does not evaluate executable configuration or run configured event hooks. ' +
      'Startup ignored the files and hooks that this finding names. Move each workflow definition to .exarchos/workflows/.',
  );
}

/**
 * Resolves the process capability set. The local operator CLI changes this machine, so the grant is
 * the shared-mutating posture and the cache-hint token. `EXARCHOS_DISABLE_CACHE_HINTS=1` drops only the hint token.
 * An MCP session does not inherit this set. `createMcpServer` gives each session the grant of its launch configuration.
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
  /** The project root of the YAML configuration, the VCS provider and the topology. */
  readonly projectRoot?: string;
  /** The verifier connector that startup read. When it is absent, the context is unprovisioned. */
  readonly verificationHost?: VerificationHostConnector;
}

/**
 * Creates the DispatchContext for the MCP and CLI adapters. It first checks the event
 * registration welds, so an unresolvable `EffectProviderId` halts startup before the first append.
 *
 * The context returns the supplied connector as `verificationHost`. It never reads the home directory.
 * Without `projectRoot`, it skips config, VCS and topology. With it, it lazy-imports the YAML config
 * and VCS modules, applies the storage durability before the first append, and loads `topology.yaml`.
 * Startup is data-only. It never imports executable configuration and never runs a hook, and `config` is `{}`.
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
  const verificationHost = options?.verificationHost;
  const base = {
    stateDir,
    eventStore,
    enableTelemetry,
    capabilityResolver,
    ...(backend !== undefined ? { storage: backend } : {}),
    ...(verificationHost !== undefined ? { verificationHost } : {}),
  };

  if (!options?.projectRoot) {
    return base;
  }

  const projectRoot = options.projectRoot;

  const [
    { loadProjectConfig },
    { resolveConfig },
    { createVcsProvider },
  ] = await Promise.all([
    import('../../config/yaml-loader.js'),
    import('../../config/resolve.js'),
    import('../../vcs/factory.js'),
  ]);

  const projectConfig = resolveConfig(loadProjectConfig(projectRoot));
  const vcsProvider = await createVcsProvider({ config: projectConfig });

  eventStore.setStorageDurability(projectConfig.storage.synchronous);

  warnRetiredExecutableConfiguration(projectRoot, projectConfig);

  await loadTopologyIfPresent(projectRoot, eventStore);

  return { ...base, config: {}, projectConfig, vcsProvider };
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

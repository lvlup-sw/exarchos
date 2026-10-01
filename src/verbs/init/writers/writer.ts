/**
 * Contract for a writer that deploys the configuration of one agent runtime.
 * The init compositor dispatches to the writer of each detected or requested runtime.
 */

import type { AgentRuntimeName } from '../../../runtime/agent-environment-detector.js';
import type { WriterDeps } from '../probes.js';
import type { ConfigWriteResult } from '../schema.js';

export interface WriteOptions {
  readonly projectRoot: string;
  readonly nonInteractive: boolean;
  readonly forceOverwrite: boolean;
  readonly components?: readonly string[];
}

export interface RuntimeConfigWriter {
  readonly runtime: AgentRuntimeName;
  write(deps: WriterDeps, options: WriteOptions): Promise<ConfigWriteResult>;
}

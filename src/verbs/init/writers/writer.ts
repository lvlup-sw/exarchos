/**
 * RuntimeConfigWriter — contract for per-runtime config deployment.
 *
 * Each supported agent runtime (Claude Code, Cursor, Codex, etc.)
 * implements this interface. The init compositor dispatches to writers
 * based on detected or requested runtimes.
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

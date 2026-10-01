/**
 * Root and subsystem loggers. They write structured JSON to stderr (fd 2).
 * Logging must not write to stdout, because the MCP protocol uses stdout for JSON-RPC.
 */
import pino from 'pino';

const level = process.env.EXARCHOS_LOG_LEVEL ?? 'warn';

export const logger = pino(
  { level },
  pino.destination({ fd: 2, sync: false }),
);

export const storeLogger = logger.child({ subsystem: 'event-store' });
export const workflowLogger = logger.child({ subsystem: 'workflow' });
export const viewLogger = logger.child({ subsystem: 'views' });
export const syncLogger = logger.child({ subsystem: 'sync' });
export const telemetryLogger = logger.child({ subsystem: 'telemetry' });
export const orchestrateLogger = logger.child({ subsystem: 'orchestrate' });
export const taskStoreLogger = logger.child({ subsystem: 'task-store' });
export const launcherLogger = logger.child({ subsystem: 'launcher' });

import pino from 'pino';

// ─── Root Logger ────────────────────────────────────────────────────────────
//
// Writes structured JSON to stderr (fd 2).
// MCP protocol uses stdout for JSON-RPC — logging MUST NOT write to stdout.

const level = process.env.EXARCHOS_LOG_LEVEL ?? 'warn';

export const logger = pino(
  { level },
  pino.destination({ fd: 2, sync: false }),
);

// ─── Subsystem Child Loggers ────────────────────────────────────────────────

export const storeLogger = logger.child({ subsystem: 'event-store' });
export const workflowLogger = logger.child({ subsystem: 'workflow' });
export const viewLogger = logger.child({ subsystem: 'views' });
export const syncLogger = logger.child({ subsystem: 'sync' });
export const telemetryLogger = logger.child({ subsystem: 'telemetry' });
export const orchestrateLogger = logger.child({ subsystem: 'orchestrate' });

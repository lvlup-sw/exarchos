import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Logger Factory', () => {
  beforeEach(() => {
    // Clear module cache to allow env var overrides
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.EXARCHOS_LOG_LEVEL;
  });

  it('Logger_DefaultLevel_IsWarn', async () => {
    delete process.env.EXARCHOS_LOG_LEVEL;
    const { logger } = await import('./logger.js');

    expect(logger.level).toBe('warn');
  });

  it('Logger_EnvOverride_RespectsLevel', async () => {
    process.env.EXARCHOS_LOG_LEVEL = 'debug';
    const { logger } = await import('./logger.js');

    expect(logger.level).toBe('debug');
  });

  it('StoreLogger_HasSubsystem_EventStore', async () => {
    const { storeLogger } = await import('./logger.js');

    // pino child loggers expose bindings
    const bindings = storeLogger.bindings();
    expect(bindings.subsystem).toBe('event-store');
  });

  it('WorkflowLogger_HasSubsystem_Workflow', async () => {
    const { workflowLogger } = await import('./logger.js');

    const bindings = workflowLogger.bindings();
    expect(bindings.subsystem).toBe('workflow');
  });

  it('ViewLogger_HasSubsystem_Views', async () => {
    const { viewLogger } = await import('./logger.js');

    const bindings = viewLogger.bindings();
    expect(bindings.subsystem).toBe('views');
  });

  it('SyncLogger_HasSubsystem_Sync', async () => {
    const { syncLogger } = await import('./logger.js');

    const bindings = syncLogger.bindings();
    expect(bindings.subsystem).toBe('sync');
  });

  it('TelemetryLogger_HasSubsystem_Telemetry', async () => {
    const { telemetryLogger } = await import('./logger.js');

    const bindings = telemetryLogger.bindings();
    expect(bindings.subsystem).toBe('telemetry');
  });
});

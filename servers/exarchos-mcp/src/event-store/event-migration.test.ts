import { describe, it, expect } from 'vitest';
import { migrateEvent, EVENT_SCHEMA_VERSION } from './event-migration.js';

describe('Event Migration', () => {
  it('EVENT_SCHEMA_VERSION_Exported_Is1_0', () => {
    expect(EVENT_SCHEMA_VERSION).toBe('1.0');
  });

  it('MigrateEvent_CurrentVersion_ReturnsIdentity', () => {
    const event = {
      streamId: 'test-stream',
      sequence: 1,
      type: 'workflow.started',
      schemaVersion: '1.0',
      timestamp: '2025-01-15T10:00:00Z',
    };

    const result = migrateEvent(event);

    // Should return the exact same reference (no copy needed)
    expect(result).toBe(event);
  });

  it('MigrateEvent_MissingSchemaVersion_DefaultsTo1_0', () => {
    const event = {
      streamId: 'test-stream',
      sequence: 1,
      type: 'workflow.started',
      timestamp: '2025-01-15T10:00:00Z',
      // No schemaVersion field
    };

    const result = migrateEvent(event);

    // Missing version defaults to '1.0' which is current — identity return
    expect(result).toBe(event);
  });

  it('MigrateEvent_UnknownFutureVersion_ReturnsAsIs', () => {
    const event = {
      streamId: 'test-stream',
      sequence: 1,
      type: 'workflow.started',
      schemaVersion: '99.0',
      timestamp: '2025-01-15T10:00:00Z',
    };

    const result = migrateEvent(event);

    // Forward compatibility: unknown future version returns as-is
    // Returns a copy since it enters the migration loop
    expect(result.streamId).toBe('test-stream');
    expect(result.schemaVersion).toBe('99.0');
  });
});

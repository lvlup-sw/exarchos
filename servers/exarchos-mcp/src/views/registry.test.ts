import { describe, it, expect, beforeEach } from 'vitest';
import { ViewRegistry, BUILTIN_VIEW_NAMES } from './registry.js';
import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

// ─── Test Projection ────────────────────────────────────────────────────────

interface CounterView {
  count: number;
}

const counterProjection: ViewProjection<CounterView> = {
  init: () => ({ count: 0 }),
  apply: (view, _event) => ({ count: view.count + 1 }),
};

// ─── Test Event Factory ──────────────────────────────────────────────────────

function makeEvent(sequence: number): WorkflowEvent {
  return {
    type: 'test.event',
    data: {},
    timestamp: new Date().toISOString(),
    sequence,
  };
}

describe('ViewRegistry', () => {
  let registry: ViewRegistry;

  beforeEach(() => {
    registry = new ViewRegistry();
  });

  it('ViewRegistry_RegisterCustomView_MaterializesEvents', () => {
    // Register a custom view
    registry.registerCustomView('my-counter', counterProjection);

    // Get the materializer and verify the projection is registered
    const materializer = registry.getMaterializer();
    expect(materializer.hasProjection('my-counter')).toBe(true);

    // Materialize some events
    const events = [makeEvent(1), makeEvent(2), makeEvent(3)];
    const result = materializer.materialize<CounterView>('stream-1', 'my-counter', events);
    expect(result.count).toBe(3);
  });

  it('ViewRegistry_BuiltInViewName_Throws', () => {
    // All built-in view names from BUILTIN_VIEW_NAMES should be protected
    for (const name of BUILTIN_VIEW_NAMES) {
      expect(
        () => registry.registerCustomView(name, counterProjection),
        `Should throw for built-in view name: ${name}`,
      ).toThrow(/built-in/i);
    }
  });

  it('UnregisterCustomView_RemovesView', () => {
    // Register and verify
    registry.registerCustomView('temp-view', counterProjection);
    expect(registry.isCustomView('temp-view')).toBe(true);

    // Unregister and verify it's gone
    registry.unregisterCustomView('temp-view');
    expect(registry.isCustomView('temp-view')).toBe(false);
  });

  it('UnregisterCustomView_BuiltInName_Throws', () => {
    expect(
      () => registry.unregisterCustomView('pipeline'),
    ).toThrow(/built-in|cannot unregister/i);
  });

  it('UnregisterCustomView_UnknownName_Throws', () => {
    expect(
      () => registry.unregisterCustomView('nonexistent'),
    ).toThrow(/not registered|not found/i);
  });

  it('RegisterCustomView_DuplicateCustomName_Throws', () => {
    registry.registerCustomView('my-view', counterProjection);
    expect(
      () => registry.registerCustomView('my-view', counterProjection),
    ).toThrow(/already registered/i);
  });

  it('GetCustomViewNames_ReturnsOnlyCustom', () => {
    registry.registerCustomView('view-a', counterProjection);
    registry.registerCustomView('view-b', counterProjection);

    const names = registry.getCustomViewNames();
    expect(names).toContain('view-a');
    expect(names).toContain('view-b');
    expect(names).not.toContain('pipeline');
  });

  it('UnregisterCustomView_RemovesProjectionFromMaterializer', () => {
    // Register a custom view and verify its projection exists
    registry.registerCustomView('ephemeral-view', counterProjection);
    const materializer = registry.getMaterializer();
    expect(materializer.hasProjection('ephemeral-view')).toBe(true);

    // Materialize some events to populate cache
    const events = [makeEvent(1), makeEvent(2)];
    materializer.materialize('stream-1', 'ephemeral-view', events);

    // Unregister and verify the projection is removed from the materializer
    registry.unregisterCustomView('ephemeral-view');
    expect(materializer.hasProjection('ephemeral-view')).toBe(false);

    // Trying to materialize should now throw (no projection)
    expect(
      () => materializer.materialize('stream-1', 'ephemeral-view', [makeEvent(3)]),
    ).toThrow(/no projection/i);
  });
});

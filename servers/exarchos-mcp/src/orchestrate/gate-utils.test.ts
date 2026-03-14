// ─── Gate Utils Tests ─────────────────────────────────────────────────────────

import { describe, it, expect, vi } from 'vitest';
import { emitGateEvent } from './gate-utils.js';

describe('emitGateEvent', () => {
  // ─── Test 1: Valid input appends gate.executed event ─────────────────────

  it('emitGateEvent_ValidInput_AppendsGateExecutedEvent', async () => {
    // Arrange
    const mockStore = { append: vi.fn().mockResolvedValue(undefined) };

    // Act
    await emitGateEvent(mockStore as any, 'stream-1', 'test-gate', 'CI', true);

    // Assert
    expect(mockStore.append).toHaveBeenCalledOnce();
    expect(mockStore.append).toHaveBeenCalledWith('stream-1', {
      type: 'gate.executed',
      data: { gateName: 'test-gate', layer: 'CI', passed: true },
    });
  });

  // ─── Test 2: With details includes details in payload ────────────────────

  it('emitGateEvent_WithDetails_IncludesDetailsInPayload', async () => {
    // Arrange
    const mockStore = { append: vi.fn().mockResolvedValue(undefined) };
    const details = { passCount: 10, failCount: 2 };

    // Act
    await emitGateEvent(mockStore as any, 'stream-2', 'test-suite', 'CI', false, details);

    // Assert
    expect(mockStore.append).toHaveBeenCalledWith('stream-2', {
      type: 'gate.executed',
      data: { gateName: 'test-suite', layer: 'CI', passed: false, details },
    });
  });

  // ─── Test 3: With custom layer uses provided layer ───────────────────────

  it('emitGateEvent_WithCustomLayer_UsesProvidedLayer', async () => {
    // Arrange
    const mockStore = { append: vi.fn().mockResolvedValue(undefined) };

    // Act
    await emitGateEvent(mockStore as any, 'stream-3', 'design-check', 'design', true);

    // Assert
    expect(mockStore.append).toHaveBeenCalledWith('stream-3', {
      type: 'gate.executed',
      data: { gateName: 'design-check', layer: 'design', passed: true },
    });
  });

  // ─── Test 4: Without details omits details from payload ──────────────────

  it('emitGateEvent_WithoutDetails_OmitsDetailsFromPayload', async () => {
    // Arrange
    const mockStore = { append: vi.fn().mockResolvedValue(undefined) };

    // Act
    await emitGateEvent(mockStore as any, 'stream-4', 'post-merge', 'post-merge', true);

    // Assert
    const calledEvent = mockStore.append.mock.calls[0][1];
    expect(calledEvent.data).not.toHaveProperty('details');
  });
});

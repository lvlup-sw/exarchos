import { describe, it, expect } from 'vitest';
import {
  VIEW_TASKS_BYTES_THRESHOLD,
  WORKFLOW_GET_BYTES_THRESHOLD,
  EVENT_QUERY_BYTES_THRESHOLD,
  WORKFLOW_SET_DURATION_THRESHOLD,
  EVENT_QUERY_INVOCATION_THRESHOLD,
  ERROR_RATE_THRESHOLD,
  TEAM_STATUS_INVOCATION_THRESHOLD,
  CONSISTENCY_WINDOW_SIZE,
} from './constants.js';

describe('Threshold Constants', () => {
  it('ThresholdConstants_AllHintThresholds_ExportedFromConstants', () => {
    // Arrange & Act — import-time binding
    // Assert
    expect(VIEW_TASKS_BYTES_THRESHOLD).toBe(1200);
    expect(WORKFLOW_GET_BYTES_THRESHOLD).toBe(600);
    expect(EVENT_QUERY_BYTES_THRESHOLD).toBe(2000);
    expect(WORKFLOW_SET_DURATION_THRESHOLD).toBe(200);
    expect(EVENT_QUERY_INVOCATION_THRESHOLD).toBe(20);
    expect(ERROR_RATE_THRESHOLD).toBe(0.2);
    expect(TEAM_STATUS_INVOCATION_THRESHOLD).toBe(10);
    expect(CONSISTENCY_WINDOW_SIZE).toBe(5);
  });
});

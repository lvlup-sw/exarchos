// ─── Extract Task Tests ─────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleExtractTask } from './extract-task.js';
import * as fs from 'node:fs';

vi.mock('node:fs');

const FIXTURE_PLAN = `# Implementation Plan

## Overview
This is a test plan with multiple tasks.

### Task 001: Set up project structure
Create the basic project layout with src/, tests/, and config files.

- Step 1: Initialize npm
- Step 2: Add TypeScript

### Task 002: Implement core logic
Build the main processing pipeline.

- Step A: Parser
- Step B: Transformer

### Task A1: Optional enhancement
Add caching layer for performance.

Some additional details here.

## Appendix
References and notes.
`;

describe('handleExtractTask', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns error when planPath is empty', async () => {
    const result = await handleExtractTask({ planPath: '', taskId: '001' }, '/tmp/state');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('planPath');
  });

  it('returns error when taskId is empty', async () => {
    const result = await handleExtractTask({ planPath: '/some/plan.md', taskId: '' }, '/tmp/state');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('taskId');
  });

  it('returns error when plan file does not exist', async () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = await handleExtractTask(
      { planPath: '/nonexistent/plan.md', taskId: '001' },
      '/tmp/state',
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FILE_NOT_FOUND');
    expect(result.error?.message).toContain('/nonexistent/plan.md');
  });

  it('extracts correct task section for valid taskId', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(FIXTURE_PLAN);

    const result = await handleExtractTask(
      { planPath: '/plans/test.md', taskId: '001' },
      '/tmp/state',
    );
    expect(result.success).toBe(true);
    const data = result.data as { taskContent: string; taskId: string };
    expect(data.taskId).toBe('001');
    expect(data.taskContent).toContain('### Task 001: Set up project structure');
    expect(data.taskContent).toContain('Step 1: Initialize npm');
    // Should NOT contain the next task
    expect(data.taskContent).not.toContain('Task 002');
  });

  it('returns error with available tasks when taskId not found', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(FIXTURE_PLAN);

    const result = await handleExtractTask(
      { planPath: '/plans/test.md', taskId: '999' },
      '/tmp/state',
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('TASK_NOT_FOUND');
    expect(result.error?.message).toContain('999');
    const data = result.data as { availableTasks: string[] };
    expect(data.availableTasks).toContain('001');
    expect(data.availableTasks).toContain('002');
    expect(data.availableTasks).toContain('A1');
  });

  it('handles various header formats', async () => {
    const variantPlan = `# Plan

## Task 1 Overview
This uses two hashes.

Content for task 1.

### Task A1: Alpha task
Alpha content here.

#### Task 001: Deep nested
Deep nested content.

### Task 002: Next task
Next content.
`;
    vi.mocked(fs.readFileSync).mockReturnValue(variantPlan);

    // ## Task 1 (two hashes, no colon)
    const r1 = await handleExtractTask({ planPath: '/p.md', taskId: '1' }, '/tmp/state');
    expect(r1.success).toBe(true);
    const d1 = r1.data as { taskContent: string };
    expect(d1.taskContent).toContain('## Task 1 Overview');
    expect(d1.taskContent).toContain('Content for task 1.');
    expect(d1.taskContent).not.toContain('Task A1');

    // ### Task A1: (alphanumeric ID with colon)
    const r2 = await handleExtractTask({ planPath: '/p.md', taskId: 'A1' }, '/tmp/state');
    expect(r2.success).toBe(true);
    const d2 = r2.data as { taskContent: string };
    expect(d2.taskContent).toContain('### Task A1: Alpha task');
    expect(d2.taskContent).not.toContain('Task 001');
  });
});

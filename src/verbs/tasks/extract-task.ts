/** Extracts one task section from a markdown implementation plan by task id. */

import * as fs from 'node:fs';
import type { ToolResult } from '../../format.js';

interface ExtractTaskArgs {
  readonly planPath: string;
  readonly taskId: string;
}

/**
 * Returns the lines from the `## Task <taskId>` header to the next `##` header that starts with a
 * capital letter, with trailing empty lines removed. When the task is absent, it lists the task ids of the plan.
 */
export async function handleExtractTask(
  args: ExtractTaskArgs,
  _stateDir: string,
): Promise<ToolResult> {
  if (!args.planPath) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'planPath is required' },
    };
  }

  if (!args.taskId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'taskId is required' },
    };
  }

  let content: string;
  try {
    content = fs.readFileSync(args.planPath, 'utf-8');
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') {
      return {
        success: false,
        error: { code: 'FILE_NOT_FOUND', message: `Plan file not found: ${args.planPath}` },
      };
    }
    return {
      success: false,
      error: { code: 'READ_ERROR', message: `Failed to read plan file: ${args.planPath}` },
    };
  }

  const lines = content.split('\n');
  const taskId = args.taskId;

  const headerPattern = new RegExp(`^#{2,}\\s*Task\\s+${escapeRegex(taskId)}([: ]|$)`);
  const stopPattern = /^#{2,}\s*(Task\s+[0-9A-Za-z]+|[A-Z])/;

  let capturing = false;
  const extracted: string[] = [];

  for (const line of lines) {
    if (!capturing && headerPattern.test(line)) {
      capturing = true;
      extracted.push(line);
      continue;
    }

    if (capturing) {
      if (stopPattern.test(line)) {
        break;
      }
      extracted.push(line);
    }
  }

  if (extracted.length === 0) {
    const taskHeaderPattern = /^#{2,}\s*Task\s+([0-9A-Za-z]+)/;
    const availableTasks: string[] = [];
    for (const line of lines) {
      const match = taskHeaderPattern.exec(line);
      const id = match?.[1];
      if (id !== undefined) {
        availableTasks.push(id);
      }
    }

    return {
      success: false,
      error: {
        code: 'TASK_NOT_FOUND',
        message: `Task ${taskId} not found in ${args.planPath}`,
      },
      data: { availableTasks },
    };
  }

  while (extracted.length > 0 && extracted[extracted.length - 1]?.trim() === '') {
    extracted.pop();
  }

  return {
    success: true,
    data: {
      taskId,
      taskContent: extracted.join('\n'),
    },
  };
}

/** Escapes special regex characters in a string. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extracts one task from a typed or legacy plan. */

import * as fs from 'node:fs';
import type { ToolResult } from '../../format.js';
import { readValidatedDesignRecord } from '../../workflow/design-record/read.js';
import type { DesignRecordSnapshot } from '../../workflow/design-record/schema.js';

interface ExtractTaskArgs {
  readonly planPath: string;
  readonly taskId: string;
}

/** Return the task as Markdown, or list the available ids if the task is absent. */
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

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(args.planPath);
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

  const record = readValidatedDesignRecord(bytes, args.planPath);
  if (record.kind === 'invalid') {
    return {
      success: false,
      error: { code: 'INVALID_DESIGN_RECORD', message: record.message },
      ...(record.findings === undefined ? {} : { data: { findings: record.findings } }),
    };
  }
  if (record.kind === 'typed') return extractTypedTask(record.snapshot, args);
  return extractLegacyTask(bytes.toString('utf8'), args);
}

/** Extract the legacy task section and remove trailing blank lines. */
function extractLegacyTask(content: string, args: ExtractTaskArgs): ToolResult {
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

    return taskNotFound(args, availableTasks);
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

/** Render the authored task fields as the existing Markdown string. */
function extractTypedTask(snapshot: DesignRecordSnapshot, args: ExtractTaskArgs): ToolResult {
  const task = snapshot.tasks.find(({ id }) => id === args.taskId);
  if (task === undefined) return taskNotFound(args, snapshot.tasks.map(({ id }) => id));

  const taskContent = [
    `### Task ${task.id}: ${task.title}`,
    '',
    task.instructions,
    '',
    '**Acceptance:**',
    ...task.acceptance.map((item) => `- ${item}`),
    '',
    '**Files:**',
    ...task.files.map((file) => `- ${file}`),
    ...(task.testFiles.length === 0 ? [] : ['', '**Test files:**', ...task.testFiles.map((file) => `- ${file}`)]),
  ].join('\n');
  return { success: true, data: { taskId: task.id, taskContent } };
}

function taskNotFound({ taskId, planPath }: ExtractTaskArgs, availableTasks: string[]): ToolResult {
  return {
    success: false,
    error: { code: 'TASK_NOT_FOUND', message: `Task ${taskId} not found in ${planPath}` },
    data: { availableTasks },
  };
}

/** Escapes special regex characters in a string. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

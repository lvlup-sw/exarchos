/**
 * Pure soundness checks cover every task before a caller selects a frontier.
 * RESERVED(issue: #1927, owner: exarchos, expires: 2027-02-28)
 * Prepare and gate adapters will consume these checks after their typed inputs land.
 */
import { DesignTaskSchema, DesignPlanSchema, type DesignRecordSnapshot, type SourceSpan } from './schema.js';

export interface PlanFinding {
  readonly code: string;
  readonly taskIds: readonly string[];
  readonly requirementIds: readonly string[];
  readonly span: SourceSpan;
  readonly message: string;
}

export interface PlanValidation {
  readonly passed: boolean;
  readonly findings: readonly PlanFinding[];
}

/** Code-unit order retains exact identifiers without locale rules. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Internal graph lookups must resolve to the task or stack entry that created them. */
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing graph entry');
  return value;
}

/** Check all components without recursion or any completion or frontier filter. */
function findCycles(snapshot: DesignRecordSnapshot): PlanFinding[] {
  const tasks = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const colors = new Map<string, number>();
  const findings: PlanFinding[] = [];
  const seen = new Set<string>();
  for (const id of [...tasks.keys()].sort(compare)) {
    if (colors.has(id)) continue;
    const stack: { id: string; dependencies: string[]; next: number }[] = [];
    const enter = (taskId: string): void => {
      colors.set(taskId, 1);
      stack.push({ id: taskId, dependencies: [...(tasks.get(taskId)?.blockedBy ?? [])].sort(compare), next: 0 });
    };
    enter(id);
    while (stack.length > 0) {
      const frame = required(stack[stack.length - 1]);
      const dependency = frame.dependencies[frame.next++];
      if (dependency === undefined) {
        colors.set(frame.id, 2);
        stack.pop();
      } else if (tasks.has(dependency) && dependency !== frame.id) {
        if (!colors.has(dependency)) enter(dependency);
        else if (colors.get(dependency) === 1) {
          const members = stack.slice(stack.findIndex((entry) => entry.id === dependency)).map((entry) => entry.id).sort(compare);
          const key = JSON.stringify(members);
          if (!seen.has(key)) {
            seen.add(key);
            const span = required(members.map((member) => required(tasks.get(member)).span).sort((a, b) => a.start - b.start)[0]);
            findings.push({ code: 'DEPENDENCY_CYCLE', taskIds: members, requirementIds: [], span,
              message: `Dependency cycle includes ${members.join(', ')}.` });
          }
        }
      }
    }
  }
  return findings;
}

/** The strict reader owns syntax. This check reuses its schema and adds whole-plan semantic rules. */
export function validateDesignRecord(snapshot: DesignRecordSnapshot): PlanValidation {
  const findings: PlanFinding[] = [];
  const add = (code: string, message: string, span: SourceSpan, taskIds: string[] = [], requirementIds: string[] = []): void => {
    findings.push({ code, message, span, taskIds, requirementIds });
  };
  const taskIds = new Set<string>();
  const definitions = new Set<string>();
  const requirements = new Set(snapshot.requirements);
  const implemented = new Set<string>();
  for (const definition of snapshot.definitions) {
    if (definitions.has(definition.id)) add('DUPLICATE_REQUIREMENT', `Requirement ${definition.id} is defined twice.`, definition.span, [], [definition.id]);
    definitions.add(definition.id);
    if (!requirements.has(definition.id)) add('UNLISTED_REQUIREMENT', `Requirement ${definition.id} is absent from the plan requirements.`, definition.span, [], [definition.id]);
  }
  const plan = DesignPlanSchema.safeParse({ version: snapshot.version, requirements: snapshot.requirements,
    tasks: snapshot.tasks.map(({ span: _span, ...task }) => task) });
  if (!plan.success) {
    for (const issue of plan.error.issues.filter((issue) => issue.path[0] !== 'tasks')) {
      add('INVALID_PLAN_STRUCTURE', issue.message, snapshot.planSpan);
    }
  }
  if (snapshot.tasks.length === 0) add('INVALID_PLAN_STRUCTURE', 'The plan requires at least one task.', snapshot.planSpan);
  for (const { span, ...task } of snapshot.tasks) {
    if (taskIds.has(task.id)) add('DUPLICATE_TASK', `Task ${task.id} is defined twice.`, span, [task.id]);
    taskIds.add(task.id);
    const structure = DesignTaskSchema.safeParse(task);
    if (!structure.success) add('INVALID_TASK_STRUCTURE', structure.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(' | '), span, [task.id]);
    for (const requirement of task.implements) {
      implemented.add(requirement);
      if (!requirements.has(requirement) || !definitions.has(requirement)) {
        add('UNKNOWN_IMPLEMENTS', `Task ${task.id} implements unknown requirement ${requirement}.`, span, [task.id], [requirement]);
      }
    }
  }
  for (const requirement of requirements) {
    const definition = snapshot.definitions.find((entry) => entry.id === requirement);
    if (!definition) add('MISSING_REQUIREMENT_DEFINITION', `Requirement ${requirement} has no definition.`, snapshot.planSpan, [], [requirement]);
    if (!implemented.has(requirement)) add('UNIMPLEMENTED_REQUIREMENT', `Requirement ${requirement} has no implementing task.`, definition?.span ?? snapshot.planSpan, [], [requirement]);
  }
  for (const task of snapshot.tasks) {
    for (const dependency of task.blockedBy) {
      if (dependency === task.id) add('SELF_DEPENDENCY', `Task ${task.id} depends on itself.`, task.span, [task.id]);
      else if (!taskIds.has(dependency)) add('UNKNOWN_DEPENDENCY', `Task ${task.id} depends on unknown task ${dependency}.`, task.span, [task.id, dependency]);
    }
  }
  findings.push(...findCycles(snapshot));
  const parallel = snapshot.tasks.filter((task) => task.parallelizable).sort((a, b) => compare(a.id, b.id));
  for (let a = 0; a < parallel.length; a++) {
    for (let b = a + 1; b < parallel.length; b++) {
      const left = required(parallel[a]);
      const right = required(parallel[b]);
      for (const file of left.files.filter((file) => right.files.includes(file)).sort(compare)) {
        add('PARALLEL_FILE_CONFLICT', `Parallel tasks ${left.id} and ${right.id} both modify ${file}.`,
          left.span.start <= right.span.start ? left.span : right.span, [left.id, right.id]);
      }
    }
  }
  findings.sort((a, b) => compare(a.code, b.code) || a.span.start - b.span.start || a.span.end - b.span.end
    || compare(JSON.stringify(a.taskIds), JSON.stringify(b.taskIds)) || compare(JSON.stringify(a.requirementIds), JSON.stringify(b.requirementIds))
    || compare(a.message, b.message));
  return { passed: findings.length === 0, findings };
}

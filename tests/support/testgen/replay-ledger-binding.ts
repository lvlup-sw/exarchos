import { ReplayLedger } from '../../../src/contract/request-context.js';

interface Claim {
  key: string;
  subject: string;
  digest: string;
  value: string;
}
interface Outcome {
  status: 'executed' | 'replayed' | 'conflict';
  result: string | null;
  code: string | null;
}
interface Model {
  entries: Claim[];
  last: Outcome | null;
  executions: number;
}
interface System {
  ledger: ReplayLedger<string>;
  last: Outcome | null;
  executions: number;
}

export function createModel(): Model {
  return { entries: [], last: null, executions: 0 };
}

export function createSystem(): System {
  return { ledger: new ReplayLedger(), last: null, executions: 0 };
}

export function disposeSystem(_system: System): void {}

export function isEnabled(_model: Model, _operation: string, _args: unknown): boolean {
  return true;
}

export function transition(model: Model, _operation: string, args: unknown): Model {
  const claim = args as Claim;
  const previous = model.entries.find((entry) => entry.key === claim.key);
  if (!previous) {
    return {
      entries: [...model.entries, claim], executions: model.executions + 1,
      last: { status: 'executed', result: claim.value, code: null },
    };
  }
  if (previous.subject !== claim.subject) {
    return { ...model, last: { status: 'conflict', result: null, code: 'IDEMPOTENCY_SUBJECT_CONFLICT' } };
  }
  if (previous.digest !== claim.digest) {
    return { ...model, last: { status: 'conflict', result: null, code: 'IDEMPOTENCY_PAYLOAD_CONFLICT' } };
  }
  return { ...model, last: { status: 'replayed', result: previous.value, code: null } };
}

export function execute(system: System, _operation: string, args: unknown): void {
  const claim = args as Claim;
  const result = system.ledger.claim({
    idempotencyKey: claim.key, subjectId: claim.subject, requestDigest: claim.digest,
  }, () => { system.executions++; return claim.value; });
  system.last = result.status === 'conflict'
    ? { status: 'conflict', result: null, code: result.error.code }
    : { status: result.status, result: result.result, code: null };
}

export function observe(system: System) {
  return { last: system.last, executions: system.executions, keys: ['a', 'b'].filter((key) => system.ledger.has(key)) };
}

export function equivalent(model: Model, observed: ReturnType<typeof observe>): boolean {
  return JSON.stringify({ last: model.last, executions: model.executions, keys: model.entries.map((entry) => entry.key).sort() })
    === JSON.stringify(observed);
}

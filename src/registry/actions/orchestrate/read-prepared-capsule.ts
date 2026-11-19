/** A bounded historical read from the exact prepared capsule and its immutable custody. */
import { withCappedShape } from '../../../output-schema-declaration.js';
import { PreparedDetailOutputSchema, ReadPreparedCapsuleArguments } from '../../../verbs/prepare/schemas.js';
import { PREPARE_ECONOMY_BUDGET_TOKENS } from '../../../verbs/prepare/economy.js';
import { declared, none, withActionContract } from '../../action-contract.js';
import { READ_ONLY_LOCAL } from '../../annotations.js';
import { ALL_PHASES, ROLE_ANY } from '../../phases.js';
import type { BuiltinToolAction } from '../../types.js';

export const readPreparedCapsuleActions: readonly BuiltinToolAction[] = [
  withActionContract({
    name: 'read_prepared_capsule',
    description: 'Read a bounded page of task contexts and result contracts from the named historical compiler-8 prepared capsule. Use the exact streamId and capsuleVersion from prepare, then follow data.continuation. Offset defaults to 0 and limit to 10. Reads pinned custody only; missing or invalid custody refuses without regeneration or writes. Compiler-7 receipts retain their existing detail affordance.',
    schema: ReadPreparedCapsuleArguments,
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: withCappedShape(PreparedDetailOutputSchema),
    economy: { budgetTokens: PREPARE_ECONOMY_BUDGET_TOKENS },
    annotations: READ_ONLY_LOCAL,
  }, {
    requires: none('the reader authenticates the named prepared record and custody itself'),
    ensures: none('a detail read returns an ephemeral historical page'),
    needs: none('the reader uses the existing in-process event store and its immutable custody'),
    touches: { frame: 'single-machine', resources: declared({ kind: 'stream', selector: 'streamId' }) },
    executionAuthority: { kind: 'local' },
    replay: { kind: 'safe-repeat' },
    emissions: none('prepared detail reads append no events or claims and change no state'),
  }, { annotations: READ_ONLY_LOCAL }),
];

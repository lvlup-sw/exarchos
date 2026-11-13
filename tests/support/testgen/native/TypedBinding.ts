type Input = { enabled: boolean };
export const isValid = (_input: Input) => true;
export const observe = async (input: Input) => process.env.TESTGEN_FAULT !== '1' && input.enabled;
export const predicate = async (input: Input, observed: boolean) => observed === input.enabled;
export const transform = async (input: Input) => ({ ...input, enabled: !input.enabled });
export const relation = async (_source: Input, _follow: Input, before: boolean, after: boolean) => before !== after;
export const reference = async (input: Input) => input.enabled;
export const equivalent = async (_input: Input, actual: boolean, expected: boolean) => actual === expected;


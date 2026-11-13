export const createModel = () => [] as string[];
export const createSystem = () => new Set<string>();
export const disposeSystem = (system: Set<string>) => { system.clear(); };
export const isEnabled = (model: string[], operation: string, args: unknown) => operation === 'put' ? !model.includes(args as string) : model.includes(args as string);
export const transition = (model: string[], operation: string, args: unknown) => operation === 'put' ? [...model, args as string] : model.filter(value => value !== args);
export const execute = (system: Set<string>, operation: string, args: unknown) => {
 if (operation === 'put') system.add(args as string);
 else if (process.env.TESTGEN_FAULT !== '1') system.delete(args as string);
};
export const observe = (system: Set<string>) => [...system].sort();
export const equivalent = (model: string[], observed: string[]) => JSON.stringify([...model].sort()) === JSON.stringify(observed);


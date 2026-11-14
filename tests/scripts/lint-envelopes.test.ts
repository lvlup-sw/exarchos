// @oracle-sources: TypeScript selected call signatures and actual envelope rule diagnostics
/** The live type-aware analyzer distinguishes Boolean adapter options from handler arguments. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Linter, type Rule } from 'eslint';
import ts from 'typescript';
import tseslint from 'typescript-eslint';
import { expect, it } from 'vitest';
import { makeTempDir, rmrf } from '../../tools/test-helpers/temp-dir.js';

it('EnvelopeAdapter_BooleanOptions_ResolveActualHandlersAndRefuseUnsupportedShapes', async () => {
  const root = makeTempDir('envelope-adapter-');
  try {
    const filename = join(root, 'fixture.ts');
    const source = `
import { imported } from './imported.js';
type Handler = (args: { value: string }) => unknown;
function adapt<T extends Handler>(handler: T, option: boolean = false): Handler { return handler; }
function unary(handler: Handler): Handler { return handler; }
function last(option: string, handler: Handler): Handler { return handler; }
function pair(first: Handler, second: Handler): Handler { return second; }
function factory(): Handler { return args => { throw new Error(args.value); }; }
function clean(args: { value: string }) { return { success: true, data: args.value }; }
function throwsTrue(args: { value: string }) { throw new Error(args.value); }
function throwsFalse(args: { value: string }) { throw new Error(args.value); }
function throwsUnary(args: { value: string }) { throw new Error(args.value); }
function throwsLast(args: { value: string }) { throw new Error(args.value); }
function throwsPair(args: { value: string }) { throw new Error(args.value); }
declare const missing: Handler;
declare const dynamic: boolean;
declare const spread: [Handler, boolean];
declare function unknownOption(handler: Handler, option: unknown): Handler;
declare function mixedOption(handler: Handler, option: boolean | number): Handler;
declare function unknownHandler(handler: unknown, option: boolean): Handler;
declare function nonCallableReturn(handler: Handler, option: boolean): object;
const ACTION_HANDLERS = {
  clean_true: adapt(clean, true), clean_false: adapt(clean, false),
  throw_true: adapt(throwsTrue, true), throw_false: adapt(throwsFalse, false),
  unary: unary(throwsUnary), last: last('config', throwsLast), pair: pair(clean, throwsPair),
  factory: factory(), imported: adapt(imported, true),
  inline: adapt(args => { throw new Error(args.value); }, false),
  cast: adapt(((args: { value: string }) => { throw new Error(args.value); }) as Handler, true),
  missing: adapt(missing, true), dynamic: adapt(clean, dynamic), spread: adapt(...spread),
  unknown_option: unknownOption(clean, true), mixed_option: mixedOption(clean, true),
  unknown_handler: unknownHandler(clean, true), non_callable_return: nonCallableReturn(clean, true),
};
`;
    writeFileSync(filename, source);
    writeFileSync(join(root, 'imported.ts'), 'export function imported(args: { value: string }) { throw new Error(args.value); }');
    const program = ts.createProgram([filename], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true });
    expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
    const ruleModule: { default: Rule.RuleModule } = await import(new URL('../../tools/eslint-rules/no-handler-throw.js', import.meta.url).href);
    const linter = new Linter({ cwd: root, configType: 'flat' });
    const ruleId = 'envelopes/no-handler-throw';
    const messages = linter.verify(source, {
      files: ['**/*.ts'],
      languageOptions: { parser: tseslint.parser, parserOptions: { programs: [program], tsconfigRootDir: root } },
      plugins: { envelopes: { rules: { 'no-handler-throw': ruleModule.default } } },
      rules: { [ruleId]: 'error' },
    }, { filename });
    expect(messages.filter(message => message.fatal || message.ruleId !== ruleId)).toEqual([]);
    for (const name of ['clean_true', 'clean_false']) expect.soft(messages.filter(message => message.message.includes(`'${name}'`))).toEqual([]);
    for (const name of ['throw_true', 'throw_false', 'unary', 'last', 'pair', 'factory', 'imported', 'inline', 'cast']) {
      expect.soft(messages.filter(message => message.message.includes(`'${name}'`)).map(message => message.messageId)).toEqual(['abnormalThrow']);
    }
    for (const name of ['missing', 'dynamic', 'spread', 'unknown_option', 'mixed_option', 'unknown_handler', 'non_callable_return']) {
      expect.soft(messages.filter(message => message.message.includes(`'${name}'`)).map(message => message.messageId)).toEqual(['unresolvedHandler']);
    }
    expect(messages).toHaveLength(16);
  } finally { rmrf(root); }
});

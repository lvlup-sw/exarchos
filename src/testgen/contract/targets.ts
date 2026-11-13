import { z } from 'zod';

export const identifier = z.string().max(100).regex(/^[A-Za-z_][A-Za-z0-9_]*(?![\s\S])/);
export const binding = z.string().max(200).regex(/^(?:[A-Za-z_][A-Za-z0-9_]*\.)+[A-Za-z_][A-Za-z0-9_]*(?![\s\S])/);
export const frameworkVersions = { tunit: '1.2.11', vitest: '3.2.7' } as const;
export const frameworkSelection = z.object({
  framework: z.string().min(1).max(50),
  frameworkVersion: z.string().min(1).max(50),
});
export const tunit = {
  framework: z.literal('tunit'),
  frameworkVersion: z.literal(frameworkVersions.tunit),
  target: z.strictObject({
    project: z.string().max(240).regex(/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\.csproj(?![\s\S])/)
      .refine((path) => path.split('/').every((part) => !part.endsWith('.')), 'Use portable path segments.'),
    path: z.string().max(240).regex(/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\.cs(?![\s\S])/)
      .refine((path) => path.split('/').every((part) => !part.endsWith('.')), 'Use portable path segments.'),
    namespace: z.string().max(200).regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?![\s\S])/),
    className: identifier,
    observe: binding,
    precondition: binding,
  }),
};
export const tsPath = z.string().max(240)
  .regex(/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\.ts(?![\s\S])/)
  .refine((path) => path.split('/').every((part) => !part.endsWith('.')), 'Use portable path segments.');

// `resolveVerificationPolicy` in `verification-policy-resolver.ts` is the only
// composer of the config and the frozen built-in gate table. A consumer that
// needs the gates of a task must import the resolver, not the table function
// `resolveVerificationSequence`. A direct import lets a consumer ignore the
// config that the delegation stamp obeys. This guard parses each production
// file under `src/` and fails when a file other than the resolver and the
// table module reaches `resolveVerificationSequence` from
// `verification-policy.js`.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep, basename } from 'node:path';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** The `src/` directory at the repository root. */
const SRC_DIR = resolve(__dirname, '../../../src');

/** The frozen-table function that a consumer must not import directly. */
const FORBIDDEN_NAMED_IMPORT = 'resolveVerificationSequence';
/** The scanner matches the end of the specifier, so a relative path from any depth matches. */
const FORBIDDEN_MODULE_TAIL = 'verification-policy.js';

/** The table module that defines `resolveVerificationSequence`, and the resolver that layers config on the table. */
const ALLOWED_BASENAMES = new Set([
  'verification-policy.ts',
  'verification-policy-resolver.ts',
]);

/**
 * Returns true when `source` reaches `resolveVerificationSequence` from a module whose specifier ends in `verification-policy.js`.
 * It matches named, aliased, and type-only imports, named re-exports, namespace imports, and both export-all forms.
 * A namespace import or an export-all reaches every export of the module, so it reaches the table function too.
 */
function importsForbiddenTableFn(source: string): boolean {
  const sf = ts.createSourceFile(
    'scan.ts',
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );

  const specifierMatches = (spec: ts.Expression): boolean =>
    ts.isStringLiteral(spec) && spec.text.endsWith(FORBIDDEN_MODULE_TAIL);

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;

    if (ts.isImportDeclaration(node) && specifierMatches(node.moduleSpecifier)) {
      const namedBindings = node.importClause?.namedBindings;
      if (namedBindings && ts.isNamespaceImport(namedBindings)) {
        found = true;
        return;
      }
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const el of namedBindings.elements) {
          const original = el.propertyName?.text ?? el.name.text;
          if (original === FORBIDDEN_NAMED_IMPORT) {
            found = true;
            return;
          }
        }
      }
    }

    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      specifierMatches(node.moduleSpecifier)
    ) {
      if (node.exportClause === undefined || ts.isNamespaceExport(node.exportClause)) {
        found = true;
        return;
      }
      if (ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          const original = el.propertyName?.text ?? el.name.text;
          if (original === FORBIDDEN_NAMED_IMPORT) {
            found = true;
            return;
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

type WalkerFs = {
  readdirSync: (dir: string) => string[];
  statSync: (full: string) => { isDirectory: () => boolean; isFile: () => boolean };
};

const REAL_WALKER_FS: WalkerFs = { readdirSync, statSync };

/**
 * Walk the production tree under `src/`, collecting every `.ts` file that is
 * not a `.test.ts` or `.d.ts` file and not under a `__tests__` directory.
 * Re-throws walk failures with path context so a partial walk can never
 * false-negative-pass the guard.
 */
function collectProductionTsFiles(rootDir: string, fs: WalkerFs = REAL_WALKER_FS): string[] {
  const out: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch (err) {
      throw new Error(`walker readdirSync failed at ${dir}: ${(err as Error).message}`, {
        cause: err,
      });
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = fs.statSync(full);
      } catch (err) {
        throw new Error(`walker statSync failed at ${full}: ${(err as Error).message}`, {
          cause: err,
        });
      }
      if (st.isDirectory()) {
        if (entry === '__tests__' || entry === 'node_modules') continue;
        stack.push(full);
        continue;
      }
      if (!st.isFile()) continue;
      if (!entry.endsWith('.ts')) continue;
      if (entry.endsWith('.test.ts')) continue;
      if (entry.endsWith('.d.ts')) continue;
      out.push(full);
    }
  }
  return out;
}

describe('single-composer guard', () => {
  /** The walker must find more than 50 files, so an empty walk cannot pass. */
  it('RepoConformance_ResolveVerificationSequence_OnlyImportedByResolverAndTableTests', () => {
    const productionFiles = collectProductionTsFiles(SRC_DIR);
    expect(productionFiles.length).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const file of productionFiles) {
      if (ALLOWED_BASENAMES.has(basename(file))) continue;
      const content = readFileSync(file, 'utf-8');
      if (importsForbiddenTableFn(content)) {
        offenders.push(file.split(`${sep}src${sep}`).pop() ?? file);
      }
    }

    expect(
      offenders,
      `Production code must compose verification sequences through ` +
        `\`resolveVerificationPolicy\` (verification-policy-resolver.ts), never import ` +
        `\`${FORBIDDEN_NAMED_IMPORT}\` from \`${FORBIDDEN_MODULE_TAIL}\` directly. ` +
        `Found direct table imports in: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  /** The scanner flags each form that reaches the table function, and not the resolver import, an unrelated module, or a string literal. */
  describe('scanner-form coverage', () => {
    const POSITIVE: ReadonlyArray<{ name: string; src: string }> = [
      {
        name: 'named import',
        src: `import { resolveVerificationSequence } from './verification-policy.js';\n`,
      },
      {
        name: 'named import among siblings',
        src: `import { type GateName, resolveVerificationSequence, type RiskTier } from '../workflow/verification-policy.js';\n`,
      },
      {
        name: 'aliased named import',
        src: `import { resolveVerificationSequence as resolveSeq } from './verification-policy.js';\n`,
      },
      {
        name: 'named re-export',
        src: `export { resolveVerificationSequence } from './verification-policy.js';\n`,
      },
      {
        name: 'namespace import',
        src: `import * as verificationPolicy from './verification-policy.js';\nverificationPolicy.resolveVerificationSequence();\n`,
      },
      {
        name: 'namespace import among a default binding',
        src: `import def, * as vp from '../workflow/verification-policy.js';\n`,
      },
      {
        name: 'export-all',
        src: `export * from './verification-policy.js';\n`,
      },
      {
        name: 'aliased export-all',
        src: `export * as verificationPolicy from './verification-policy.js';\n`,
      },
    ];

    const NEGATIVE: ReadonlyArray<{ name: string; src: string }> = [
      {
        name: 'resolver import (the sanctioned composer surface)',
        src: `import { resolveVerificationPolicy } from './verification-policy-resolver.js';\n`,
      },
      {
        name: 'same symbol from an unrelated module',
        src: `import { resolveVerificationSequence } from './some-other-module.js';\n`,
      },
      {
        name: 'namespace import of an unrelated module',
        src: `import * as other from './some-other-module.js';\n`,
      },
      {
        name: 'export-all of an unrelated module',
        src: `export * from './some-other-module.js';\n`,
      },
      {
        name: 'string literal mentioning the symbol but no import',
        src: `const note = 'see resolveVerificationSequence in verification-policy.js';\nconsole.log(note);\n`,
      },
    ];

    for (const f of POSITIVE) {
      it(`flags ${f.name}`, () => {
        expect(importsForbiddenTableFn(f.src)).toBe(true);
      });
    }
    for (const f of NEGATIVE) {
      it(`does not flag ${f.name}`, () => {
        expect(importsForbiddenTableFn(f.src)).toBe(false);
      });
    }
  });
});

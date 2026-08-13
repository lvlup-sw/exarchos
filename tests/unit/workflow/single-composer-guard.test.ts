// ─── Single-Composer Guard (repo conformance) ───────────────────────────────
//
// `resolveVerificationPolicy` (verification-policy-resolver.ts) is the DECLARED
// only composer of config + the frozen built-in table. Every consumer that
// needs "which gates run for a task" MUST import the resolver — never call the
// frozen table function `resolveVerificationSequence` (verification-policy.ts)
// directly. A direct import re-introduces the stamp/skip desync this slice
// closes: the delegation stamp would route through config while a direct-table
// consumer (e.g. the gate self-skip path) would silently ignore it.
//
// This guard scans the production source tree and FAILS if any file other than
// the resolver + table modules themselves imports `resolveVerificationSequence`
// from `./verification-policy.js`. It mirrors the AST-based scanner pattern in
// `storage/__tests__/no-legacy-runtime-deps.test.ts` so a side-effect, dynamic,
// or re-export form cannot slip past a naive regex.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep, basename } from 'node:path';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// src/workflow/__tests__/ → src/
const SRC_DIR = resolve(__dirname, '../../../src');

/** The frozen-table symbol no consumer may import directly. */
const FORBIDDEN_NAMED_IMPORT = 'resolveVerificationSequence';
/**
 * The module specifier the forbidden symbol is exported from. We match on the
 * trailing `verification-policy.js` (ESM/NodeNext extension) so a relative path
 * from any depth (`./verification-policy.js`, `../workflow/verification-policy.js`)
 * is caught.
 */
const FORBIDDEN_MODULE_TAIL = 'verification-policy.js';

/**
 * The ONLY two files permitted to import `resolveVerificationSequence` directly:
 *   - `verification-policy.ts`          — the table module itself (defines it)
 *   - `verification-policy-resolver.ts` — the single composer that layers config
 *                                         on top of the table
 */
const ALLOWED_BASENAMES = new Set([
  'verification-policy.ts',
  'verification-policy-resolver.ts',
]);

/**
 * Returns true iff `source` reaches `resolveVerificationSequence` from a module
 * whose specifier ends in `verification-policy.js`, in ANY import/re-export form
 * TypeScript supports:
 *   - named import / aliased named import (`import { x }`, `import { x as y }`)
 *   - named re-export (`export { x } from`)
 *   - NAMESPACE import (`import * as ns from`) — binds every export, so
 *     `ns.resolveVerificationSequence(...)` bypasses the rule
 *   - EXPORT-ALL (`export * from`, `export * as ns from`) — re-exports the
 *     forbidden table function transitively
 * Only a plain side-effect import (`import '…'`) and a default import cannot name
 * this symbol; every binding form that CAN reach it is matched.
 */
function importsForbiddenTableFn(source: string): boolean {
  const sf = ts.createSourceFile(
    'scan.ts',
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );

  const specifierMatches = (spec: ts.Expression): boolean =>
    ts.isStringLiteral(spec) && spec.text.endsWith(FORBIDDEN_MODULE_TAIL);

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;

    if (ts.isImportDeclaration(node) && specifierMatches(node.moduleSpecifier)) {
      const namedBindings = node.importClause?.namedBindings;
      // import * as verificationPolicy from '…/verification-policy.js'
      // A namespace binding exposes EVERY export — including the forbidden table
      // function — so `ns.resolveVerificationSequence(...)` bypasses the rule.
      if (namedBindings && ts.isNamespaceImport(namedBindings)) {
        found = true;
        return;
      }
      // import { resolveVerificationSequence, … } from '…/verification-policy.js'
      // import type { resolveVerificationSequence } from '…' (type position too)
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const el of namedBindings.elements) {
          // `propertyName` is the original name in `import { orig as alias }`.
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
      // export * from '…/verification-policy.js'  (exportClause === undefined)
      // export * as ns from '…/verification-policy.js'  (NamespaceExport)
      // Either form re-exports the forbidden table function transitively, so a
      // consumer importing from the re-exporter reaches it without naming it.
      if (node.exportClause === undefined || ts.isNamespaceExport(node.exportClause)) {
        found = true;
        return;
      }
      // export { resolveVerificationSequence } from '…/verification-policy.js'
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
  it('RepoConformance_ResolveVerificationSequence_OnlyImportedByResolverAndTableTests', () => {
    const productionFiles = collectProductionTsFiles(SRC_DIR);
    // Sanity: the walker must actually find a substantial source tree.
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

  // Scanner-form coverage — proves the AST scanner catches the named-import and
  // named-re-export forms and does not flag the resolver's own delegated call
  // or an unrelated string literal.
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

import ts from 'typescript';

export function assertCSharpSourceDerivation(sources: Record<string, string>, entries: Record<string, string>): void {
  if (Object.keys(entries).length === 0) throw new Error('No C# emitter subjects.');
  if (!Object.hasOwn(sources, 'source.ts')) throw new Error('C# source constructor is missing.');
  const allowed = new Set([...Object.keys(entries), 'source.ts', 'reduction.ts']);
  for (const path of Object.keys(sources)) {
    if (!allowed.has(path)) throw new Error(`Unregistered C# source module: ${path}`);
  }
  for (const [path, entry] of Object.entries(entries)) {
    const source = sources[path];
    if (source === undefined) throw new Error(`Missing emitter: ${path}`);
    const diagnostics = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } }).diagnostics ?? [];
    if (diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) throw new Error(`Cannot parse emitter: ${path}`);
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const imports = new Set<string>();
    for (const statement of tree.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== './source.js') continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          if ((binding.propertyName?.text ?? binding.name.text) === 'csharpFile') imports.add(binding.name.text);
        }
      }
    }
    const declaration = tree.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === entry);
    if (!declaration?.body) throw new Error(`Missing emitter function: ${path}:${entry}`);
    const locals = new Map<string, ts.Expression>();
    for (const statement of declaration.body.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const binding of statement.declarationList.declarations) {
        if (ts.isIdentifier(binding.name) && binding.initializer) locals.set(binding.name.text, binding.initializer);
      }
    }
    const shadows = new Set(declaration.parameters.flatMap((parameter) => ts.isIdentifier(parameter.name) ? [parameter.name.text] : []));
    function derived(node: ts.Node, seen = new Set<string>()): boolean {
      if (ts.isIdentifier(node)) {
        if (seen.has(node.text)) return false;
        const initializer = locals.get(node.text);
        return initializer !== undefined && derived(initializer, new Set([...seen, node.text]));
      }
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression)) return imports.has(node.expression.text) && !locals.has(node.expression.text) && !shadows.has(node.expression.text);
        if (ts.isPropertyAccessExpression(node.expression) && ['split', 'trimEnd', 'join', 'map'].includes(node.expression.name.text)) return derived(node.expression.expression, seen);
      }
      if (ts.isArrayLiteralExpression(node)) return node.elements.some((element) => derived(element, seen));
      if (ts.isSpreadElement(node)) return derived(node.expression, seen);
      return false;
    }
    const returns = declaration.body.statements.filter(ts.isReturnStatement);
    const returned = returns[0]?.expression;
    const patch = returned && ts.isObjectLiteralExpression(returned)
      ? returned.properties.find((property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property) && property.name.getText(tree) === 'patch')?.initializer
      : returned;
    if (returns.length !== 1 || !patch || !derived(patch)) throw new Error(`Returned C# source bypasses its constructor: ${path}:${entry}`);
  }
}

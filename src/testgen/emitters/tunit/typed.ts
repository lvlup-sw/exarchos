import { csharpFile } from './source.js';
import type { TypedInput, TypedMethod } from '../../contract/typed.js';
import { canonicalJson } from '../../domains/schema.js';
import { csharpDomainCheck } from '../shared/domain-check.js';
import { csharpLiteral } from '../shared/csharp-literal.js';

type Input = Extract<TypedInput, { framework: 'tunit' }>;
const qualify = (name: string) => name.split('.').map((part) => `@${part}`).join('.');

export function emitTypedTUnit(input: Input, method: TypedMethod): string {
  const binding = `global::${qualify(input.target.binding)}`;
  const checkName = input.target.className === 'InDomain' ? 'InDomain_' : 'InDomain';
  const canonicalName = input.target.className === 'Canonical' ? 'Canonical_' : 'Canonical';
  const methods = {
    property: `        var observed = await ${binding}.Observe(source);
        await Assert.That(await ${binding}.Predicate(source, observed)).IsTrue();`,
    metamorphic: `        var follow = await ${binding}.Transform(source.Clone());
        if (!${checkName}(follow) || !${binding}.IsValid(follow)) throw new InvalidOperationException("TestGen invalid case: follow-up is outside the declared domain.");
        if (${canonicalName}(source) == ${canonicalName}(follow)) throw new InvalidOperationException("TestGen invalid case: transformation produced an identical input.");
        var before = await ${binding}.Observe(source);
        var after = await ${binding}.Observe(follow);
        await Assert.That(await ${binding}.Relation(source, follow, before, after)).IsTrue();`,
    differential: `        var actual = await ${binding}.Observe(source.Clone());
        var expected = await ${binding}.Reference(source.Clone());
        await Assert.That(await ${binding}.Equivalent(source, actual, expected)).IsTrue();`,
  };
  const cases = input.cases.map((value, index) => {
    const name = `Case_${index + 1}` === input.target.className ? `Case_${index + 1}_` : `Case_${index + 1}`;
    return { name, body: `        using var document = JsonDocument.Parse(${csharpLiteral(canonicalJson(value))});
        var source = document.RootElement;
        if (!${checkName}(source) || !${binding}.IsValid(source)) throw new InvalidOperationException("TestGen invalid case: source is outside the declared domain.");
${methods[method]}` };
  });
  const canonical = method === 'metamorphic' ? `
    private static string ${canonicalName}(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Object => "{" + string.Join(",", value.EnumerateObject().OrderBy(item => item.Name, StringComparer.Ordinal)
            .Select(item => JsonSerializer.Serialize(item.Name) + ":" + ${canonicalName}(item.Value))) + "}",
        JsonValueKind.Array => "[" + string.Join(",", value.EnumerateArray().Select(${canonicalName})) + "]",
        JsonValueKind.Number => value.GetDouble().ToString("R", CultureInfo.InvariantCulture),
        _ => JsonSerializer.Serialize(value)
    };
` : '';
  return csharpFile(input.target.namespace, input.target.className, cases, `
    private static bool ${checkName}(JsonElement value) => ${csharpDomainCheck(input.domain)};
${canonical}
`);
}

import { csharpFile } from './source.js';
import type { TypedInput, TypedMethod } from '../../contract/typed.js';
import { canonicalJson } from '../../domains/schema.js';
import { csharpDomainCheck } from '../shared/domain-check.js';
import { csharpLiteral } from '../shared/csharp-literal.js';
import { csharpReduction } from './reduction.js';

type Input = Extract<TypedInput, { framework: 'tunit' }>;
const qualify = (name: string) => name.split('.').map((part) => `@${part}`).join('.');

export function emitTypedTUnit(input: Input, method: TypedMethod): string {
  const binding = `global::${qualify(input.target.binding)}`;
  const runtime = input.target.className === 'TestgenRuntime' ? 'TestgenRuntime_' : 'TestgenRuntime';
  const methods = {
    property: `        var observed = await ${binding}.Observe(source).ConfigureAwait(false);
        return await ${binding}.Predicate(source, observed).ConfigureAwait(false);`,
    metamorphic: `        var follow = await ${binding}.Transform(source.Clone()).ConfigureAwait(false);
        if (!InDomain(follow) || !${binding}.IsValid(follow)) throw new InvalidCaseException("TestGen invalid case: follow-up is outside the declared domain.");
        if (Canonical(source) == Canonical(follow)) throw new InvalidCaseException("TestGen invalid case: transformation produced an identical input.");
        var before = await ${binding}.Observe(source).ConfigureAwait(false);
        var after = await ${binding}.Observe(follow).ConfigureAwait(false);
        return await ${binding}.Relation(source, follow, before, after).ConfigureAwait(false);`,
    differential: `        var actual = await ${binding}.Observe(source.Clone()).ConfigureAwait(false);
        var expected = await ${binding}.Reference(source.Clone()).ConfigureAwait(false);
        return await ${binding}.Equivalent(source, actual, expected).ConfigureAwait(false);`,
  };
  const cases = input.cases.map((value, index) => {
    const name = `Case_${index + 1}` === input.target.className ? `Case_${index + 1}_` : `Case_${index + 1}`;
    return { name, body: `        using var document = JsonDocument.Parse(${csharpLiteral(canonicalJson(value))});
        await ${runtime}.RunCase(document.RootElement, "Case_${index + 1}").ConfigureAwait(false);` };
  });
  return csharpFile(input.target.namespace, input.target.className, cases, `

    private static class ${runtime}
    {
    private sealed class InvalidCaseException(string message) : Exception(message);
    private static readonly JsonElement Domain = JsonSerializer.Deserialize<JsonElement>(${csharpLiteral(JSON.stringify(input.domain))});
    private static bool InDomain(JsonElement value) => ${csharpDomainCheck(input.domain)};

    private static string Canonical(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Object => "{" + string.Join(",", value.EnumerateObject().OrderBy(item => item.Name, StringComparer.Ordinal)
            .Select(item => JsonSerializer.Serialize(item.Name) + ":" + Canonical(item.Value))) + "}",
        JsonValueKind.Array => "[" + string.Join(",", value.EnumerateArray().Select(Canonical)) + "]",
        JsonValueKind.Number => value.GetDouble().ToString("R", CultureInfo.InvariantCulture),
        _ => JsonSerializer.Serialize(value)
    };

${csharpReduction}
    private static async Task<bool> Check(JsonElement source)
    {
        if (!InDomain(source) || !${binding}.IsValid(source)) throw new InvalidCaseException("TestGen invalid case: source is outside the declared domain.");
${methods[method]}
    }

    internal static async Task RunCase(JsonElement source, string caseId)
    {
        bool passed;
        try { passed = await Check(source).ConfigureAwait(false); }
        catch (InvalidCaseException error)
        {
            Console.Error.WriteLine("TESTGEN_REJECTED " + JsonSerializer.Serialize(new { caseId, reason = error.Message, cases = new[] { source } }));
            throw;
        }
        if (passed) return;
        var current = source.Clone();
        var seen = new HashSet<string>(StringComparer.Ordinal) { Canonical(current) };
        var attempts = 0;
        var rejected = 0;
        var duplicates = 0;
        string? aborted = null;
        var maximum = ${input.reduction?.maxAttempts ?? 0};
        var changed = true;
        while (changed && attempts < maximum && aborted is null)
        {
            changed = false;
            foreach (var candidate in SmallerValues(Domain, current))
            {
                if (attempts >= maximum) break;
                attempts++;
                if (!seen.Add(Canonical(candidate))) { duplicates++; continue; }
                if (!InDomain(candidate)) { rejected++; continue; }
                try
                {
                    if (!await Check(candidate).ConfigureAwait(false))
                    {
                        current = candidate.Clone();
                        changed = true;
                        break;
                    }
                }
                catch (InvalidCaseException) { rejected++; }
                catch (Exception error) { aborted = error.ToString(); break; }
            }
        }
        Console.Error.WriteLine("TESTGEN_REPLAY " + JsonSerializer.Serialize(new
        {
            version = 2, propertyRef = ${csharpLiteral(input.propertyRef)}, method = ${JSON.stringify(method)}, caseId,
            domain = Domain, cases = new[] { current }, original = source,
            signature = ${JSON.stringify(method + '/oracle-false')},
            reduction = new { attempts, rejected, duplicates, exhausted = attempts >= maximum, aborted }
        }));
        await Assert.That(passed).IsTrue();
    }
    }
`);
}

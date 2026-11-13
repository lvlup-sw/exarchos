import type { Scenario, StatefulInput } from '../../contract/stateful.js';
import { csharpDomainCheck } from '../shared/domain-check.js';
import { csharpReduction } from './reduction.js';

type Input = Extract<StatefulInput, { framework: 'tunit' }>;
const qualify = (name: string) => name.split('.').map((part) => `@${part}`).join('.');

export function emitStatefulTUnit(input: Input, scenarios: Scenario[]): string {
  const binding = `global::${qualify(input.target.binding)}`;
  const runtime = input.target.className === 'TestgenRuntime' ? 'TestgenRuntime_' : 'TestgenRuntime';
  const checks = input.operations.map(({ name, domain }) => `        ${JSON.stringify(name)} => ${csharpDomainCheck(domain)},`).join('\n');
  const cases = scenarios.map((scenario, index) => {
    const name = `Case_${index + 1}` === input.target.className ? `Case_${index + 1}_` : `Case_${index + 1}`;
    return `    [Test]
    public async Task ${name}()
    {
        using var scenario = JsonDocument.Parse(${JSON.stringify(JSON.stringify(scenario))});
        await ${runtime}.RunCase(scenario.RootElement, "Case_${index + 1}").ConfigureAwait(false);
    }`;
  }).join('\n\n');
  return `using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Numerics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using TUnit.Assertions;
using TUnit.Assertions.Extensions;
using TUnit.Core;

namespace ${qualify(input.target.namespace)};

public sealed class @${input.target.className}
{
${cases}

    private static class ${runtime}
    {
    private sealed record Step([property: JsonPropertyName("operation")] string Operation, [property: JsonPropertyName("args")] JsonElement Args);
    private sealed record Outcome(string Status, string Signature, Step[] History, int Attempts, int Rejected, bool Exhausted);
    private static readonly JsonElement Operations = JsonSerializer.Deserialize<JsonElement>(${JSON.stringify(JSON.stringify(input.operations))});
    private static readonly Dictionary<string, JsonElement> Domains = Operations.EnumerateArray()
        .ToDictionary(item => item.GetProperty("name").GetString()!, item => item.GetProperty("domain").Clone());

    private static bool ValidArguments(string operation, JsonElement value) => operation switch
    {
${checks}
        _ => false
    };
${csharpReduction}
    private static async Task<Outcome> CheckHistory(Step[] steps, string mode, int requiredSteps)
    {
        var model = await ${binding}.CreateModel().ConfigureAwait(false);
        var system = await ${binding}.CreateSystem().ConfigureAwait(false);
        var history = new List<Step>();
        var attempts = 0;
        var rejected = 0;
        Outcome Result(string status, string signature = "", bool exhausted = false) =>
            new(status, signature, history.ToArray(), attempts, rejected, exhausted);
        try
        {
            if (!await ${binding}.Equivalent(model, await ${binding}.Observe(system).ConfigureAwait(false)).ConfigureAwait(false))
                return Result("fail", "stateful/initial-state");
            foreach (var step in steps)
            {
                if (history.Count == requiredSteps) break;
                attempts++;
                if (!ValidArguments(step.Operation, step.Args)) return Result("rejected", "stateful/invalid-arguments");
                if (!${binding}.IsEnabled(model, step.Operation, step.Args))
                {
                    rejected++;
                    if (mode == "exact") return Result("rejected", "stateful/precondition");
                    continue;
                }
                model = await ${binding}.Transition(model, step.Operation, step.Args).ConfigureAwait(false);
                await ${binding}.Execute(system, step.Operation, step.Args).ConfigureAwait(false);
                history.Add(step);
                if (!await ${binding}.Equivalent(model, await ${binding}.Observe(system).ConfigureAwait(false)).ConfigureAwait(false))
                    return Result("fail", "stateful/" + step.Operation + "/state-mismatch");
            }
            if (history.Count != requiredSteps) return Result("rejected", "stateful/generation-exhausted", true);
            return Result("pass");
        }
        finally
        {
            await ${binding}.DisposeSystem(system).ConfigureAwait(false);
        }
    }

    private static IEnumerable<Step[]> SmallerHistories(Step[] history)
    {
        foreach (var candidate in ShorterArrays(history, 0)) yield return candidate;
        for (var index = 0; index < history.Length; index++)
        {
            var step = history[index];
            foreach (var args in SmallerValues(Domains[step.Operation], step.Args))
            {
                var candidate = (Step[])history.Clone();
                candidate[index] = new Step(step.Operation, args);
                yield return candidate;
            }
        }
    }

    internal static async Task RunCase(JsonElement scenario, string caseId)
    {
        var steps = scenario.GetProperty("steps").EnumerateArray()
            .Select(step => new Step(step.GetProperty("operation").GetString()!, step.GetProperty("args").Clone())).ToArray();
        var original = await CheckHistory(steps, scenario.GetProperty("mode").GetString()!, scenario.GetProperty("requiredSteps").GetInt32()).ConfigureAwait(false);
        Console.Error.WriteLine("TESTGEN_HISTORY " + JsonSerializer.Serialize(new
        {
            version = 2, propertyRef = ${JSON.stringify(input.propertyRef)}, caseId,
            status = original.Status, signature = original.Signature, history = original.History,
            attempts = original.Attempts, rejected = original.Rejected, exhausted = original.Exhausted
        }));
        if (original.Status == "pass") return;
        if (original.Status == "rejected") throw new InvalidOperationException("TestGen invalid history: " + original.Signature);
        var current = original.History;
        var seen = new HashSet<string>(StringComparer.Ordinal) { JsonSerializer.Serialize(current) };
        var attempts = 0;
        var rejected = 0;
        var duplicates = 0;
        string? aborted = null;
        var maximum = ${input.reduction?.maxAttempts ?? 0};
        var changed = true;
        while (changed && attempts < maximum && aborted is null)
        {
            changed = false;
            foreach (var candidate in SmallerHistories(current))
            {
                if (attempts >= maximum) break;
                attempts++;
                if (!seen.Add(JsonSerializer.Serialize(candidate))) { duplicates++; continue; }
                try
                {
                    var result = await CheckHistory(candidate, "exact", candidate.Length).ConfigureAwait(false);
                    if (result.Status == "rejected") rejected++;
                    if (result.Status == "fail" && result.Signature == original.Signature)
                    {
                        current = result.History;
                        changed = true;
                        break;
                    }
                }
                catch (Exception error) { aborted = error.ToString(); break; }
            }
        }
        Console.Error.WriteLine("TESTGEN_REPLAY " + JsonSerializer.Serialize(new
        {
            version = 2, propertyRef = ${JSON.stringify(input.propertyRef)}, method = "stateful", caseId,
            operations = Operations, histories = new[] { current }, original = original.History, signature = original.Signature,
            reduction = new { attempts, rejected, duplicates, exhausted = attempts >= maximum, aborted }
        }));
        await Assert.That(original.Status).IsEqualTo("pass");
    }
    }
}
`;
}

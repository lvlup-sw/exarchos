import type { Success, TestInput } from '../../contract/schemas.js';

type TUnitInput = Extract<TestInput, { framework: 'tunit' }>;

const qualified = (name: string): string => name.split('.').map((part) => `@${part}`).join('.');
const reference = (name: string): string => `global::${qualified(name)}`;

function literal(value: string): string {
  return value === '-9223372036854775808' ? 'long.MinValue' : `${value}L`;
}

function renderCheck(input: TUnitInput): string {
  const observe = reference(input.target.observe);
  if ('predicate' in input) {
    return `        long observed = ${observe}(source);
        await Assert.That(${reference(input.predicate)}(source, observed)).IsTrue();`;
  }
  return `        long[]? follow = ${reference(input.transform)}((long[])source.Clone());
        if (follow is null || follow.Length != source.Length || !${reference(input.target.precondition)}(follow))
        {
            throw new InvalidOperationException("TestGen invalid case: follow-up is outside the declared domain.");
        }

        if (source.AsSpan().SequenceEqual(follow))
        {
            throw new InvalidOperationException("TestGen invalid case: transformation produced an identical input.");
        }

        long sourceResult = ${observe}(source);
        long followResult = ${observe}(follow);
        await Assert.That(${reference(input.relation)}(source, follow, sourceResult, followResult)).IsTrue();`;
}

export function emitTUnit(input: TUnitInput): Success {
  const { target, cases } = input;
  const check = target.className === 'Check' ? 'Check_' : 'Check';
  const methods = cases.map((values, i) => {
    const caseName = `Case_${i + 1}`;
    const method = caseName === target.className ? `${caseName}_` : caseName;
    return `    /// <summary>Checks the property for fixture case ${i + 1}.</summary>
    /// <returns>The assertion task.</returns>
    [Test]
    public Task ${method}() => ${check}(new long[] { ${values.map(literal).join(', ')} });`;
  });
  const lines = `using System;
using System.Threading.Tasks;
using TUnit.Assertions;
using TUnit.Assertions.Extensions;
using TUnit.Core;

namespace ${qualified(target.namespace)};

/// <summary>Checks the reviewed property over the supplied case domain.</summary>
public sealed class @${target.className}
{
${methods.join('\n\n')}

    private static async Task ${check}(long[] source)
    {
        if (!${reference(target.precondition)}(source))
        {
            throw new InvalidOperationException("TestGen invalid case: source is outside the declared domain.");
        }

${renderCheck(input)}
    }
}`.split('\n');
  const { path } = target;
  return {
    ok: true,
    contractVersion: 1,
    generatorVersion: 'tunit/1',
    patch: [
      `diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`,
      `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`), '',
    ].join('\n'),
    fixture: { version: 1, cases },
    propertyRefs: [input.propertyRef],
    assumptions: input.assumptions,
    unresolvedObligations: [
      'Compile and execute emitted cases in the target project with the reviewed bindings.',
      'Check that the native test runner discovers every case and that negative controls fail at the intended assertion.',
    ],
    validation: {
      executable: 'dotnet',
      args: ['run', '--project', target.project, '-c', 'Release'],
    },
  };
}

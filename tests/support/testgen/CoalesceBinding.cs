using System;
using Bifrost.Scheduling.Core;
using Bifrost.Scheduling.Internal;

namespace Bifrost.Tests.Scheduling;

internal static class CoalesceBinding
{
    private const long MaxTicks = 3155378975999999999L;

    public static bool IsValid(long[] values) =>
        values.Length == 3 &&
        values[0] >= 0 && values[0] <= MaxTicks &&
        values[1] > values[0] && values[1] <= MaxTicks &&
        values[2] > 0 && values[2] <= values[1] - values[0] &&
        values[2] <= MaxTicks - values[1];

    public static long Observe(long[] values)
    {
        var result = MissedFirePolicyApplier.ComputeMissedFires(
            new IntervalCadence(TimeSpan.FromTicks(values[2])),
            new DateTimeOffset(values[0], TimeSpan.Zero),
            new DateTimeOffset(values[1], TimeSpan.Zero),
            MissedFirePolicy.Coalesce);
        return result.Count == 1 ? result[0].UtcTicks : -1;
    }

    public static bool IsLatest(long[] input, long result)
    {
        var (last, now, interval) = (input[0], input[1], input[2]);
        var count = (now - last) / interval;
        var expected = last + count * interval;
        return result == expected && result <= now && now - result < interval;
    }

    public static long[] Advance(long[] input) => new[] { input[0], input[1] + input[2], input[2] };

    public static long[] Translate(long[] input)
    {
        var delta = input[0] > 0 ? -1L : 1L;
        return new[] { input[0] + delta, input[1] + delta, input[2] };
    }

    public static bool Advances(long[] source, long[] follow, long before, long after) =>
        before >= 0 && after >= 0 && follow[1] - source[1] == source[2] && after - before == source[2];

    public static bool Translates(long[] source, long[] follow, long before, long after) =>
        before >= 0 && after >= 0 && after - before == follow[0] - source[0];

    public static long[] ExtendBacklog(long[] input) =>
        new[] { input[0] - 100 * input[2], input[1], input[2] };

    public static bool KeepsLatest(long[] source, long[] follow, long before, long after) =>
        before >= 0 && after == before && (source[0] - follow[0]) % source[2] == 0;
}

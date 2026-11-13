export const csharpReduction = String.raw`
    private static IEnumerable<JsonElement> SmallerValues(JsonElement domain, JsonElement value)
    {
        switch (domain.GetProperty("kind").GetString())
        {
            case "boolean":
                if (value.GetBoolean()) yield return JsonSerializer.SerializeToElement(false);
                break;
            case "integer":
            {
                var current = BigInteger.Parse(value.GetString()!, CultureInfo.InvariantCulture);
                var minimum = BigInteger.Parse(domain.GetProperty("min").GetString()!, CultureInfo.InvariantCulture);
                var maximum = BigInteger.Parse(domain.GetProperty("max").GetString()!, CultureInfo.InvariantCulture);
                var target = minimum > 0 ? minimum : maximum < 0 ? maximum : BigInteger.Zero;
                if (current == target) break;
                yield return JsonSerializer.SerializeToElement(target.ToString(CultureInfo.InvariantCulture));
                for (var distance = (current - target) / 2; distance != 0; distance /= 2)
                    yield return JsonSerializer.SerializeToElement((current - distance).ToString(CultureInfo.InvariantCulture));
                break;
            }
            case "number":
            {
                var current = value.GetDouble();
                var target = Math.Max(domain.GetProperty("min").GetDouble(), Math.Min(domain.GetProperty("max").GetDouble(), 0));
                if (current == target) break;
                yield return JsonSerializer.SerializeToElement(target);
                var halfway = current / 2 + target / 2;
                if (halfway != current && halfway != target) yield return JsonSerializer.SerializeToElement(halfway);
                break;
            }
            case "enum":
                foreach (var candidate in domain.GetProperty("values").EnumerateArray())
                {
                    if (candidate.GetString() == value.GetString()) break;
                    yield return candidate.Clone();
                }
                break;
            case "nullable":
                if (value.ValueKind != JsonValueKind.Null)
                {
                    yield return JsonSerializer.SerializeToElement<object?>(null);
                    foreach (var candidate in SmallerValues(domain.GetProperty("value"), value)) yield return candidate;
                }
                break;
            case "string":
            {
                var characters = value.GetString()!.EnumerateRunes().Select(character => character.ToString()).ToArray();
                var minimum = domain.GetProperty("minLength").GetInt32();
                foreach (var shorter in ShorterArrays(characters, minimum)) yield return JsonSerializer.SerializeToElement(string.Concat(shorter));
                var alphabet = domain.GetProperty("alphabet").GetString()!.EnumerateRunes().Select(character => character.ToString()).ToArray();
                for (var index = 0; index < characters.Length; index++)
                {
                    var current = Array.IndexOf(alphabet, characters[index]);
                    foreach (var replacement in alphabet.Take(current))
                    {
                        var copy = (string[])characters.Clone();
                        copy[index] = replacement;
                        yield return JsonSerializer.SerializeToElement(string.Concat(copy));
                    }
                }
                break;
            }
            case "array":
            {
                var elements = value.EnumerateArray().Select(item => item.Clone()).ToArray();
                foreach (var shorter in ShorterArrays(elements, domain.GetProperty("minLength").GetInt32()))
                    yield return JsonSerializer.SerializeToElement(shorter);
                for (var index = 0; index < elements.Length; index++)
                {
                    foreach (var replacement in SmallerValues(domain.GetProperty("element"), elements[index]))
                    {
                        var copy = (JsonElement[])elements.Clone();
                        copy[index] = replacement;
                        yield return JsonSerializer.SerializeToElement(copy);
                    }
                }
                break;
            }
            case "record":
                foreach (var field in domain.GetProperty("fields").EnumerateObject())
                {
                    foreach (var replacement in SmallerValues(field.Value, value.GetProperty(field.Name)))
                    {
                        var copy = value.EnumerateObject().ToDictionary(item => item.Name, item => item.Value.Clone());
                        copy[field.Name] = replacement;
                        yield return JsonSerializer.SerializeToElement(copy);
                    }
                }
                break;
        }
    }

    private static IEnumerable<T[]> ShorterArrays<T>(T[] values, int minimum)
    {
        for (var count = values.Length - minimum; count > 0; count /= 2)
            for (var start = 0; start + count <= values.Length; start++)
                yield return values.Take(start).Concat(values.Skip(start + count)).ToArray();
    }
`;

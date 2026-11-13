using System;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
namespace Smoke;
internal static class TypedBinding {
 public static bool IsValid(JsonElement input) => true;
 public static Task<bool> Observe(JsonElement input) => Task.FromResult(Environment.GetEnvironmentVariable("TESTGEN_FAULT") != "1" && input.GetProperty("enabled").GetBoolean());
 public static Task<bool> Predicate(JsonElement input, bool actual) => Task.FromResult(actual == input.GetProperty("enabled").GetBoolean());
 public static Task<JsonElement> Transform(JsonElement input) {
  var node = JsonNode.Parse(input.GetRawText())!.AsObject();
  node["enabled"] = !input.GetProperty("enabled").GetBoolean();
  return Task.FromResult(JsonSerializer.SerializeToElement(node));
 }
 public static Task<bool> Relation(JsonElement source, JsonElement follow, bool before, bool after) => Task.FromResult(before != after);
 public static Task<bool> Reference(JsonElement input) => Task.FromResult(input.GetProperty("enabled").GetBoolean());
 public static Task<bool> Equivalent(JsonElement input, bool actual, bool expected) => Task.FromResult(actual == expected);
}

using System;
using System.Linq;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading.Tasks;
namespace Smoke;
internal static class StatefulBinding {
 public static Task<List<string>> CreateModel() => Task.FromResult(new List<string>());
 public static Task<HashSet<string>> CreateSystem() => Task.FromResult(new HashSet<string>());
 public static Task DisposeSystem(HashSet<string> system) { system.Clear(); return Task.CompletedTask; }
 public static bool IsEnabled(List<string> model, string operation, JsonElement args) => operation == "put" ? !model.Contains(args.GetString()!) : model.Contains(args.GetString()!);
 public static Task<List<string>> Transition(List<string> model, string operation, JsonElement args) {
  var next = model.ToList();
  if (operation == "put") next.Add(args.GetString()!); else next.Remove(args.GetString()!);
  return Task.FromResult(next);
 }
 public static Task Execute(HashSet<string> system, string operation, JsonElement args) {
  if (operation == "put") system.Add(args.GetString()!);
  else if (Environment.GetEnvironmentVariable("TESTGEN_FAULT") != "1") system.Remove(args.GetString()!);
  return Task.CompletedTask;
 }
 public static Task<string[]> Observe(HashSet<string> system) => Task.FromResult(system.OrderBy(value => value).ToArray());
 public static Task<bool> Equivalent(List<string> model, string[] observed) => Task.FromResult(model.OrderBy(value => value).SequenceEqual(observed));
}

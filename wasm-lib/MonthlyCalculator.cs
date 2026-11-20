using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SaveMyWallet.Wasm;

[SupportedOSPlatform("browser")]
public static partial class MonthlyCalculator
{
    // The frontend owns the runtime and calls the export after initialization.
    static void Main() { }

    [JSExport]
    public static string Summarize(string ledgerJson, string month)
    {
        var ledger = JsonSerializer.Deserialize(ledgerJson, LedgerJson.Default.Ledger)!;
        var byPlatform = new Dictionary<string, List<int>>(StringComparer.Ordinal);
        for (var i = 0; i < ledger.Entries.Length; i++)
        {
            var entry = ledger.Entries[i];
            if (entry.Month != month) continue;
            if (!byPlatform.TryGetValue(entry.PlatformId, out var indices))
            {
                indices = [];
                byPlatform.Add(entry.PlatformId, indices);
            }
            indices.Add(i);
        }

        var salary = ledger.SalaryOverrides.GetValueOrDefault(month) ?? ledger.Settings.DefaultSalaryCents;
        var summary = new MonthSummary(salary);
        for (var i = 0; i < ledger.Platforms.Length; i++)
        {
            if (!byPlatform.TryGetValue(ledger.Platforms[i].Id, out var indices)) continue;
            var group = new PlatformGroup(i, indices);
            foreach (var index in indices)
            {
                var entry = ledger.Entries[index];
                if (entry.Voided) continue;
                switch (entry.Status)
                {
                    case "due": group.Due += entry.AmountCents; break;
                    case "paid": group.Paid += entry.AmountCents; break;
                    case "estimated": group.Estimated += entry.AmountCents; break;
                    default: throw new JsonException($"Unknown payment status '{entry.Status}'.");
                }
            }
            summary.Due += group.Due;
            summary.Paid += group.Paid;
            summary.Estimated += group.Estimated;
            summary.Groups.Add(group);
        }
        return JsonSerializer.Serialize(summary, LedgerJson.Default.MonthSummary);
    }
}

internal record Ledger(Platform[] Platforms, Entry[] Entries, Settings Settings, Dictionary<string, long?> SalaryOverrides);
internal record Platform(string Id);
internal record Entry(string PlatformId, string Month, long AmountCents, string Status, bool Voided = false);
internal record Settings(long DefaultSalaryCents);

internal class Amounts
{
    public long Due { get; set; }
    public long Paid { get; set; }
    public long Estimated { get; set; }
    public long Total => Due + Paid + Estimated;
}

internal sealed class MonthSummary(long salary) : Amounts
{
    public long Salary => salary;
    public long Balance => salary - Total;
    public List<PlatformGroup> Groups { get; } = [];
}

internal sealed class PlatformGroup(int platformIndex, List<int> entryIndices) : Amounts
{
    public int PlatformIndex => platformIndex;
    public List<int> EntryIndices => entryIndices;
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(Ledger))]
[JsonSerializable(typeof(MonthSummary))]
internal partial class LedgerJson : JsonSerializerContext;

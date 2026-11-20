using System.Text.Json.Nodes;
using SaveMyWallet.Api.Dto;

namespace SaveMyWallet.Api.Core;

internal static class InstallmentSeries
{
    private sealed record Schedule(string PlatformId, string Title, long AmountCents, int Count, DateOnly FirstMonth)
    {
        internal static Schedule From(JsonObject entry, int index) => new(
            (string)entry["platformId"]!, (string)entry["title"]!, (long)entry["amountCents"]!,
            (int)entry["installmentCount"]!, LedgerRules.Month((string)entry["month"]!).AddMonths(1 - index));
    }

    internal static IEnumerable<SyncRecord> Find(IReadOnlyList<SyncRecord> rows, SyncRecord selected)
    {
        var entry = selected.Value!.AsObject();
        if ((string?)entry["kind"] != "installment") throw Unavailable();
        var installmentId = (string?)entry["installmentId"];
        var schedule = Schedule.From(entry, (int)entry["installmentIndex"]!);
        var periods = new SortedDictionary<int, SyncRecord>();
        foreach (var row in rows)
        {
            if (row.Kind != "entry" || row.Value is not JsonObject member ||
                (string?)member["kind"] != "installment" || (string?)member["installmentId"] != installmentId)
                continue;
            var index = (int)member["installmentIndex"]!;
            if (Schedule.From(member, index) != schedule)
            {
                if (installmentId is not null) throw Unavailable();
                continue;
            }
            if (!periods.TryAdd(index, row)) throw Unavailable();
        }
        // Individual records were validated on write, so every index is between 1 and Count.
        if (periods.Count != schedule.Count) throw Unavailable();
        return periods.Values;
    }

    private static LedgerException Unavailable() =>
        new(409, "installment_group_unavailable", "The complete installment schedule could not be identified.");

    internal static void ValidateNewMembers(IReadOnlyList<SyncRecord> current, IReadOnlyList<JsonObject> added)
    {
        var seriesIds = added.Select(entry => (string)entry["installmentId"]!).ToHashSet();
        var existing = current.Where(row => row.Kind == "entry").Select(row => row.Value).OfType<JsonObject>()
            .Where(entry => (string?)entry["installmentId"] is { } id && seriesIds.Contains(id));
        foreach (var series in added.Concat(existing).GroupBy(entry => (string)entry["installmentId"]!))
        {
            Schedule? expected = null;
            var indices = new HashSet<int>();
            foreach (var member in series)
            {
                var index = (int)member["installmentIndex"]!;
                var schedule = Schedule.From(member, index);
                expected ??= schedule;
                LedgerRules.Require(schedule == expected && indices.Add(index), "invalid_installment",
                    "Periods in an installment must share a schedule and have distinct indices.");
            }
        }
    }
}

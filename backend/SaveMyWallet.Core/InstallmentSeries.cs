using SaveMyWallet.Dto.EntityDto;
using SaveMyWallet.Dto.QueryResultDto;

namespace SaveMyWallet.Core;

internal static class InstallmentSeries
{
    private sealed record Schedule(string PlatformId, string Title, long AmountCents, int Count, DateOnly FirstMonth)
    {
        internal static Schedule From(BillEntryQueryResultDto entry) => new(
            entry.PlatformId, entry.Title, entry.AmountCents, entry.InstallmentCount!.Value,
            LedgerRules.Month(entry.Month).AddMonths(1 - entry.InstallmentIndex!.Value));
    }

    internal static IEnumerable<(SyncRecordEntityDto Row, BillEntryQueryResultDto Entry)> Find(
        IReadOnlyList<SyncRecordEntityDto> rows, SyncRecordEntityDto selected)
    {
        var selectedEntry = LedgerValues.ReadEntry(selected.Value);
        if (selectedEntry.Kind != "installment") throw Unavailable();
        var schedule = Schedule.From(selectedEntry);
        var periods = new SortedDictionary<int, (SyncRecordEntityDto, BillEntryQueryResultDto)>();
        foreach (var row in rows)
        {
            if (row.Kind != "entry" || row.Value is null) continue;
            var member = ReferenceEquals(row, selected) ? selectedEntry : LedgerValues.ReadEntry(row.Value);
            if (member.Kind != "installment" || member.InstallmentId != selectedEntry.InstallmentId) continue;
            if (Schedule.From(member) != schedule)
            {
                if (selectedEntry.InstallmentId is not null) throw Unavailable();
                continue;
            }
            if (!periods.TryAdd(member.InstallmentIndex!.Value, (row, member))) throw Unavailable();
        }
        // Individual records were validated on write, so every index is between 1 and Count.
        if (periods.Count != schedule.Count) throw Unavailable();
        return periods.Values;
    }

    private static LedgerException Unavailable() =>
        new(409, "installment_group_unavailable", "The complete installment schedule could not be identified.");

    internal static void ValidateNewMembers(IReadOnlyList<SyncRecordEntityDto> current, IReadOnlyList<BillEntryQueryResultDto> added)
    {
        var seriesIds = added.Select(entry => entry.InstallmentId!).ToHashSet();
        var existing = current.Where(row => row.Kind == "entry" && row.Value is not null)
            .Select(row => LedgerValues.ReadEntry(row.Value))
            .Where(entry => entry.InstallmentId is { } id && seriesIds.Contains(id));
        foreach (var series in added.Concat(existing).GroupBy(entry => entry.InstallmentId))
        {
            Schedule? expected = null;
            var indices = new HashSet<int>();
            foreach (var member in series)
            {
                var schedule = Schedule.From(member);
                expected ??= schedule;
                LedgerRules.Require(schedule == expected && indices.Add(member.InstallmentIndex!.Value), "invalid_installment",
                    "Periods in an installment must share a schedule and have distinct indices.");
            }
        }
    }
}

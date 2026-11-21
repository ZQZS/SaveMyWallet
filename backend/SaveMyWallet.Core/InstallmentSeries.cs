using SaveMyWallet.Dto;
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
        IReadOnlyList<SyncRecordEntityDto> rows, BillEntryQueryResultDto selected)
    {
        if (selected.Kind != BillKind.Installment || selected.InstallmentId is null) throw Unavailable();
        var periods = new SortedDictionary<int, (SyncRecordEntityDto, BillEntryQueryResultDto)>();
        foreach (var row in rows)
        {
            if (row.Value is not BillEntryQueryResultDto member || member.InstallmentId != selected.InstallmentId) continue;
            if (!periods.TryAdd(member.InstallmentIndex!.Value, (row, member))) throw Unavailable();
        }
        // A series may have been submitted in separate batches or entered from a later period.
        if (periods.Count != selected.InstallmentCount) throw Unavailable();
        return periods.Values;
    }

    private static LedgerException Unavailable() =>
        new(409, "installment_group_unavailable", "The complete installment schedule could not be identified.");

    internal static void ValidateNewMembers(IReadOnlyList<SyncRecordEntityDto> current, IReadOnlyList<BillEntryQueryResultDto> added)
    {
        var seriesIds = added.Select(entry => entry.InstallmentId!).ToHashSet(StringComparer.Ordinal);
        var existing = current.Select(row => row.Value).OfType<BillEntryQueryResultDto>()
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

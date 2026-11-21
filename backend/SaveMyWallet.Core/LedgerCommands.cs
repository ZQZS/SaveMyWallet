using System.Globalization;
using SaveMyWallet.Constant;
using SaveMyWallet.Dto;
using SaveMyWallet.Dto.EntityDto;
using SaveMyWallet.Dto.QueryDto;
using SaveMyWallet.Dto.QueryResultDto;

namespace SaveMyWallet.Core;

public static class LedgerCommands
{
    public static RestMutationEntityDto<PlatformCreatedQueryResultDto> CreatePlatform(IReadOnlyList<SyncRecordEntityDto> rows, NewPlatformQueryDto input)
    {
        var name = LedgerRules.CleanText(input.Name, 40);
        var id = LedgerRules.PlatformId(name);
        if (rows.Any(r => r.Kind == SyncRecordKind.Platform && r.Id == id && r.Value is not null))
            throw new LedgerException(409, "duplicate_platform", "A platform with this ID already exists.");
        var value = new PlatformQueryResultDto(id, name);
        return new([new SyncChangeQueryDto(SyncRecordKind.Platform, id, null, null, value)], new PlatformCreatedQueryResultDto(id));
    }

    public static RestMutationEntityDto CreateBills(NewBillQueryDto?[] inputs)
    {
        LedgerRules.Require(inputs.Length > 0, "invalid_bills", "Supply at least one bill.");
        var changes = new List<SyncChangeQueryDto>();
        foreach (var input in inputs)
        {
            if (input is null) throw new LedgerException(400, "invalid_bills", "A bill is required for each item.");
            changes.AddRange(CreateBill(input).Changes);
        }
        return new(changes);
    }

    public static RestMutationEntityDto CreateBill(NewBillQueryDto input)
    {
        LedgerRules.ValidateId(input.PlatformId);
        var title = LedgerRules.CleanText(input.Title, 120);
        var start = LedgerRules.Month(input.Month);
        var split = input.Kind == BillKind.Installment;
        if (input.Kind == BillKind.Estimate)
            LedgerRules.ValidateEstimateAmounts(input.AmountCents, input.DepositCents ?? 0, input.TotalCents);
        else
            LedgerRules.Require(input.TotalCents is null && input.DepositCents is null,
                "invalid_deposit", "Only an estimate has a purchase total and deposit.");
        LedgerRules.Require(split ? input.InstallmentCount is >= 1 and <= 120 : input.Kind is BillKind.Single or BillKind.Estimate,
                            "invalid_installment", "Invalid bill kind or number of periods.");
        // The native ledger ignores the form's installment count for single bills and estimates.
        var periods = split ? (int)input.InstallmentCount : 1;
        var firstIndex = input.InstallmentIndex ?? 1;
        LedgerRules.Require((split || input.InstallmentIndex is null) && firstIndex >= 1 && firstIndex <= periods,
                            "invalid_installment", "Only installments may specify a current period, from 1 to the total.");
        var installmentId = split ? Guid.NewGuid().ToString("N") : null;
        var changes = new List<SyncChangeQueryDto>(periods - firstIndex + 1);
        for (var index = firstIndex; index <= periods; index++)
        {
            var id = Guid.NewGuid().ToString("N");
            var entry = new BillEntryQueryResultDto
            {
                Id = id,
                PlatformId = input.PlatformId,
                Title = title,
                Month = start.AddMonths(index - firstIndex).ToString("yyyy-MM", CultureInfo.InvariantCulture),
                AmountCents = input.AmountCents,
                Kind = input.Kind,
                Status = input.Kind == BillKind.Estimate ? BillStatus.Estimated : BillStatus.Due,
                InstallmentIndex = split ? index : null,
                InstallmentCount = split ? periods : null,
                InstallmentId = installmentId,
                DepositCents = input.DepositCents is > 0 ? input.DepositCents : null
            };
            changes.Add(new(SyncRecordKind.Entry, id, null, null, entry));
        }
        return new(changes);
    }

    public static RestMutationEntityDto Confirm(IReadOnlyList<SyncRecordEntityDto> rows, string id, ConfirmationQueryDto input)
    {
        var title = LedgerRules.CleanText(input.Title, 120);
        LedgerRules.Month(input.Month);
        var (row, entry) = FindEntry(rows, id);
        if (entry.Voided == true) throw new LedgerException(409, "entry_voided", "Restore this bill before confirming it.");
        LedgerRules.Require(entry.Kind == BillKind.Estimate, "invalid_kind", "Only estimates may be confirmed.");
        var oldDeposit = entry.DepositCents ?? 0;
        var deposit = input.DepositCents ?? oldDeposit;
        LedgerRules.ValidateEstimateAmounts(input.AmountCents, deposit, input.TotalCents);
        if (entry.Status != BillStatus.Estimated)
        {
            if (entry.Title == title && entry.Month == input.Month
                && deposit == oldDeposit && entry.AmountCents == input.AmountCents)
                return new([]);
            throw new LedgerException(409, "already_confirmed", "This estimate was confirmed with different details.");
        }
        var confirmed = entry.Copy();
        confirmed.Title = title;
        confirmed.Month = input.Month;
        confirmed.AmountCents = input.AmountCents;
        confirmed.DepositCents = deposit == 0 ? null : deposit;
        confirmed.Status = input.AmountCents == 0 ? BillStatus.Paid : BillStatus.Due;
        return new([EntryChange(row, confirmed)]);
    }

    public static RestMutationEntityDto SetVoided(IReadOnlyList<SyncRecordEntityDto> rows, string id, bool voided)
    {
        var (row, entry) = FindEntry(rows, id);
        var change = VoidChange(row, entry, voided);
        return new(change is null ? [] : [change]);
    }

    public static RestMutationEntityDto<ChangedIdsQueryResultDto> VoidBills(IReadOnlyList<SyncRecordEntityDto> rows, VoidBillsQueryDto input)
    {
        LedgerRules.Require(input.Ids is not null, "invalid_ids", "Supply the entry IDs to void.");
        var entries = rows.Where(r => r.Kind == SyncRecordKind.Entry).ToDictionary(r => r.Id, StringComparer.Ordinal);
        var selected = input.Ids!.Distinct(StringComparer.Ordinal).Select(id =>
        {
            LedgerRules.ValidateId(id);
            return RequireEntry(entries.GetValueOrDefault(id));
        });
        return ApplyVoidChanges(selected, true);
    }

    public static RestMutationEntityDto<ChangedIdsQueryResultDto> SetInstallmentVoided(IReadOnlyList<SyncRecordEntityDto> rows, string id, bool voided) =>
        ApplyVoidChanges(InstallmentSeries.Find(rows, FindEntry(rows, id).Entry), voided);

    private static RestMutationEntityDto<ChangedIdsQueryResultDto> ApplyVoidChanges(
        IEnumerable<(SyncRecordEntityDto Row, BillEntryQueryResultDto Entry)> selected, bool voided)
    {
        var changes = new List<SyncChangeQueryDto>();
        var changedIds = new List<string>();
        foreach (var (row, entry) in selected)
        {
            if (VoidChange(row, entry, voided) is not { } change) continue;
            changes.Add(change);
            changedIds.Add(row.Id);
        }
        return new(changes, new ChangedIdsQueryResultDto(changedIds));
    }

    private static SyncChangeQueryDto? VoidChange(SyncRecordEntityDto row, BillEntryQueryResultDto entry, bool voided)
    {
        if (entry.Voided.GetValueOrDefault() == voided) return null;
        var updated = entry.Copy();
        updated.Voided = voided ? true : null;
        return EntryChange(row, updated);
    }

    private static SyncChangeQueryDto EntryChange(SyncRecordEntityDto row, BillEntryQueryResultDto entry) =>
        new(SyncRecordKind.Entry, row.Id, row.Version, row.Value, entry);

    private static (SyncRecordEntityDto Row, BillEntryQueryResultDto Entry) FindEntry(IReadOnlyList<SyncRecordEntityDto> rows, string id) =>
        RequireEntry(rows.FirstOrDefault(r => r.Kind == SyncRecordKind.Entry && r.Id == id));

    private static (SyncRecordEntityDto Row, BillEntryQueryResultDto Entry) RequireEntry(SyncRecordEntityDto? row)
    {
        if (row?.Value is BillEntryQueryResultDto entry) return (row, entry);
        throw new LedgerException(404, "unknown_entry", "Bill not found.");
    }

    public static RestMutationEntityDto<ChangedIdsQueryResultDto> Pay(IReadOnlyList<SyncRecordEntityDto> rows, PaymentQueryDto input)
    {
        LedgerRules.Require(input.Ids is not null, "invalid_ids", "Supply the entry IDs to update.");
        var entries = rows.Where(r => r.Kind == SyncRecordKind.Entry).ToDictionary(r => r.Id);
        var fromStatus = input.Paid ? BillStatus.Due : BillStatus.Paid;
        var changes = new List<SyncChangeQueryDto>();
        var changedIds = new List<string>();
        foreach (var id in input.Ids!.Distinct(StringComparer.Ordinal))
        {
            LedgerRules.ValidateId(id);
            if (!entries.TryGetValue(id, out var row) || row.Value is not BillEntryQueryResultDto entry) continue;
            if (entry.Voided == true || entry.AmountCents == 0 || entry.Status != fromStatus) continue;
            var updated = entry.Copy();
            updated.Status = input.Paid ? BillStatus.Paid : BillStatus.Due;
            changes.Add(EntryChange(row, updated));
            changedIds.Add(id);
        }
        return new(changes, new ChangedIdsQueryResultDto(changedIds));
    }

    public static RestMutationEntityDto SaveBudget(IReadOnlyList<SyncRecordEntityDto> rows, BudgetQueryDto input)
    {
        LedgerRules.Month(input.Month);
        var amounts = new (SyncRecordKind Kind, string Id, long? Amount)[]
        {
            (SyncRecordKind.Setting, LedgerConstants.DefaultSalary, input.DefaultSalaryCents),
            (SyncRecordKind.Setting, LedgerConstants.WarningFloor, input.WarningFloorCents),
            (SyncRecordKind.Override, input.Month, input.OverrideSalaryCents)
        };
        var changes = new List<SyncChangeQueryDto>();
        foreach (var (kind, id, amount) in amounts)
        {
            var row = rows.FirstOrDefault(r => r.Kind == kind && r.Id == id);
            var previousAmount = (row?.Value as AmountQueryResultDto)?.Cents;
            if (amount != previousAmount)
                changes.Add(new(kind, id, row?.Version, row?.Value,
                    amount.HasValue ? new AmountQueryResultDto(amount.Value) : null));
        }
        return new(changes);
    }
}

using System.Globalization;
using SaveMyWallet.Constant;
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
        if (rows.Any(r => r.Kind == "platform" && r.Id == id && r.Value is not null))
            throw new LedgerException(409, "duplicate_platform", "A platform with this ID already exists.");
        var value = LedgerValues.Encode(new PlatformQueryResultDto(id, name));
        return new([new SyncChangeQueryDto("platform", id, null, null, value)], new PlatformCreatedQueryResultDto(id));
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
        var split = input.Kind == "installment";
        if (input.Kind == "estimate")
            LedgerRules.ValidateEstimateAmounts(input.AmountCents, input.DepositCents ?? 0, input.TotalCents);
        else
            LedgerRules.Require(input.TotalCents is null && input.DepositCents is null,
                "invalid_deposit", "Only an estimate has a purchase total and deposit.");
        LedgerRules.Require(split ? input.InstallmentCount is >= 1 and <= 120 : input.Kind is "single" or "estimate",
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
                Status = input.Kind == "estimate" ? "estimated" : "due",
                InstallmentIndex = split ? index : null,
                InstallmentCount = split ? periods : null,
                InstallmentId = installmentId,
                DepositCents = input.DepositCents is > 0 ? input.DepositCents : null
            };
            changes.Add(new("entry", id, null, null, LedgerValues.Encode(entry)));
        }
        return new(changes);
    }

    public static RestMutationEntityDto Confirm(IReadOnlyList<SyncRecordEntityDto> rows, string id, ConfirmationQueryDto input)
    {
        var title = LedgerRules.CleanText(input.Title, 120);
        LedgerRules.Month(input.Month);
        var row = FindEntry(rows, id);
        var entry = LedgerValues.ReadEntry(row.Value);
        if (entry.Voided == true) throw new LedgerException(409, "entry_voided", "Restore this bill before confirming it.");
        LedgerRules.Require(entry.Kind == "estimate", "invalid_kind", "Only estimates may be confirmed.");
        var oldDeposit = entry.DepositCents ?? 0;
        var deposit = input.DepositCents ?? oldDeposit;
        LedgerRules.ValidateEstimateAmounts(input.AmountCents, deposit, input.TotalCents);
        if (entry.Status != "estimated")
        {
            if (entry.Title == title && entry.Month == input.Month
                && deposit == oldDeposit && entry.AmountCents == input.AmountCents)
                return new([]);
            throw new LedgerException(409, "already_confirmed", "This estimate was confirmed with different details.");
        }
        entry.Title = title;
        entry.Month = input.Month;
        entry.AmountCents = input.AmountCents;
        entry.DepositCents = deposit == 0 ? null : deposit;
        entry.Status = input.AmountCents == 0 ? "paid" : "due";
        return new([EntryChange(row, entry)]);
    }

    public static RestMutationEntityDto SetVoided(IReadOnlyList<SyncRecordEntityDto> rows, string id, bool voided)
    {
        var row = FindEntry(rows, id);
        var change = VoidChange(row, LedgerValues.ReadEntry(row.Value), voided);
        return new(change is null ? [] : [change]);
    }

    public static RestMutationEntityDto<ChangedIdsQueryResultDto> SetInstallmentVoided(IReadOnlyList<SyncRecordEntityDto> rows, string id, bool voided)
    {
        var changes = new List<SyncChangeQueryDto>();
        var changedIds = new List<string>();
        foreach (var (row, entry) in InstallmentSeries.Find(rows, FindEntry(rows, id)))
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
        entry.Voided = voided ? true : null;
        return EntryChange(row, entry);
    }

    private static SyncChangeQueryDto EntryChange(SyncRecordEntityDto row, BillEntryQueryResultDto entry) =>
        new("entry", row.Id, row.Version, row.Value, LedgerValues.Encode(entry));

    private static SyncRecordEntityDto FindEntry(IReadOnlyList<SyncRecordEntityDto> rows, string id) =>
        rows.FirstOrDefault(r => r.Kind == "entry" && r.Id == id && r.Value is not null)
        ?? throw new LedgerException(404, "unknown_entry", "Bill not found.");

    public static RestMutationEntityDto<ChangedIdsQueryResultDto> Pay(IReadOnlyList<SyncRecordEntityDto> rows, PaymentQueryDto input)
    {
        LedgerRules.Require(input.Ids is not null, "invalid_ids", "Supply the entry IDs to update.");
        var entries = rows.Where(r => r.Kind == "entry" && r.Value is not null).ToDictionary(r => r.Id);
        var fromStatus = input.Paid ? "due" : "paid";
        var changes = new List<SyncChangeQueryDto>();
        var changedIds = new List<string>();
        foreach (var id in input.Ids!.Distinct(StringComparer.Ordinal))
        {
            LedgerRules.ValidateId(id);
            if (!entries.TryGetValue(id, out var row)) continue;
            var entry = LedgerValues.ReadEntry(row.Value);
            if (entry.Voided == true || entry.AmountCents == 0 || entry.Status != fromStatus) continue;
            entry.Status = input.Paid ? "paid" : "due";
            changes.Add(EntryChange(row, entry));
            changedIds.Add(id);
        }
        return new(changes, new ChangedIdsQueryResultDto(changedIds));
    }

    public static RestMutationEntityDto SaveBudget(IReadOnlyList<SyncRecordEntityDto> rows, BudgetQueryDto input)
    {
        LedgerRules.Month(input.Month);
        var amounts = new (string Kind, string Id, long? Amount)[]
        {
            ("setting", LedgerConstants.DefaultSalary, input.DefaultSalaryCents),
            ("setting", LedgerConstants.WarningFloor, input.WarningFloorCents),
            ("override", input.Month, input.OverrideSalaryCents)
        };
        var changes = new List<SyncChangeQueryDto>();
        foreach (var (kind, id, amount) in amounts)
        {
            var row = rows.FirstOrDefault(r => r.Kind == kind && r.Id == id);
            long? previousAmount = row?.Value is { } stored ? LedgerValues.ReadAmount(stored) : null;
            if (amount != previousAmount)
                changes.Add(new(kind, id, row?.Version, row?.Value,
                    amount.HasValue ? LedgerValues.Encode(amount.Value) : null));
        }
        return new(changes);
    }
}

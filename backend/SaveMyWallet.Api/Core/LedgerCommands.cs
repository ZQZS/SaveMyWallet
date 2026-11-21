using System.Globalization;
using System.Text.Json.Nodes;
using SaveMyWallet.Api.Dto;

namespace SaveMyWallet.Api.Core;

internal static class LedgerCommands
{
    internal static RestMutation CreatePlatform(IReadOnlyList<SyncRecord> rows, NewPlatform input)
    {
        var name = LedgerRules.CleanText(input.Name, 40);
        var id = LedgerRules.PlatformId(name);
        if (rows.Any(r => r.Kind == "platform" && r.Id == id && r.Value is not null))
            throw new LedgerException(409, "duplicate_platform", "A platform with this ID already exists.");
        var value = new JsonObject { ["id"] = id, ["name"] = name };
        return new RestMutation([new SyncChange("platform", id, null, null, value)], new JsonObject { ["id"] = id });
    }

    internal static RestMutation CreateBill(NewBill input)
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
        var installmentId = split ? Guid.NewGuid().ToString("N") : null;
        var changes = new List<SyncChange>(periods);
        for (var i = 0; i < periods; i++)
        {
            var id = Guid.NewGuid().ToString("N");
            var value = new JsonObject
            {
                ["id"] = id, ["platformId"] = input.PlatformId, ["title"] = title,
                ["month"] = start.AddMonths(i).ToString("yyyy-MM", CultureInfo.InvariantCulture),
                ["amountCents"] = input.AmountCents, ["kind"] = input.Kind,
                ["status"] = input.Kind == "estimate" ? "estimated" : "due",
                ["installmentIndex"] = split ? JsonValue.Create(i + 1) : null,
                ["installmentCount"] = split ? JsonValue.Create(periods) : null
            };
            if (installmentId is not null) value["installmentId"] = installmentId;
            if (input.DepositCents is > 0) value["depositCents"] = input.DepositCents.Value;
            changes.Add(new("entry", id, null, null, value));
        }
        return new(changes, null);
    }

    internal static RestMutation Confirm(IReadOnlyList<SyncRecord> rows, string id, Confirmation input)
    {
        var title = LedgerRules.CleanText(input.Title, 120);
        LedgerRules.Month(input.Month);
        var row = FindEntry(rows, id);
        var current = row.Value!.AsObject();
        if (current.ContainsKey("voided")) throw new LedgerException(409, "entry_voided", "Restore this bill before confirming it.");
        LedgerRules.Require(LedgerRules.Text(current["kind"], "kind") == "estimate", "invalid_kind", "Only estimates may be confirmed.");
        var oldDeposit = current["depositCents"]?.GetValue<long>() ?? 0;
        var deposit = input.DepositCents ?? oldDeposit;
        LedgerRules.ValidateEstimateAmounts(input.AmountCents, deposit, input.TotalCents);
        if (LedgerRules.Text(current["status"], "status") != "estimated")
        {
            if (LedgerRules.Text(current["title"], "title") == title
                && LedgerRules.Text(current["month"], "month") == input.Month
                && deposit == oldDeposit
                && JsonNode.DeepEquals(current["amountCents"], JsonValue.Create(input.AmountCents)))
                return new([], null);
            throw new LedgerException(409, "already_confirmed", "This estimate was confirmed with different details.");
        }
        var updated = current.DeepClone().AsObject();
        updated["title"] = title;
        updated["month"] = input.Month;
        updated["amountCents"] = input.AmountCents;
        if (deposit == 0) updated.Remove("depositCents");
        else updated["depositCents"] = deposit;
        updated["status"] = input.AmountCents == 0 ? "paid" : "due";
        return new([new SyncChange("entry", id, row.Version, current, updated)], null);
    }

    internal static RestMutation SetVoided(IReadOnlyList<SyncRecord> rows, string id, bool voided)
    {
        var change = VoidChange(FindEntry(rows, id), voided);
        return new(change is null ? [] : [change], null);
    }

    internal static RestMutation SetInstallmentVoided(IReadOnlyList<SyncRecord> rows, string id, bool voided)
    {
        var changes = new List<SyncChange>();
        var changedIds = new JsonArray();
        foreach (var period in InstallmentSeries.Find(rows, FindEntry(rows, id)))
        {
            if (VoidChange(period, voided) is not { } change) continue;
            changes.Add(change);
            changedIds.Add(period.Id);
        }
        return new(changes, new JsonObject { ["changedIds"] = changedIds });
    }

    private static SyncChange? VoidChange(SyncRecord row, bool voided)
    {
        var current = row.Value!.AsObject();
        if (current.ContainsKey("voided") == voided) return null;
        var updated = current.DeepClone().AsObject();
        if (voided) updated["voided"] = true;
        else updated.Remove("voided");
        return new("entry", row.Id, row.Version, current, updated);
    }

    private static SyncRecord FindEntry(IReadOnlyList<SyncRecord> rows, string id) =>
        rows.FirstOrDefault(r => r.Kind == "entry" && r.Id == id && r.Value is JsonObject)
        ?? throw new LedgerException(404, "unknown_entry", "Bill not found.");

    internal static RestMutation Pay(IReadOnlyList<SyncRecord> rows, Payment input)
    {
        LedgerRules.Require(input.Ids is not null, "invalid_ids", "Supply the entry IDs to update.");
        var entries = rows.Where(r => r.Kind == "entry" && r.Value is JsonObject value && !value.ContainsKey("voided"))
            .ToDictionary(r => r.Id);
        var changes = new List<SyncChange>();
        var changedIds = new JsonArray();
        foreach (var id in input.Ids!.Distinct(StringComparer.Ordinal))
        {
            LedgerRules.ValidateId(id);
            if (!entries.TryGetValue(id, out var row)) continue;
            if (row.Value!["amountCents"]!.GetValue<long>() == 0) continue;
            if (LedgerRules.Text(row.Value!["status"], "status") != (input.Paid ? "due" : "paid")) continue;
            var updated = row.Value!.DeepClone().AsObject();
            updated["status"] = input.Paid ? "paid" : "due";
            changes.Add(new("entry", id, row.Version, row.Value, updated));
            changedIds.Add(id);
        }
        return new(changes, new JsonObject { ["changedIds"] = changedIds });
    }

    internal static RestMutation SaveBudget(IReadOnlyList<SyncRecord> rows, Budget input)
    {
        LedgerRules.Month(input.Month);
        var amounts = new (string Kind, string Id, long? Amount)[]
        {
            ("setting", LedgerRules.DefaultSalary, input.DefaultSalaryCents),
            ("setting", LedgerRules.WarningFloor, input.WarningFloorCents),
            ("override", input.Month, input.OverrideSalaryCents)
        };
        var changes = new List<SyncChange>();
        foreach (var (kind, id, amount) in amounts)
        {
            var row = rows.FirstOrDefault(r => r.Kind == kind && r.Id == id);
            var value = amount.HasValue ? JsonValue.Create(amount.Value) : null;
            if (!JsonNode.DeepEquals(value, row?.Value))
                changes.Add(new(kind, id, row?.Version, row?.Value, value));
        }
        return new(changes, null);
    }
}

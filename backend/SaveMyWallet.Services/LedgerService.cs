using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using SaveMyWallet.Core;
using SaveMyWallet.Dto;
using SaveMyWallet.Interfaces;

namespace SaveMyWallet.Services;

public sealed class LedgerService(ISyncStore store) : ILedgerService
{
    public async Task<LedgerSnapshot> GetLedgerAsync(string ledgerId, CancellationToken ct)
    {
        var snapshot = await store.BootstrapAsync(ledgerId, ct);
        var rows = snapshot.Records.Where(r => r.Value is not null).ToList();
        var settings = rows.Where(r => r.Kind == "setting").ToDictionary(r => r.Id, r => r.Value!);
        return new LedgerSnapshot(
            rows.Where(r => r.Kind == "platform").Select(r => r.Value!).ToArray(),
            rows.Where(r => r.Kind == "entry").Select(r => r.Value!).ToArray(),
            new LedgerSettings(
                settings.GetValueOrDefault(LedgerRules.DefaultSalary) ?? JsonValue.Create(0),
                settings.GetValueOrDefault(LedgerRules.WarningFloor) ?? JsonValue.Create(0)),
            rows.Where(r => r.Kind == "override").ToDictionary(r => r.Id, r => r.Value!));
    }

    public Task<JsonNode?> CreatePlatformAsync(string ledgerId, string operationId, NewPlatform input, CancellationToken ct) =>
        WriteAsync(ledgerId, operationId, "POST /platforms", input, rows => LedgerCommands.CreatePlatform(rows, input), ct);

    public Task<JsonNode?> CreateBillAsync(string ledgerId, string operationId, NewBill input, CancellationToken ct) =>
        WriteAsync(ledgerId, operationId, "POST /bills", input, _ => LedgerCommands.CreateBill(input), ct);

    public Task<JsonNode?> CreateBillsAsync(string ledgerId, string operationId, NewBill?[] inputs, CancellationToken ct) =>
        WriteAsync(ledgerId, operationId, "POST /bills/batch", inputs, _ => LedgerCommands.CreateBills(inputs), ct);

    public Task<JsonNode?> ConfirmAsync(string ledgerId, string operationId, string id, Confirmation input, CancellationToken ct) =>
        WriteAsync(ledgerId, operationId, "POST /bills/confirm", new { id, input },
            rows => LedgerCommands.Confirm(rows, id, input), ct);

    public Task<JsonNode?> SetVoidedAsync(string ledgerId, string operationId, string id, BillValidity input, CancellationToken ct) =>
        WriteAsync(ledgerId, operationId, "PUT /bills/voided", new { id, input },
            rows => LedgerCommands.SetVoided(rows, id, input.Voided), ct);

    public Task<JsonNode?> SetInstallmentVoidedAsync(string ledgerId, string operationId, string id, BillValidity input, CancellationToken ct) =>
        WriteAsync(ledgerId, operationId, "PUT /bills/installment/voided", new { id, input },
            rows => LedgerCommands.SetInstallmentVoided(rows, id, input.Voided), ct);

    public Task<JsonNode?> PayAsync(string ledgerId, string operationId, Payment input, CancellationToken ct) =>
        WriteAsync(ledgerId, operationId, "PATCH /payments", input, rows => LedgerCommands.Pay(rows, input), ct);

    public Task<JsonNode?> SaveBudgetAsync(string ledgerId, string operationId, Budget input, CancellationToken ct) =>
        WriteAsync(ledgerId, operationId, "PUT /budget", input, rows => LedgerCommands.SaveBudget(rows, input), ct);

    private Task<JsonNode?> WriteAsync<T>(string ledgerId, string operationId, string action, T input,
        Func<IReadOnlyList<SyncRecord>, RestMutation> build, CancellationToken ct)
    {
        SyncRules.CheckOperationId(operationId);
        // Existing receipts use these action strings and the default JSON property casing.
        var fingerprint = Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new { action, input })));
        return store.ExecuteRestAsync(ledgerId, operationId, fingerprint, build, ct);
    }
}

using System.Security.Cryptography;
using System.Text.Json;
using SaveMyWallet.Constant;
using SaveMyWallet.Core;
using SaveMyWallet.Dto;
using SaveMyWallet.Dto.QueryDto;
using SaveMyWallet.Dto.QueryResultDto;
using SaveMyWallet.Dto.Serialization;
using SaveMyWallet.Interfaces;

namespace SaveMyWallet.Services;

public sealed class LedgerService(ISyncStore store) : ILedgerService
{
    public async Task<LedgerSnapshotQueryResultDto> GetLedgerAsync(string ledgerId, CancellationToken ct)
    {
        var snapshot = await store.BootstrapAsync(ledgerId, ct);
        var records = snapshot.Records;
        var amounts = records.OfType<SyncRecordQueryResultDto<long?>>().Where(r => r.Value.HasValue);
        var settings = amounts.Where(r => r.Kind == SyncRecordKind.Setting).ToDictionary(r => r.Id, r => r.Value!.Value);
        return new LedgerSnapshotQueryResultDto(
            records.OfType<SyncRecordQueryResultDto<PlatformQueryResultDto?>>()
                .Select(r => r.Value).OfType<PlatformQueryResultDto>().ToArray(),
            records.OfType<SyncRecordQueryResultDto<BillEntryQueryResultDto?>>()
                .Select(r => r.Value).OfType<BillEntryQueryResultDto>().ToArray(),
            new LedgerSettingsQueryResultDto(
                settings.GetValueOrDefault(LedgerConstants.DefaultSalary),
                settings.GetValueOrDefault(LedgerConstants.WarningFloor)),
            amounts.Where(r => r.Kind == SyncRecordKind.Override).ToDictionary(r => r.Id, r => r.Value!.Value));
    }

    public Task<PlatformCreatedQueryResultDto> CreatePlatformAsync(string ledgerId, string operationId, NewPlatformQueryDto input, CancellationToken ct) =>
        store.ExecuteRestAsync(ledgerId, operationId, Fingerprint(operationId, "POST /platforms", input),
            rows => LedgerCommands.CreatePlatform(rows, input), ct);

    public Task CreateBillAsync(string ledgerId, string operationId, NewBillQueryDto input, CancellationToken ct) =>
        store.ExecuteRestAsync(ledgerId, operationId, Fingerprint(operationId, "POST /bills", input),
            _ => LedgerCommands.CreateBill(input), ct);

    public Task CreateBillsAsync(string ledgerId, string operationId, NewBillQueryDto?[] inputs, CancellationToken ct) =>
        store.ExecuteRestAsync(ledgerId, operationId, Fingerprint(operationId, "POST /bills/batch", inputs),
            _ => LedgerCommands.CreateBills(inputs), ct);

    public Task ConfirmAsync(string ledgerId, string operationId, string id, ConfirmationQueryDto input, CancellationToken ct) =>
        store.ExecuteRestAsync(ledgerId, operationId, Fingerprint(operationId, "POST /bills/confirm", new { id, input }),
            rows => LedgerCommands.Confirm(rows, id, input), ct);

    public Task SetVoidedAsync(string ledgerId, string operationId, string id, BillValidityQueryDto input, CancellationToken ct) =>
        store.ExecuteRestAsync(ledgerId, operationId, Fingerprint(operationId, "PUT /bills/voided", new { id, input }),
            rows => LedgerCommands.SetVoided(rows, id, input.Voided), ct);

    public Task<ChangedIdsQueryResultDto> SetInstallmentVoidedAsync(string ledgerId, string operationId, string id, BillValidityQueryDto input, CancellationToken ct) =>
        store.ExecuteRestAsync(ledgerId, operationId, Fingerprint(operationId, "PUT /bills/installment/voided", new { id, input }),
            rows => LedgerCommands.SetInstallmentVoided(rows, id, input.Voided), ct);

    public Task<ChangedIdsQueryResultDto> PayAsync(string ledgerId, string operationId, PaymentQueryDto input, CancellationToken ct) =>
        store.ExecuteRestAsync(ledgerId, operationId, Fingerprint(operationId, "PATCH /payments", input),
            rows => LedgerCommands.Pay(rows, input), ct);

    public Task SaveBudgetAsync(string ledgerId, string operationId, BudgetQueryDto input, CancellationToken ct) =>
        store.ExecuteRestAsync(ledgerId, operationId, Fingerprint(operationId, "PUT /budget", input),
            rows => LedgerCommands.SaveBudget(rows, input), ct);

    private static string Fingerprint<T>(string operationId, string action, T input)
    {
        SyncRules.CheckOperationId(operationId);
        return Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new { action, input }, LedgerJson.Options)));
    }
}

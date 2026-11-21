using System.Text.Json.Nodes;
using SaveMyWallet.Dto;

namespace SaveMyWallet.Interfaces;

public interface ILedgerService
{
    Task<LedgerSnapshot> GetLedgerAsync(string ledgerId, CancellationToken ct);
    Task<JsonNode?> CreatePlatformAsync(string ledgerId, string operationId, NewPlatform input, CancellationToken ct);
    Task<JsonNode?> CreateBillAsync(string ledgerId, string operationId, NewBill input, CancellationToken ct);
    Task<JsonNode?> CreateBillsAsync(string ledgerId, string operationId, NewBill?[] inputs, CancellationToken ct);
    Task<JsonNode?> ConfirmAsync(string ledgerId, string operationId, string id, Confirmation input, CancellationToken ct);
    Task<JsonNode?> SetVoidedAsync(string ledgerId, string operationId, string id, BillValidity input, CancellationToken ct);
    Task<JsonNode?> SetInstallmentVoidedAsync(string ledgerId, string operationId, string id, BillValidity input, CancellationToken ct);
    Task<JsonNode?> PayAsync(string ledgerId, string operationId, Payment input, CancellationToken ct);
    Task<JsonNode?> SaveBudgetAsync(string ledgerId, string operationId, Budget input, CancellationToken ct);
}

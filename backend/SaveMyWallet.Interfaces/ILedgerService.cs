using SaveMyWallet.Dto.QueryDto;
using SaveMyWallet.Dto.QueryResultDto;

namespace SaveMyWallet.Interfaces;

public interface ILedgerService
{
    Task<LedgerSnapshotQueryResultDto> GetLedgerAsync(string ledgerId, CancellationToken ct);
    Task<PlatformCreatedQueryResultDto> CreatePlatformAsync(string ledgerId, string operationId, NewPlatformQueryDto input, CancellationToken ct);
    Task CreateBillAsync(string ledgerId, string operationId, NewBillQueryDto input, CancellationToken ct);
    Task CreateBillsAsync(string ledgerId, string operationId, NewBillQueryDto?[] inputs, CancellationToken ct);
    Task ConfirmAsync(string ledgerId, string operationId, string id, ConfirmationQueryDto input, CancellationToken ct);
    Task<ChangedIdsQueryResultDto> VoidBillsAsync(string ledgerId, string operationId, VoidBillsQueryDto input, CancellationToken ct);
    Task SetVoidedAsync(string ledgerId, string operationId, string id, BillValidityQueryDto input, CancellationToken ct);
    Task<ChangedIdsQueryResultDto> SetInstallmentVoidedAsync(string ledgerId, string operationId, string id, BillValidityQueryDto input, CancellationToken ct);
    Task<ChangedIdsQueryResultDto> PayAsync(string ledgerId, string operationId, PaymentQueryDto input, CancellationToken ct);
    Task SaveBudgetAsync(string ledgerId, string operationId, BudgetQueryDto input, CancellationToken ct);
}

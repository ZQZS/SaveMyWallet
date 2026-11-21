using SaveMyWallet.Core;
using SaveMyWallet.Dto.QueryDto;
using SaveMyWallet.Dto.QueryResultDto;
using SaveMyWallet.Interfaces;

namespace SaveMyWallet.Services;

public sealed class SyncService(ISyncStore store) : ISyncService
{
    public Task<BootstrapQueryResultDto> BootstrapAsync(string ledgerId, CancellationToken ct) =>
        store.BootstrapAsync(ledgerId, ct);

    public Task<PullQueryResultDto> PullAsync(string ledgerId, long cursor, CancellationToken ct)
    {
        if (cursor < 0) throw new LedgerException(400, "invalid_cursor", "Cursor must be nonnegative.");
        return store.PullAsync(ledgerId, cursor, ct);
    }

    public Task<PushQueryResultDto> PushAsync(string ledgerId, SyncOperationQueryDto operation, CancellationToken ct)
    {
        SyncRules.ValidateOperation(operation);
        return store.PushAsync(ledgerId, operation, ct);
    }

    public Task<PushQueryResultDto> RevertAsync(string ledgerId, RevertOperationQueryDto operation, CancellationToken ct)
    {
        SyncRules.ValidateOperation(new SyncOperationQueryDto(operation.OperationId, operation.Changes));
        if (operation.Seed || operation.RevertOperationIds is not { Count: > 0 } ids || ids.Count > operation.Changes.Count ||
            ids.Distinct().Count() != ids.Count || ids.Contains(operation.OperationId))
            throw new LedgerException(400, "invalid_revert", "Expected the original operations for one AI action.");
        foreach (var id in ids) SyncRules.CheckOperationId(id);
        return store.RevertAsync(ledgerId, operation, ct);
    }
}

using System.Text.Json.Nodes;
using SaveMyWallet.Core;
using SaveMyWallet.Dto;
using SaveMyWallet.Interfaces;

namespace SaveMyWallet.Services;

public sealed class SyncService(ISyncStore store) : ISyncService
{
    public Task<BootstrapResult> BootstrapAsync(string ledgerId, CancellationToken ct) =>
        store.BootstrapAsync(ledgerId, ct);

    public Task<PullResult> PullAsync(string ledgerId, long cursor, CancellationToken ct)
    {
        if (cursor < 0) throw new LedgerException(400, "invalid_cursor", "Cursor must be nonnegative.");
        return store.PullAsync(ledgerId, cursor, ct);
    }

    public Task<JsonNode?> PushAsync(string ledgerId, SyncOperation operation, CancellationToken ct)
    {
        SyncRules.ValidateOperation(operation);
        return store.PushAsync(ledgerId, operation, ct);
    }
}

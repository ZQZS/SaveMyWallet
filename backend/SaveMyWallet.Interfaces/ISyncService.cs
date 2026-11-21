using System.Text.Json.Nodes;
using SaveMyWallet.Dto;

namespace SaveMyWallet.Interfaces;

public interface ISyncService
{
    Task<BootstrapResult> BootstrapAsync(string ledgerId, CancellationToken ct);
    Task<PullResult> PullAsync(string ledgerId, long cursor, CancellationToken ct);
    Task<JsonNode?> PushAsync(string ledgerId, SyncOperation operation, CancellationToken ct);
}

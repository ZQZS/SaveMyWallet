using SaveMyWallet.Dto.QueryDto;
using SaveMyWallet.Dto.QueryResultDto;

namespace SaveMyWallet.Interfaces;

public interface ISyncService
{
    Task<BootstrapQueryResultDto> BootstrapAsync(string ledgerId, CancellationToken ct);
    Task<PullQueryResultDto> PullAsync(string ledgerId, long cursor, CancellationToken ct);
    Task<PushQueryResultDto> PushAsync(string ledgerId, SyncOperationQueryDto operation, CancellationToken ct);
    Task<PushQueryResultDto> RevertAsync(string ledgerId, RevertOperationQueryDto operation, CancellationToken ct);
}

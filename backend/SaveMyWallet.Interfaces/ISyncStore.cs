using SaveMyWallet.Dto.EntityDto;
using SaveMyWallet.Dto.QueryDto;
using SaveMyWallet.Dto.QueryResultDto;

namespace SaveMyWallet.Interfaces;

public interface ISyncStore
{
    Task<BootstrapQueryResultDto> BootstrapAsync(string ledgerId, CancellationToken ct);
    Task<PullQueryResultDto> PullAsync(string ledgerId, long cursor, CancellationToken ct);
    Task<PushQueryResultDto> PushAsync(string ledgerId, SyncOperationQueryDto operation, CancellationToken ct);
    Task ExecuteRestAsync(string ledgerId, string operationId, string fingerprint,
        Func<IReadOnlyList<SyncRecordEntityDto>, RestMutationEntityDto> build, CancellationToken ct);
    Task<TResult> ExecuteRestAsync<TResult>(string ledgerId, string operationId, string fingerprint,
        Func<IReadOnlyList<SyncRecordEntityDto>, RestMutationEntityDto<TResult>> build, CancellationToken ct)
        where TResult : QueryResultBase;
}

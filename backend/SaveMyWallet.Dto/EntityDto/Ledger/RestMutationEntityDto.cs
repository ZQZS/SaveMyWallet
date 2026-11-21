using SaveMyWallet.Dto.QueryDto;
using SaveMyWallet.Dto.QueryResultDto;

namespace SaveMyWallet.Dto.EntityDto;

public class RestMutationEntityDto(IReadOnlyList<SyncChangeQueryDto> changes) : EntityBase
{
    public IReadOnlyList<SyncChangeQueryDto> Changes { get; } = changes;
}

public sealed class RestMutationEntityDto<TResult>(IReadOnlyList<SyncChangeQueryDto> changes, TResult response)
    : RestMutationEntityDto(changes) where TResult : QueryResultBase
{
    public TResult Response { get; } = response;
}

namespace SaveMyWallet.Dto.QueryResultDto;

public sealed class ChangedIdsQueryResultDto(IReadOnlyList<string> changedIds) : QueryResultBase
{
    public IReadOnlyList<string> ChangedIds { get; init; } = changedIds;
}

namespace SaveMyWallet.Dto.QueryResultDto;

public sealed class PlatformCreatedQueryResultDto(string id) : QueryResultBase
{
    public string Id { get; init; } = id;
}

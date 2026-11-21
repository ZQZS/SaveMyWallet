namespace SaveMyWallet.Dto.QueryResultDto;

public sealed class PlatformQueryResultDto(string id, string name) : QueryResultBase
{
    public string Id { get; init; } = id;
    public string Name { get; init; } = name;
}

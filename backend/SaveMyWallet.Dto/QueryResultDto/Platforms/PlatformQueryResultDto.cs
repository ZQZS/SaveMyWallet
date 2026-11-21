namespace SaveMyWallet.Dto.QueryResultDto;

public sealed class PlatformQueryResultDto(string id, string name) : LedgerValueQueryResultDto
{
    public string Id { get; init; } = id;
    public string Name { get; init; } = name;

    private protected override bool HasSameValue(LedgerValueQueryResultDto other) =>
        other is PlatformQueryResultDto platform && platform.Id == Id && platform.Name == Name;
}

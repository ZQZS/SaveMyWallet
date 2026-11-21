using System.Text.Json.Serialization;

namespace SaveMyWallet.Dto.QueryResultDto;

public sealed class LedgerErrorQueryResultDto(string code, string? message = null) : QueryResultBase
{
    public string Code { get; } = code;

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Message { get; } = message;
}

using System.Text.Json.Serialization;

namespace SaveMyWallet.Dto.QueryDto;

public sealed class VoidBillsQueryDto(string[] Ids) : QueryBase
{
    [JsonRequired]
    public string[] Ids { get; init; } = Ids;
}

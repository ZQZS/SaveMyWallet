using System.Text.Json.Serialization;

namespace SaveMyWallet.Dto.QueryDto;

public sealed class NewPlatformQueryDto(string Name) : QueryBase
{
    [JsonRequired]
    public string Name { get; init; } = Name;
}

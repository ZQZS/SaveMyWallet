using System.Text.Json;
using System.Text.Json.Serialization;

namespace SaveMyWallet.Dto.QueryDto;

public class SyncChangeQueryDto(string Kind, string Id, string? BaseVersion, JsonElement? Before, JsonElement? After) : QueryBase
{
    public string Kind { get; init; } = Kind;

    public string Id { get; init; } = Id;

    [JsonRequired]
    public string? BaseVersion { get; init; } = BaseVersion;

    [JsonRequired]
    public JsonElement? Before { get; init; } = Before;

    [JsonRequired]
    public JsonElement? After { get; init; } = After;
}

using System.Text.Json;

namespace SaveMyWallet.Dto.EntityDto;

public class SyncRecordEntityDto(string Kind, string Id, JsonElement? Value, string? Version) : EntityBase
{
    public string Kind { get; init; } = Kind;
    public string Id { get; init; } = Id;
    public JsonElement? Value { get; init; } = Value;
    public string? Version { get; init; } = Version;
}

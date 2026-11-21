using System.Text.Json.Serialization;

namespace SaveMyWallet.Dto.QueryResultDto;

[JsonConverter(typeof(SyncRecordQueryResultDtoConverter))]
public abstract class SyncRecordQueryResultDto(SyncRecordKind kind, string id, string? version) : QueryResultBase
{
    public SyncRecordKind Kind { get; } = kind;
    public string Id { get; } = id;
    [JsonPropertyOrder(2)]
    public string? Version { get; } = version;
}

public sealed class SyncRecordQueryResultDto<T>(SyncRecordKind kind, string id, T value, string? version)
    : SyncRecordQueryResultDto(kind, id, version)
{
    [JsonPropertyOrder(1)]
    public T Value { get; } = value;
}

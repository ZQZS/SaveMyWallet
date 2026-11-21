using System.Text.Json;
using System.Text.Json.Serialization;
using SaveMyWallet.Dto.QueryResultDto;
using SaveMyWallet.Dto.Serialization;

namespace SaveMyWallet.Dto.QueryDto;

internal sealed class SyncChangeQueryDtoConverter : JsonConverter<SyncChangeQueryDto>
{
    // The discriminator selects the type of both snapshots, irrespective of JSON property order.
    private sealed class WireChange<T>(SyncRecordKind kind, string id, string? baseVersion, T? before, T? after)
        where T : LedgerValueQueryResultDto
    {
        public SyncRecordKind Kind { get; } = kind;
        public string Id { get; } = id;
        public string? BaseVersion { get; } = baseVersion;
        public T? Before { get; } = before;
        public T? After { get; } = after;
    }

    public override SyncChangeQueryDto Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        using var document = JsonDocument.ParseValue(ref reader);
        var change = document.RootElement;
        return LedgerJson.ReadKind(change) switch
        {
            SyncRecordKind.Entry => Read<BillEntryQueryResultDto>(change),
            SyncRecordKind.Platform => Read<PlatformQueryResultDto>(change),
            SyncRecordKind.Setting or SyncRecordKind.Override => Read<AmountQueryResultDto>(change),
            _ => throw new JsonException("Unknown sync record kind.")
        };
    }

    private static SyncChangeQueryDto Read<T>(JsonElement change) where T : LedgerValueQueryResultDto
    {
        var wire = change.Deserialize<WireChange<T>>(LedgerJson.Options)!;
        return new(wire.Kind, wire.Id, wire.BaseVersion, wire.Before, wire.After);
    }

    public override void Write(Utf8JsonWriter writer, SyncChangeQueryDto value, JsonSerializerOptions options)
    {
        switch (value.Kind)
        {
            case SyncRecordKind.Entry: Write<BillEntryQueryResultDto>(writer, value); break;
            case SyncRecordKind.Platform: Write<PlatformQueryResultDto>(writer, value); break;
            case SyncRecordKind.Setting:
            case SyncRecordKind.Override: Write<AmountQueryResultDto>(writer, value); break;
            default: throw new JsonException("Unknown sync record kind.");
        }
    }

    private static void Write<T>(Utf8JsonWriter writer, SyncChangeQueryDto change) where T : LedgerValueQueryResultDto =>
        JsonSerializer.Serialize(writer,
            new WireChange<T>(change.Kind, change.Id, change.BaseVersion, (T?)change.Before, (T?)change.After), LedgerJson.Options);
}

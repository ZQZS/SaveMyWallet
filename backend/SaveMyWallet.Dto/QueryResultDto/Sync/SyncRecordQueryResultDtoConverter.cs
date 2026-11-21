using System.Text.Json;
using System.Text.Json.Serialization;
using SaveMyWallet.Dto.Serialization;

namespace SaveMyWallet.Dto.QueryResultDto;

// Stored push receipts use the protocol's kind field to identify the value type.
internal sealed class SyncRecordQueryResultDtoConverter : JsonConverter<SyncRecordQueryResultDto>
{
    public override SyncRecordQueryResultDto Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        using var document = JsonDocument.ParseValue(ref reader);
        var record = document.RootElement;
        return LedgerJson.ReadKind(record) switch
        {
            SyncRecordKind.Platform => record.Deserialize<SyncRecordQueryResultDto<PlatformQueryResultDto?>>(LedgerJson.Options)!,
            SyncRecordKind.Entry => record.Deserialize<SyncRecordQueryResultDto<BillEntryQueryResultDto?>>(LedgerJson.Options)!,
            SyncRecordKind.Setting or SyncRecordKind.Override => record.Deserialize<SyncRecordQueryResultDto<long?>>(LedgerJson.Options)!,
            _ => throw new JsonException("Unknown sync record kind.")
        };
    }

    public override void Write(Utf8JsonWriter writer, SyncRecordQueryResultDto value, JsonSerializerOptions options) =>
        JsonSerializer.Serialize(writer, value, value.GetType(), LedgerJson.Options);
}

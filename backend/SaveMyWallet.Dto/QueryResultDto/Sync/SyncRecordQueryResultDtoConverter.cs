using System.Text.Json;
using System.Text.Json.Serialization;

namespace SaveMyWallet.Dto.QueryResultDto;

// Stored push receipts use the protocol's kind field to identify the value type.
internal sealed class SyncRecordQueryResultDtoConverter : JsonConverter<SyncRecordQueryResultDto>
{
    public override SyncRecordQueryResultDto Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        using var document = JsonDocument.ParseValue(ref reader);
        var record = document.RootElement;
        var kindProperty = options.PropertyNamingPolicy?.ConvertName(nameof(SyncRecordQueryResultDto.Kind))
            ?? nameof(SyncRecordQueryResultDto.Kind);
        if (record.ValueKind != JsonValueKind.Object || !record.TryGetProperty(kindProperty, out var kind)
            || kind.ValueKind != JsonValueKind.String)
            throw new JsonException("A sync record must specify its kind.");

        return kind.GetString() switch
        {
            "platform" => record.Deserialize<SyncRecordQueryResultDto<PlatformQueryResultDto?>>(options)!,
            "entry" => record.Deserialize<SyncRecordQueryResultDto<BillEntryQueryResultDto?>>(options)!,
            "setting" or "override" => record.Deserialize<SyncRecordQueryResultDto<long?>>(options)!,
            _ => throw new JsonException("Unknown sync record kind.")
        };
    }

    public override void Write(Utf8JsonWriter writer, SyncRecordQueryResultDto value, JsonSerializerOptions options) =>
        JsonSerializer.Serialize(writer, value, value.GetType(), options);
}

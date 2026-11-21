using System.Text.Json;
using System.Text.Json.Serialization;

namespace SaveMyWallet.Dto.QueryResultDto;

[JsonConverter(typeof(AmountQueryResultDtoConverter))]
public sealed class AmountQueryResultDto(long cents) : LedgerValueQueryResultDto
{
    public long Cents { get; } = cents;

    private protected override bool HasSameValue(LedgerValueQueryResultDto other) =>
        other is AmountQueryResultDto amount && amount.Cents == Cents;
}

internal sealed class AmountQueryResultDtoConverter : JsonConverter<AmountQueryResultDto>
{
    public override AmountQueryResultDto Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        reader.TokenType == JsonTokenType.Number && reader.TryGetInt64(out var cents)
            ? new(cents) : throw new JsonException("A budget amount must be an integer in cents.");

    public override void Write(Utf8JsonWriter writer, AmountQueryResultDto value, JsonSerializerOptions options) =>
        writer.WriteNumberValue(value.Cents);
}

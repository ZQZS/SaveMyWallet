using System.Text.Json;
using System.Text.Json.Serialization;

namespace SaveMyWallet.Dto.Serialization;

internal sealed class LedgerEnumJsonConverter<TEnum> : JsonConverter<TEnum> where TEnum : struct, Enum
{
    private static readonly Dictionary<TEnum, string> Names = Enum.GetValues<TEnum>()
        .ToDictionary(value => value, value => JsonNamingPolicy.CamelCase.ConvertName(value.ToString()));
    private static readonly Dictionary<string, TEnum> Values = Names
        .ToDictionary(pair => pair.Value, pair => pair.Key, StringComparer.Ordinal);

    public override TEnum Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.String && Values.TryGetValue(reader.GetString()!, out var value))
            return value;
        throw new JsonException($"Expected a valid {typeof(TEnum).Name} string.");
    }

    public override void Write(Utf8JsonWriter writer, TEnum value, JsonSerializerOptions options)
    {
        if (!Names.TryGetValue(value, out var name))
            throw new JsonException($"Unknown {typeof(TEnum).Name} value.");
        writer.WriteStringValue(name);
    }
}

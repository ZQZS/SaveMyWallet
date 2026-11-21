using System.Text.Json;
using System.Text.Json.Serialization;

namespace SaveMyWallet.Dto.Serialization;

// Optional bill fields are absent until set. An explicit JSON null is a different wire shape.
internal sealed class PresentValueConverter<T> : JsonConverter<T>
{
    public override bool HandleNull => true;

    public override T Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        reader.TokenType == JsonTokenType.Null
            ? throw new JsonException("Omit the optional field when it has no value.")
            : JsonSerializer.Deserialize<T>(ref reader, options)!;

    public override void Write(Utf8JsonWriter writer, T value, JsonSerializerOptions options) =>
        JsonSerializer.Serialize(writer, value, options);
}

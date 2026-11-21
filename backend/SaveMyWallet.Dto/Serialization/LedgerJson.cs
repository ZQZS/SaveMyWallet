using System.Text.Json;
using System.Text.Json.Serialization;

namespace SaveMyWallet.Dto.Serialization;

public static class LedgerJson
{
    public static JsonSerializerOptions Options { get; } = CreateOptions();

    public static void Configure(JsonSerializerOptions options)
    {
        options.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
        options.PropertyNameCaseInsensitive = false;
        options.NumberHandling = JsonNumberHandling.Strict;
        options.UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow;
        options.RespectRequiredConstructorParameters = true;
        options.RespectNullableAnnotations = true;
        options.AllowDuplicateProperties = false;
    }

    internal static SyncRecordKind ReadKind(JsonElement record)
    {
        if (record.ValueKind != JsonValueKind.Object || !record.TryGetProperty("kind", out var kind))
            throw new JsonException("A sync record must specify its kind.");
        return kind.Deserialize<SyncRecordKind>(Options);
    }

    private static JsonSerializerOptions CreateOptions()
    {
        var options = new JsonSerializerOptions();
        Configure(options);
        options.MakeReadOnly(populateMissingResolver: true);
        return options;
    }
}

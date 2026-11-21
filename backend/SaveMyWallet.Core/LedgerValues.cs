using System.Text.Json;
using System.Text.Json.Serialization;
using SaveMyWallet.Dto.QueryResultDto;

namespace SaveMyWallet.Core;

public static class LedgerValues
{
    // Existing clients may vary property casing. Sync amounts must still be JSON numbers.
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        RespectRequiredConstructorParameters = true,
        RespectNullableAnnotations = true,
        AllowDuplicateProperties = false
    };

    internal static JsonElement Encode<T>(T value) => JsonSerializer.SerializeToElement(value, Json);

    internal static PlatformQueryResultDto ReadPlatform(JsonElement? value) =>
        ReadObject<PlatformQueryResultDto>(value);

    internal static BillEntryQueryResultDto ReadEntry(JsonElement? value)
    {
        var entry = ReadObject<BillEntryQueryResultDto>(value);
        // Nullable properties in the class represent absence. The wire format permits only an omitted field.
        if (entry.Voided is false) throw InvalidVoided();
        foreach (var property in value!.Value.EnumerateObject())
        {
            if (property.Value.ValueKind != JsonValueKind.Null) continue;
            if (property.Name.Equals(nameof(entry.Voided), StringComparison.OrdinalIgnoreCase)) throw InvalidVoided();
            if (property.Name.Equals(nameof(entry.InstallmentId), StringComparison.OrdinalIgnoreCase)) throw InvalidText("installmentId");
            if (property.Name.Equals(nameof(entry.DepositCents), StringComparison.OrdinalIgnoreCase)) throw InvalidNumber();
        }
        return entry;
    }

    internal static long ReadAmount(JsonElement? value) =>
        value is { ValueKind: JsonValueKind.Number } number && number.TryGetInt64(out var amount)
            ? amount : throw InvalidNumber();

    // The store preloads siblings before checking versions. Defer validation until after conflict detection.
    public static string? GetInstallmentIdHint(JsonElement? value) =>
        value is { ValueKind: JsonValueKind.Object } obj && TryGetProperty(obj, "installmentId", out var id)
            && id.ValueKind == JsonValueKind.String ? id.GetString() : null;

    private static bool TryGetProperty(JsonElement obj, string name, out JsonElement value)
    {
        if (obj.TryGetProperty(name, out value)) return true;
        foreach (var property in obj.EnumerateObject())
        {
            if (!name.Equals(property.Name, StringComparison.OrdinalIgnoreCase)) continue;
            value = property.Value;
            return true;
        }
        return false;
    }

    private static T ReadObject<T>(JsonElement? value) where T : class
    {
        if (value is not { ValueKind: JsonValueKind.Object } obj) throw InvalidRecord();
        try
        {
            return obj.Deserialize<T>(Json)!;
        }
        catch (JsonException error)
        {
            throw FormatError<T>(obj, error.Path);
        }
    }

    private static LedgerException FormatError<T>(JsonElement obj, string? path)
    {
        // Preserve the sync protocol's error codes. Use the DTO contract as the source of field names.
        var fields = Json.GetTypeInfo(typeof(T)).Properties;
        var field = fields.FirstOrDefault(p => string.Equals(path, "$." + p.Name, StringComparison.OrdinalIgnoreCase));
        if (field is null) return InvalidRecord();
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var property in obj.EnumerateObject())
            if (!names.Add(property.Name)) return InvalidRecord();
        if (fields.Count(p => names.Contains(p.Name)) != names.Count ||
            fields.Any(p => (p.IsRequired || p.AssociatedParameter is { HasDefaultValue: false }) && !names.Contains(p.Name)))
            return InvalidRecord();

        if (field.PropertyType == typeof(string)) return InvalidText(field.Name);
        if (field.PropertyType == typeof(bool?)) return InvalidVoided();
        if (field.PropertyType == typeof(int?))
        {
            TryGetProperty(obj, "kind", out var kind);
            if (kind.ValueKind != JsonValueKind.String) return InvalidText("kind");
            if (kind.ValueEquals("installment"))
            {
                TryGetProperty(obj, field.Name, out var period);
                if (period.ValueKind != JsonValueKind.Number || !period.TryGetInt64(out _)) return InvalidNumber();
                return new LedgerException(400, "invalid_installment", "Installments must have a valid index and 1 to 120 periods.");
            }
            return new LedgerException(400, "invalid_installment", "Only installment bills have period numbers.");
        }
        return InvalidNumber();
    }

    private static LedgerException InvalidRecord() =>
        new(400, "invalid_record", "A complete platform or bill record is required.");

    private static LedgerException InvalidText(string field) =>
        new(400, "invalid_field", $"Expected a string in {field}.");

    private static LedgerException InvalidNumber() => new(400, "invalid_number", "An integer is required.");

    private static LedgerException InvalidVoided() =>
        new(400, "invalid_voided", "Set voided to true for a voided bill. Omit it for an active bill.");
}

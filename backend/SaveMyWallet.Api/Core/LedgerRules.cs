using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using SaveMyWallet.Api.Dto;

namespace SaveMyWallet.Api.Core;

/// <summary>Rules shared by the HTTP ledger commands and the offline synchronization path.</summary>
public static class LedgerRules
{
    internal const long MaxCents = 99_999_999_900;
    internal const string DefaultSalary = "defaultSalaryCents";
    internal const string WarningFloor = "warningFloorCents";
    private static readonly string[] EntryFields =
        ["id", "platformId", "title", "month", "amountCents", "status", "kind", "installmentIndex", "installmentCount"];

    internal static bool IsSafeKey(string? text, int max) =>
        text is { Length: > 0 } && text.Length <= max &&
        text.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.');

    public static void Validate(IReadOnlyList<SyncRecord> current, IReadOnlyList<SyncChange> changes)
    {
        // Platform IDs and names must be checked against the state at the end of the
        // operation: a first-device upload may contain both platforms and their bills.
        var platforms = current.Where(r => r.Kind == "platform" && r.Value is not null)
            .ToDictionary(r => r.Id, r => Text(r.Value!["name"], "name"), StringComparer.Ordinal);
        var previous = current.ToDictionary(r => (r.Kind, r.Id));
        foreach (var change in changes)
        {
            ValidateId(change.Id);
            if (change.Kind != "platform") continue;
            var platform = ObjectWithFields(change.After, ["id", "name"]);
            Require(Text(platform["id"], "id") == change.Id, "invalid_id", "Platform IDs must match.");
            var name = Text(platform["name"], "name");
            Require(name == CleanText(name, 40), "invalid_name", "Platform names must be trimmed.");
            platforms[change.Id] = name;
        }

        // SQLite NOCASE and the v1 backup reader case-fold only ASCII letters.
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var name in platforms.Values)
        {
            var folded = FoldPlatformName(name);
            if (!names.Add(folded)) throw new LedgerException(409, "duplicate_platform", "A platform with this name already exists.");
        }

        var newInstallments = new List<JsonObject>();
        foreach (var change in changes)
        {
            switch (change.Kind)
            {
                case "platform":
                    break;
                case "entry":
                    previous.TryGetValue((change.Kind, change.Id), out var old);
                    ValidateEntry(change, old?.Value, platforms);
                    if (old?.Value is null && change.After is JsonObject entry && entry.ContainsKey("installmentId"))
                        newInstallments.Add(entry);
                    break;
                case "setting":
                    Require(change.Id is DefaultSalary or WarningFloor, "invalid_setting", "Unknown budget setting.");
                    Amount(change.After, 0);
                    break;
                case "override":
                    Month(change.Id);
                    if (change.After is not null) Amount(change.After, 0);
                    break;
                default:
                    throw new LedgerException(400, "invalid_kind", "Unknown record kind.");
            }
        }
        if (newInstallments.Count > 0) InstallmentSeries.ValidateNewMembers(current, newInstallments);
    }

    internal static string FoldPlatformName(string name) =>
        string.Concat(name.Select(c => c is >= 'A' and <= 'Z' ? (char)(c + 32) : c));

    internal static string PlatformId(string name) =>
        "p." + Convert.ToHexStringLower(Encoding.UTF8.GetBytes(FoldPlatformName(name)));

    private static void ValidateEntry(SyncChange change, JsonNode? previous, Dictionary<string, string> platforms)
    {
        var row = ObjectWithFields(change.After, EntryFields, "voided", "installmentId", "depositCents");
        if (row.ContainsKey("voided"))
            Require(row["voided"] is JsonValue flag && flag.TryGetValue<bool>(out var voided) && voided,
                    "invalid_voided", "Set voided to true for a voided bill. Omit it for an active bill.");
        Require(Text(row["id"], "id") == change.Id, "invalid_id", "Entry IDs must match.");
        Require(platforms.ContainsKey(Text(row["platformId"], "platformId")), "unknown_platform", "Choose an existing platform.");
        var title = Text(row["title"], "title");
        Require(title == CleanText(title, 120), "invalid_title", "Bill titles must be trimmed.");
        var month = Month(Text(row["month"], "month"));
        var kind = Text(row["kind"], "kind");
        if (row.ContainsKey("installmentId"))
        {
            var installmentId = Text(row["installmentId"], "installmentId");
            Require(kind == "installment" && installmentId.Length == 32 &&
                    installmentId.All(c => char.IsAsciiDigit(c) || c is >= 'a' and <= 'f'),
                    "invalid_installment", "An installment ID must be 32 lowercase hexadecimal characters.");
        }
        var status = Text(row["status"], "status");
        Require(kind is "single" or "installment" or "estimate", "invalid_kind", "Unknown bill kind.");
        Require((status is "due" or "paid") || (status == "estimated" && kind == "estimate"),
                "invalid_status", "Invalid status for this bill kind.");
        var deposit = row.ContainsKey("depositCents") ? Integer(row["depositCents"]) : 0;
        Require(!row.ContainsKey("depositCents") || (kind == "estimate" && deposit > 0),
                "invalid_deposit", "Only estimates may include a positive deposit. Omit a zero deposit.");
        if (kind == "estimate")
        {
            var balance = Integer(row["amountCents"]);
            ValidateEstimateAmounts(balance, deposit);
            Require(balance != 0 || status != "due", "invalid_status", "A confirmed fully prepaid estimate must be paid.");
        }
        else Amount(row["amountCents"], 1);
        if (kind == "installment")
        {
            var count = Integer(row["installmentCount"]);
            var index = Integer(row["installmentIndex"]);
            Require(count is >= 1 and <= 120 && index >= 1 && index <= count,
                    "invalid_installment", "Installments must have a valid index and 1 to 120 periods.");
            var firstMonth = month.Year * 12 + month.Month - index;
            Require(firstMonth >= 1900 * 12 && firstMonth + count - 1 <= 2099 * 12 + 11,
                    "invalid_month", "Installments exceed the ledger month range.");
        }
        else
        {
            Require(row["installmentIndex"] is null && row["installmentCount"] is null,
                    "invalid_installment", "Only installment bills have period numbers.");
        }
        if (previous is null) return;
        if (row.ContainsKey("voided") || previous["voided"] is not null)
            Require(EntryFields.All(key => JsonNode.DeepEquals(row[key], previous[key]))
                    && JsonNode.DeepEquals(row["depositCents"], previous["depositCents"]),
                    "invalid_transition", "Voiding or restoring a bill must preserve its details and payment status.");

        foreach (var key in new[] { "platformId", "kind", "installmentIndex", "installmentCount", "installmentId" })
            Require(JsonNode.DeepEquals(row[key], previous[key]), "immutable_entry", "The bill identity and installment schedule are fixed.");
        if (kind != "estimate")
        {
            foreach (var key in new[] { "title", "month", "amountCents" })
                Require(JsonNode.DeepEquals(row[key], previous[key]), "immutable_entry", "Only payment status can change on this bill.");
        }
        Require(status != "estimated" || Text(previous["status"], "status") == "estimated",
                "invalid_transition", "A confirmed bill cannot become an estimate again.");
    }

    internal static void ValidateId(string? id) =>
        Require(!string.IsNullOrWhiteSpace(id) && id == id.Trim() && !id.Contains('\0'),
                "invalid_id", "A nonempty, trimmed record ID is required.");

    internal static string CleanText(string? value, int limit)
    {
        var text = value?.Trim();
        Require(!string.IsNullOrEmpty(text) && !text.Contains('\0') && text.EnumerateRunes().Count() <= limit,
                "invalid_text", $"Text must contain between 1 and {limit} characters.");
        return text!;
    }

    internal static DateOnly Month(string? value)
    {
        if (value?.Length != 7 || !DateOnly.TryParseExact(value + "-01", "yyyy-MM-dd",
                CultureInfo.InvariantCulture, DateTimeStyles.None, out var month) || month.Year is < 1900 or > 2099)
            throw new LedgerException(400, "invalid_month", "Use a month between 1900-01 and 2099-12.");
        return month;
    }

    private static void Amount(JsonNode? value, long minimum)
    {
        var cents = Integer(value);
        Require(cents >= minimum && cents <= MaxCents, "invalid_amount", "Amount is outside the supported range in cents.");
    }

    internal static void ValidateEstimateAmounts(long balance, long deposit, long? total = null)
    {
        // Bound both operands before adding, including for inputs near Int64.MaxValue.
        Require(deposit is >= 0 and <= MaxCents && balance >= 0 && balance <= MaxCents - deposit
                && balance + deposit > 0, "invalid_amount", "The purchase total must be positive and cover the deposit.");
        Require(total is null || total == balance + deposit, "invalid_amount", "The balance must equal the total less the deposit.");
    }

    private static long Integer(JsonNode? node)
    {
        if (node is JsonValue value)
        {
            if (value.TryGetValue<long>(out var number)) return number;
            if (value.TryGetValue<int>(out var small)) return small;
        }
        throw new LedgerException(400, "invalid_number", "An integer is required.");
    }

    internal static string Text(JsonNode? node, string field)
    {
        if (node is JsonValue value && value.TryGetValue<string>(out var text)) return text;
        throw new LedgerException(400, "invalid_field", $"Expected a string in {field}.");
    }

    private static JsonObject ObjectWithFields(JsonNode? node, string[] fields, params string[] optional)
    {
        if (node is JsonObject obj && fields.All(obj.ContainsKey)
            && obj.Count == fields.Length + optional.Count(obj.ContainsKey)) return obj;
        throw new LedgerException(400, "invalid_record", "A complete platform or bill record is required.");
    }

    internal static void Require(bool condition, string code, string message)
    {
        if (!condition) throw new LedgerException(400, code, message);
    }
}

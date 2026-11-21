using System.Globalization;
using System.Text;
using SaveMyWallet.Constant;
using SaveMyWallet.Dto.EntityDto;
using SaveMyWallet.Dto.QueryDto;
using SaveMyWallet.Dto.QueryResultDto;

namespace SaveMyWallet.Core;

/// <summary>Rules shared by the HTTP ledger commands and the offline synchronization path.</summary>
public static class LedgerRules
{
    public const string DefaultSalary = LedgerConstants.DefaultSalary;
    public const string WarningFloor = LedgerConstants.WarningFloor;

    public static bool IsSafeKey(string? text, int max) =>
        text is { Length: > 0 } && text.Length <= max &&
        text.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.');

    public static void Validate(IReadOnlyList<SyncRecordEntityDto> current, IReadOnlyList<SyncChangeQueryDto> changes)
    {
        // Platform IDs and names must be checked against the state at the end of the
        // operation: a first-device upload may contain both platforms and their bills.
        var platforms = current.Where(r => r.Kind == "platform" && r.Value is not null)
            .ToDictionary(r => r.Id, r => LedgerValues.ReadPlatform(r.Value).Name, StringComparer.Ordinal);
        var previous = current.ToDictionary(r => (r.Kind, r.Id));
        foreach (var change in changes)
        {
            ValidateId(change.Id);
            if (change.Kind != "platform") continue;
            var platform = LedgerValues.ReadPlatform(change.After);
            Require(platform.Id == change.Id, "invalid_id", "Platform IDs must match.");
            Require(platform.Name == CleanText(platform.Name, 40), "invalid_name", "Platform names must be trimmed.");
            platforms[change.Id] = platform.Name;
        }

        // SQLite NOCASE and the v1 backup reader case-fold only ASCII letters.
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var name in platforms.Values)
        {
            var folded = FoldPlatformName(name);
            if (!names.Add(folded)) throw new LedgerException(409, "duplicate_platform", "A platform with this name already exists.");
        }

        var newInstallments = new List<BillEntryQueryResultDto>();
        foreach (var change in changes)
        {
            switch (change.Kind)
            {
                case "platform":
                    break;
                case "entry":
                    previous.TryGetValue((change.Kind, change.Id), out var old);
                    var entry = LedgerValues.ReadEntry(change.After);
                    ValidateEntry(change.Id, entry, platforms);
                    if (old?.Value is { } previousValue)
                        ValidateTransition(LedgerValues.ReadEntry(previousValue), entry);
                    else if (entry.InstallmentId is not null)
                        newInstallments.Add(entry);
                    break;
                case "setting":
                    Require(change.Id is LedgerConstants.DefaultSalary or LedgerConstants.WarningFloor,
                        "invalid_setting", "Unknown budget setting.");
                    ValidateAmount(LedgerValues.ReadAmount(change.After), 0);
                    break;
                case "override":
                    Month(change.Id);
                    if (change.After is not null) ValidateAmount(LedgerValues.ReadAmount(change.After), 0);
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

    private static void ValidateEntry(string id, BillEntryQueryResultDto entry, Dictionary<string, string> platforms)
    {
        Require(entry.Id == id, "invalid_id", "Entry IDs must match.");
        Require(platforms.ContainsKey(entry.PlatformId), "unknown_platform", "Choose an existing platform.");
        Require(entry.Title == CleanText(entry.Title, 120), "invalid_title", "Bill titles must be trimmed.");
        var month = Month(entry.Month);
        if (entry.InstallmentId is { } installmentId)
        {
            Require(entry.Kind == "installment" && installmentId.Length == 32 &&
                    installmentId.All(c => char.IsAsciiDigit(c) || c is >= 'a' and <= 'f'),
                    "invalid_installment", "An installment ID must be 32 lowercase hexadecimal characters.");
        }
        Require(entry.Kind is "single" or "installment" or "estimate", "invalid_kind", "Unknown bill kind.");
        Require((entry.Status is "due" or "paid") || (entry.Status == "estimated" && entry.Kind == "estimate"),
                "invalid_status", "Invalid status for this bill kind.");
        Require(entry.DepositCents is null || (entry.Kind == "estimate" && entry.DepositCents > 0),
                "invalid_deposit", "Only estimates may include a positive deposit. Omit a zero deposit.");
        if (entry.Kind == "estimate")
        {
            ValidateEstimateAmounts(entry.AmountCents, entry.DepositCents ?? 0);
            Require(entry.AmountCents != 0 || entry.Status != "due", "invalid_status", "A confirmed fully prepaid estimate must be paid.");
        }
        else ValidateAmount(entry.AmountCents, 1);
        if (entry.Kind == "installment")
        {
            if (entry.InstallmentCount is not { } count || entry.InstallmentIndex is not { } index)
                throw new LedgerException(400, "invalid_number", "An integer is required.");
            Require(count is >= 1 and <= 120 && index >= 1 && index <= count,
                    "invalid_installment", "Installments must have a valid index and 1 to 120 periods.");
            var firstMonth = month.Year * 12 + month.Month - index;
            Require(firstMonth >= 1900 * 12 && firstMonth + count - 1 <= 2099 * 12 + 11,
                    "invalid_month", "Installments exceed the ledger month range.");
        }
        else
        {
            Require(entry.InstallmentIndex is null && entry.InstallmentCount is null,
                    "invalid_installment", "Only installment bills have period numbers.");
        }
    }

    private static void ValidateTransition(BillEntryQueryResultDto previous, BillEntryQueryResultDto entry)
    {
        var sameSchedule = entry.PlatformId == previous.PlatformId && entry.Kind == previous.Kind
            && entry.InstallmentIndex == previous.InstallmentIndex && entry.InstallmentCount == previous.InstallmentCount;
        var sameDetails = entry.Title == previous.Title && entry.Month == previous.Month && entry.AmountCents == previous.AmountCents;
        if (entry.Voided is true || previous.Voided is true)
            Require(sameSchedule && sameDetails && entry.Id == previous.Id
                    && entry.Status == previous.Status && entry.DepositCents == previous.DepositCents,
                    "invalid_transition", "Voiding or restoring a bill must preserve its details and payment status.");

        Require(sameSchedule && entry.InstallmentId == previous.InstallmentId, "immutable_entry", "The bill identity and installment schedule are fixed.");
        if (entry.Kind != "estimate")
            Require(sameDetails, "immutable_entry", "Only payment status can change on this bill.");
        Require(entry.Status != "estimated" || previous.Status == "estimated",
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

    private static void ValidateAmount(long cents, long minimum) =>
        Require(cents >= minimum && cents <= LedgerConstants.MaxCents, "invalid_amount", "Amount is outside the supported range in cents.");

    internal static void ValidateEstimateAmounts(long balance, long deposit, long? total = null)
    {
        // Bound both operands before adding, including for inputs near Int64.MaxValue.
        Require(deposit is >= 0 and <= LedgerConstants.MaxCents && balance >= 0 && balance <= LedgerConstants.MaxCents - deposit
                && balance + deposit > 0, "invalid_amount", "The purchase total must be positive and cover the deposit.");
        Require(total is null || total == balance + deposit, "invalid_amount", "The balance must equal the total less the deposit.");
    }

    internal static void Require(bool condition, string code, string message)
    {
        if (!condition) throw new LedgerException(400, code, message);
    }
}

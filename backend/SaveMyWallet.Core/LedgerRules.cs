using System.Globalization;
using System.Text;
using SaveMyWallet.Constant;
using SaveMyWallet.Dto;
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

    public static void Validate(IReadOnlyList<SyncRecordEntityDto> current, IReadOnlyList<SyncChangeQueryDto> changes) =>
        ValidateValues(current, changes, false);

    public static void ValidateReceiptRevert(IReadOnlyList<SyncRecordEntityDto> current, IReadOnlyList<SyncChangeQueryDto> changes) =>
        ValidateValues(current, changes, true);

    private static void ValidateValues(IReadOnlyList<SyncRecordEntityDto> current, IReadOnlyList<SyncChangeQueryDto> changes,
        bool verifiedRevert)
    {
        // Platform IDs and names must be checked against the state at the end of the
        // operation: a first-device upload may contain both platforms and their bills.
        var platforms = current.Select(r => r.Value).OfType<PlatformQueryResultDto>()
            .ToDictionary(p => p.Id, p => p.Name, StringComparer.Ordinal);
        var previous = current.ToDictionary(r => (r.Kind, r.Id));
        foreach (var change in changes)
        {
            ValidateId(change.Id);
            if (change.Kind != SyncRecordKind.Platform) continue;
            if (verifiedRevert && change.After is null)
            {
                platforms.Remove(change.Id);
                continue;
            }
            if (change.After is not PlatformQueryResultDto platform)
                throw new LedgerException(400, "invalid_record", "A platform record is required.");
            Require(platform.Id == change.Id, "invalid_id", "Platform IDs must match.");
            Require(platform.Name == CleanText(platform.Name, 40), "invalid_name", "Platform names must be trimmed.");
            platforms[change.Id] = platform.Name;
        }

        // Match the native ledger's SQLite NOCASE collation.
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
                case SyncRecordKind.Platform:
                    break;
                case SyncRecordKind.Entry:
                    if (verifiedRevert && change.After is null) break;
                    previous.TryGetValue((change.Kind, change.Id), out var old);
                    if (change.After is not BillEntryQueryResultDto entry)
                        throw new LedgerException(400, "invalid_record", "A bill record is required.");
                    ValidateEntry(change.Id, entry, platforms);
                    if (old?.Value is BillEntryQueryResultDto previousEntry && !verifiedRevert)
                        ValidateTransition(previousEntry, entry);
                    else if (old?.Value is null && entry.Kind == BillKind.Installment)
                        newInstallments.Add(entry);
                    break;
                case SyncRecordKind.Setting:
                    Require(change.Id is LedgerConstants.DefaultSalary or LedgerConstants.WarningFloor,
                        "invalid_setting", "Unknown budget setting.");
                    ValidateBudgetAmount(change.After);
                    break;
                case SyncRecordKind.Override:
                    Month(change.Id);
                    if (change.After is not null) ValidateBudgetAmount(change.After);
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
        Require(entry.Voided is not false, "invalid_voided", "Set voided to true for a voided bill. Omit it for an active bill.");
        Require(entry.Status is BillStatus.Due or BillStatus.Paid ||
                (entry.Status == BillStatus.Estimated && entry.Kind == BillKind.Estimate),
                "invalid_status", "Invalid status for this bill kind.");
        Require(entry.DepositCents is null || (entry.Kind == BillKind.Estimate && entry.DepositCents > 0),
                "invalid_deposit", "Only estimates may include a positive deposit. Omit a zero deposit.");
        if (entry.Kind == BillKind.Estimate)
        {
            ValidateEstimateAmounts(entry.AmountCents, entry.DepositCents ?? 0);
            Require(entry.AmountCents != 0 || entry.Status != BillStatus.Due, "invalid_status", "A confirmed fully prepaid estimate must be paid.");
        }
        else ValidateAmount(entry.AmountCents, 1);
        if (entry.Kind == BillKind.Installment)
        {
            Require(entry.InstallmentId is { Length: 32 } idValue &&
                    idValue.All(c => char.IsAsciiDigit(c) || c is >= 'a' and <= 'f'),
                    "invalid_installment", "An installment ID must be 32 lowercase hexadecimal characters.");
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
            Require(entry.InstallmentIndex is null && entry.InstallmentCount is null && entry.InstallmentId is null,
                    "invalid_installment", "Only installment bills have an installment ID and period numbers.");
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
        if (entry.Kind != BillKind.Estimate)
            Require(sameDetails, "immutable_entry", "Only payment status can change on this bill.");
        Require(entry.Status != BillStatus.Estimated || previous.Status == BillStatus.Estimated,
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

    private static void ValidateBudgetAmount(LedgerValueQueryResultDto? value)
    {
        if (value is not AmountQueryResultDto amount)
            throw new LedgerException(400, "invalid_number", "An integer amount in cents is required.");
        ValidateAmount(amount.Cents, 0);
    }

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

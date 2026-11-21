using System.Text.Json.Serialization;
using SaveMyWallet.Dto.Serialization;

namespace SaveMyWallet.Dto.QueryResultDto;

public sealed class BillEntryQueryResultDto : LedgerValueQueryResultDto
{
    public required string Id { get; init; }
    public required string PlatformId { get; init; }
    public required string Title { get; set; }
    public required string Month { get; set; }
    public required long AmountCents { get; set; }
    public required BillKind Kind { get; init; }
    public required BillStatus Status { get; set; }
    public required int? InstallmentIndex { get; init; }
    public required int? InstallmentCount { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    [JsonConverter(typeof(PresentValueConverter<string>))]
    public string? InstallmentId { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    [JsonConverter(typeof(PresentValueConverter<long?>))]
    public long? DepositCents { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    [JsonConverter(typeof(PresentValueConverter<bool?>))]
    public bool? Voided { get; set; }

    public BillEntryQueryResultDto Copy() => (BillEntryQueryResultDto)MemberwiseClone();

    private protected override bool HasSameValue(LedgerValueQueryResultDto other) =>
        other is BillEntryQueryResultDto bill &&
        bill.Id == Id && bill.PlatformId == PlatformId && bill.Title == Title && bill.Month == Month &&
        bill.AmountCents == AmountCents && bill.Kind == Kind && bill.Status == Status &&
        bill.InstallmentIndex == InstallmentIndex && bill.InstallmentCount == InstallmentCount &&
        bill.InstallmentId == InstallmentId && bill.DepositCents == DepositCents && bill.Voided == Voided;
}

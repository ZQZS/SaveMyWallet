using System.Text.Json.Serialization;

namespace SaveMyWallet.Dto.QueryResultDto;

public sealed class BillEntryQueryResultDto : QueryResultBase
{
    public required string Id { get; init; }
    public required string PlatformId { get; init; }
    public required string Title { get; set; }
    public required string Month { get; set; }
    public required long AmountCents { get; set; }
    public required string Kind { get; init; }
    public required string Status { get; set; }
    public required int? InstallmentIndex { get; init; }
    public required int? InstallmentCount { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? InstallmentId { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public long? DepositCents { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Voided { get; set; }
}

using System.Text.Json.Serialization;

namespace SaveMyWallet.Dto.QueryDto;

[JsonNumberHandling(JsonNumberHandling.Strict)]
public sealed class NewBillQueryDto(
    string PlatformId,
    string Title,
    string Month,
    long AmountCents,
    string Kind,
    uint InstallmentCount,
    long? TotalCents = null,
    long? DepositCents = null,
    int? InstallmentIndex = null) : QueryBase
{
    [JsonRequired]
    public string PlatformId { get; init; } = PlatformId;

    [JsonRequired]
    public string Title { get; init; } = Title;

    [JsonRequired]
    public string Month { get; init; } = Month;

    [JsonRequired]
    public long AmountCents { get; init; } = AmountCents;

    [JsonRequired]
    public string Kind { get; init; } = Kind;

    [JsonRequired]
    public uint InstallmentCount { get; init; } = InstallmentCount;

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public long? TotalCents { get; init; } = TotalCents;

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public long? DepositCents { get; init; } = DepositCents;

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? InstallmentIndex { get; init; } = InstallmentIndex;
}

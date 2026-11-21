using System.Text.Json.Serialization;

namespace SaveMyWallet.Dto.QueryDto;

[JsonNumberHandling(JsonNumberHandling.Strict)]
public sealed class ConfirmationQueryDto(
    string Title,
    string Month,
    long AmountCents,
    long? TotalCents = null,
    long? DepositCents = null) : QueryBase
{
    [JsonRequired]
    public string Title { get; init; } = Title;

    [JsonRequired]
    public string Month { get; init; } = Month;

    [JsonRequired]
    public long AmountCents { get; init; } = AmountCents;

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public long? TotalCents { get; init; } = TotalCents;

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public long? DepositCents { get; init; } = DepositCents;
}

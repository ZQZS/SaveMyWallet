using System.Text.Json.Serialization;

namespace SaveMyWallet.Dto.QueryDto;

[JsonNumberHandling(JsonNumberHandling.Strict)]
public sealed class BudgetQueryDto(string Month, long DefaultSalaryCents, long WarningFloorCents, long? OverrideSalaryCents) : QueryBase
{
    [JsonRequired]
    public string Month { get; init; } = Month;

    [JsonRequired]
    public long DefaultSalaryCents { get; init; } = DefaultSalaryCents;

    [JsonRequired]
    public long WarningFloorCents { get; init; } = WarningFloorCents;

    [JsonRequired]
    public long? OverrideSalaryCents { get; init; } = OverrideSalaryCents;
}

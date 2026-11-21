using System.Text.Json.Serialization;

namespace SaveMyWallet.Dto.QueryDto;

public sealed class PaymentQueryDto(string[] Ids, bool Paid) : QueryBase
{
    [JsonRequired]
    public string[] Ids { get; init; } = Ids;

    [JsonRequired]
    public bool Paid { get; init; } = Paid;
}

using System.Text.Json.Serialization;

namespace SaveMyWallet.Dto.QueryDto;

public sealed class BillValidityQueryDto(bool Voided) : QueryBase
{
    [JsonRequired]
    public bool Voided { get; init; } = Voided;
}

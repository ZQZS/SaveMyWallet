using System.Text.Json.Serialization;
using SaveMyWallet.Dto.Serialization;

namespace SaveMyWallet.Dto;

[JsonConverter(typeof(LedgerEnumJsonConverter<BillKind>))]
public enum BillKind
{
    Single,
    Installment,
    Estimate
}

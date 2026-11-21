using System.Text.Json.Serialization;
using SaveMyWallet.Dto.Serialization;

namespace SaveMyWallet.Dto;

[JsonConverter(typeof(LedgerEnumJsonConverter<BillStatus>))]
public enum BillStatus
{
    Due,
    Paid,
    Estimated
}

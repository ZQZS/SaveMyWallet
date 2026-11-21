using System.Text.Json.Serialization;
using SaveMyWallet.Dto.Serialization;

namespace SaveMyWallet.Dto;

[JsonConverter(typeof(LedgerEnumJsonConverter<SyncRecordKind>))]
public enum SyncRecordKind
{
    Platform,
    Entry,
    Setting,
    Override
}

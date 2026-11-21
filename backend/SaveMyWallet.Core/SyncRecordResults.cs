using SaveMyWallet.Dto;
using SaveMyWallet.Dto.EntityDto;
using SaveMyWallet.Dto.QueryResultDto;

namespace SaveMyWallet.Core;

public static class SyncRecordResults
{
    public static SyncRecordQueryResultDto FromEntity(SyncRecordEntityDto record) => record.Kind switch
    {
        SyncRecordKind.Platform => new SyncRecordQueryResultDto<PlatformQueryResultDto?>(record.Kind, record.Id,
            (PlatformQueryResultDto?)record.Value, record.Version),
        SyncRecordKind.Entry => new SyncRecordQueryResultDto<BillEntryQueryResultDto?>(record.Kind, record.Id,
            (BillEntryQueryResultDto?)record.Value, record.Version),
        SyncRecordKind.Setting or SyncRecordKind.Override => new SyncRecordQueryResultDto<long?>(record.Kind, record.Id,
            ((AmountQueryResultDto?)record.Value)?.Cents, record.Version),
        _ => throw new ArgumentOutOfRangeException(nameof(record), record.Kind, "Unknown sync record kind.")
    };
}

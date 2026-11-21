using System.Text.Json;
using SaveMyWallet.Dto.EntityDto;
using SaveMyWallet.Dto.QueryResultDto;

namespace SaveMyWallet.Core;

public static class SyncRecordResults
{
    public static SyncRecordQueryResultDto FromEntity(SyncRecordEntityDto record) => record.Kind switch
    {
        "platform" => new SyncRecordQueryResultDto<PlatformQueryResultDto?>(record.Kind, record.Id,
            record.Value?.Deserialize<PlatformQueryResultDto>(JsonSerializerOptions.Web), record.Version),
        "entry" => new SyncRecordQueryResultDto<BillEntryQueryResultDto?>(record.Kind, record.Id,
            record.Value?.Deserialize<BillEntryQueryResultDto>(JsonSerializerOptions.Web), record.Version),
        "setting" or "override" => new SyncRecordQueryResultDto<long?>(record.Kind, record.Id,
            record.Value?.Deserialize<long>(JsonSerializerOptions.Web), record.Version),
        _ => throw new JsonException("Unknown sync record kind.")
    };
}

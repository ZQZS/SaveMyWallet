using System.Text.Json.Serialization;
using SaveMyWallet.Dto.QueryResultDto;

namespace SaveMyWallet.Dto.QueryDto;

[JsonConverter(typeof(SyncChangeQueryDtoConverter))]
public sealed class SyncChangeQueryDto(SyncRecordKind kind, string id, string? baseVersion,
    LedgerValueQueryResultDto? before, LedgerValueQueryResultDto? after) : QueryBase
{
    public SyncRecordKind Kind { get; } = kind;
    public string Id { get; } = id;
    public string? BaseVersion { get; } = baseVersion;
    public LedgerValueQueryResultDto? Before { get; } = before;
    public LedgerValueQueryResultDto? After { get; } = after;
}

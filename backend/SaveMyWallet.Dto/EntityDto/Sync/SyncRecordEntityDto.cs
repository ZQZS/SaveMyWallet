using SaveMyWallet.Dto.QueryResultDto;

namespace SaveMyWallet.Dto.EntityDto;

public sealed class SyncRecordEntityDto(SyncRecordKind kind, string id, LedgerValueQueryResultDto? value, string? version) : EntityBase
{
    public SyncRecordKind Kind { get; } = kind;
    public string Id { get; } = id;
    public LedgerValueQueryResultDto? Value { get; } = value;
    public string? Version { get; } = version;
}

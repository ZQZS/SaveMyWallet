namespace SaveMyWallet.Dto.QueryResultDto;

public sealed class SyncConflictQueryResultDto(string code, long cursor, IReadOnlyList<SyncRecordQueryResultDto> records)
    : QueryResultBase
{
    public string Code { get; } = code;
    public long Cursor { get; } = cursor;
    public IReadOnlyList<SyncRecordQueryResultDto> Records { get; } = records;
}

namespace SaveMyWallet.Dto.QueryResultDto;

public class PushQueryResultDto(string OperationId, long Cursor, IReadOnlyList<SyncRecordQueryResultDto> Records,
    IReadOnlyList<string> ChangedIds) : QueryResultBase
{
    public string OperationId { get; init; } = OperationId;
    public long Cursor { get; init; } = Cursor;
    public IReadOnlyList<SyncRecordQueryResultDto> Records { get; init; } = Records;
    public IReadOnlyList<string> ChangedIds { get; init; } = ChangedIds;
}

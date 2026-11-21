namespace SaveMyWallet.Dto.QueryResultDto;

public class PullQueryResultDto(string LedgerId, long Cursor, IReadOnlyList<SyncRecordQueryResultDto> Records, bool HasMore) : QueryResultBase
{
    public string LedgerId { get; init; } = LedgerId;
    public long Cursor { get; init; } = Cursor;
    public bool SupportsAiRevert => true;
    public IReadOnlyList<SyncRecordQueryResultDto> Records { get; init; } = Records;
    public bool HasMore { get; init; } = HasMore;
}

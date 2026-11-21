namespace SaveMyWallet.Dto.QueryResultDto;

public class BootstrapQueryResultDto(string LedgerId, long Cursor, IReadOnlyList<SyncRecordQueryResultDto> Records) : QueryResultBase
{
    public string LedgerId { get; init; } = LedgerId;
    public long Cursor { get; init; } = Cursor;
    public bool SupportsAiRevert => true;
    public IReadOnlyList<SyncRecordQueryResultDto> Records { get; init; } = Records;
}

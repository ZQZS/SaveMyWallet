using SaveMyWallet.Dto.EntityDto;

namespace SaveMyWallet.Core;

public class LedgerException(int status, string code, string message) : Exception(message)
{
    public int Status { get; } = status;
    public string Code { get; } = code;
}

public sealed class SyncConflict(string code, long cursor, IReadOnlyList<SyncRecordEntityDto> records)
    : LedgerException(409, code, "The submitted changes no longer match the ledger.")
{
    public long Cursor { get; } = cursor;
    public IReadOnlyList<SyncRecordEntityDto> Records { get; } = records;
}

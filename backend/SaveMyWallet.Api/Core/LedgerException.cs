using SaveMyWallet.Api.Dto;

namespace SaveMyWallet.Api.Core;

public class LedgerException(int status, string code, string message) : Exception(message)
{
    public int Status { get; } = status;
    public string Code { get; } = code;
}

internal sealed class SyncConflict(string code, long cursor, IReadOnlyList<SyncRecord> records)
    : LedgerException(409, code, "The submitted changes no longer match the ledger.")
{
    public long Cursor { get; } = cursor;
    public IReadOnlyList<SyncRecord> Records { get; } = records;
}

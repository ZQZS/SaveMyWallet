namespace SaveMyWallet.Infrastructure.Persistence;

internal sealed class LedgerHead
{
    public required string LedgerId { get; init; }
    public long Cursor { get; set; }
}

internal sealed class StoredRecord
{
    public required string LedgerId { get; init; }
    public required string Kind { get; init; }
    public required string Id { get; init; }
    public string? Value { get; set; }
    public required string Version { get; set; }
}

internal sealed class ChangeBatch
{
    public required string LedgerId { get; init; }
    public required long Cursor { get; init; }
    public required string Records { get; init; }
}

internal sealed class Receipt
{
    public required string LedgerId { get; init; }
    public required string OperationId { get; init; }
    public required string Request { get; init; }
    public required string Response { get; init; }
}

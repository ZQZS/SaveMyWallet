namespace SaveMyWallet.Api.Infrastructure.Persistence;

public sealed class LedgerHead
{
    public required string LedgerId { get; init; }
    public long Cursor { get; set; }
}

public sealed class StoredRecord
{
    public required string LedgerId { get; init; }
    public required string Kind { get; init; }
    public required string Id { get; init; }
    public string? Value { get; set; }
    public required string Version { get; set; }
}

public sealed class ChangeBatch
{
    public required string LedgerId { get; init; }
    public required long Cursor { get; init; }
    public required string Records { get; init; }
}

public sealed class Receipt
{
    public required string LedgerId { get; init; }
    public required string OperationId { get; init; }
    public required string Request { get; init; }
    public required string Response { get; init; }
}

namespace SaveMyWallet.Dto.EntityDto;

public sealed class StoredRecordEntityDto : EntityBase
{
    public required string LedgerId { get; init; }
    public required string Kind { get; init; }
    public required string Id { get; init; }
    public string? Value { get; set; }
    public required string Version { get; set; }
}

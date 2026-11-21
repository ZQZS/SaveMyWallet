namespace SaveMyWallet.Dto.EntityDto;

public sealed class StoredRecordEntityDto : EntityBase
{
    public required string LedgerId { get; init; }
    public required SyncRecordKind Kind { get; init; }
    public required string Id { get; init; }
    public required string Version { get; set; }

    public string? PlatformName { get; set; }
    public string? PlatformId { get; set; }
    public string? Title { get; set; }
    public DateOnly? BillMonth { get; set; }
    public BillKind? BillKind { get; set; }
    public BillStatus? BillStatus { get; set; }
    public long? AmountCents { get; set; }
    public int? InstallmentIndex { get; set; }
    public int? InstallmentCount { get; set; }
    public string? InstallmentId { get; set; }
    public long? DepositCents { get; set; }
    public bool? IsVoided { get; set; }
}

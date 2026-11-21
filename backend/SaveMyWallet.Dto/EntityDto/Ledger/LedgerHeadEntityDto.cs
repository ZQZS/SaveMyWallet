namespace SaveMyWallet.Dto.EntityDto;

public sealed class LedgerHeadEntityDto : EntityBase
{
    public required string LedgerId { get; init; }
    public long Cursor { get; set; }
}

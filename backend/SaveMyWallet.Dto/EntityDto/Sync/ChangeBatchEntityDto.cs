namespace SaveMyWallet.Dto.EntityDto;

public sealed class ChangeBatchEntityDto : EntityBase
{
    public required string LedgerId { get; init; }
    public required long Cursor { get; init; }
    public required string Records { get; init; }
}

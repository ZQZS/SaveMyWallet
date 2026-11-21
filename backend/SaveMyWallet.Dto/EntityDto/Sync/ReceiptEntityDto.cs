namespace SaveMyWallet.Dto.EntityDto;

public sealed class ReceiptEntityDto : EntityBase
{
    public required string LedgerId { get; init; }
    public required string OperationId { get; init; }
    public required string Request { get; init; }
    public required string Response { get; init; }
}

namespace SaveMyWallet.Dto.QueryDto;

public class SyncOperationQueryDto(string OperationId, IReadOnlyList<SyncChangeQueryDto> Changes, bool Seed = false) : QueryBase
{
    public string OperationId { get; init; } = OperationId;
    public IReadOnlyList<SyncChangeQueryDto> Changes { get; init; } = Changes;
    public bool Seed { get; init; } = Seed;
}

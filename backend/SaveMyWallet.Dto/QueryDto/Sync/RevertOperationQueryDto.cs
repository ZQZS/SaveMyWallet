using System.Text.Json.Serialization;

namespace SaveMyWallet.Dto.QueryDto;

public sealed class RevertOperationQueryDto(string OperationId, IReadOnlyList<SyncChangeQueryDto> Changes,
    IReadOnlyList<string> RevertOperationIds, bool Seed = false) : QueryBase
{
    public string OperationId { get; init; } = OperationId;
    public IReadOnlyList<SyncChangeQueryDto> Changes { get; init; } = Changes;
    public IReadOnlyList<string> RevertOperationIds { get; init; } = RevertOperationIds;
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool Seed { get; init; } = Seed;
}

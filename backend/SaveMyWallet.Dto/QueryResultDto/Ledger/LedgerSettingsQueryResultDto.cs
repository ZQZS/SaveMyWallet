namespace SaveMyWallet.Dto.QueryResultDto;

public sealed class LedgerSettingsQueryResultDto(long defaultSalaryCents, long warningFloorCents) : QueryResultBase
{
    public long DefaultSalaryCents { get; init; } = defaultSalaryCents;
    public long WarningFloorCents { get; init; } = warningFloorCents;
}

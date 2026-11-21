namespace SaveMyWallet.Dto.QueryResultDto;

public sealed class LedgerSnapshotQueryResultDto(
    IReadOnlyList<PlatformQueryResultDto> platforms,
    IReadOnlyList<BillEntryQueryResultDto> entries,
    LedgerSettingsQueryResultDto settings,
    IReadOnlyDictionary<string, long> salaryOverrides) : QueryResultBase
{
    public IReadOnlyList<PlatformQueryResultDto> Platforms { get; init; } = platforms;
    public IReadOnlyList<BillEntryQueryResultDto> Entries { get; init; } = entries;
    public LedgerSettingsQueryResultDto Settings { get; init; } = settings;
    public IReadOnlyDictionary<string, long> SalaryOverrides { get; init; } = salaryOverrides;
}

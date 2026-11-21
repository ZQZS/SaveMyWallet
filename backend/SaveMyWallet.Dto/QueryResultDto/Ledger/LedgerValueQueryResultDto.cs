namespace SaveMyWallet.Dto.QueryResultDto;

public abstract class LedgerValueQueryResultDto : QueryResultBase
{
    public static bool SameValue(LedgerValueQueryResultDto? left, LedgerValueQueryResultDto? right) =>
        ReferenceEquals(left, right) || left is not null && right is not null && left.HasSameValue(right);

    private protected abstract bool HasSameValue(LedgerValueQueryResultDto other);
}

using System.Text;
using SaveMyWallet.Dto;
using SaveMyWallet.Dto.QueryDto;

namespace SaveMyWallet.Core;

public static class SyncRules
{
    public static void ValidateOperation(SyncOperationQueryDto operation)
    {
        CheckOperationId(operation.OperationId);
        if (operation.Changes is null || operation.Changes.Count == 0)
            throw new LedgerException(400, "invalid_changes", "Submit at least one change.");
        ValidateEnvelope(operation.Changes);
    }

    public static void CheckOperationId(string operationId)
    {
        if (!LedgerRules.IsSafeKey(operationId, 128))
            throw new LedgerException(400, "invalid_operation_id", "Invalid operation ID.");
    }

    public static void ValidateEnvelope(IReadOnlyList<SyncChangeQueryDto> changes)
    {
        var keys = new HashSet<(SyncRecordKind, string)>();
        foreach (var change in changes)
        {
            if (change is null || string.IsNullOrWhiteSpace(change.Id) || change.Id != change.Id.Trim() || change.Id.Contains('\0') ||
                Encoding.UTF8.GetByteCount(change.Id) > 1024 || !keys.Add((change.Kind, change.Id)) ||
                change.BaseVersion is not null && !LedgerRules.IsSafeKey(change.BaseVersion, 128))
                throw new LedgerException(400, "invalid_changes", "Invalid or repeated record key or version.");
        }
    }
}

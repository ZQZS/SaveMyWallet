using System.Data;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using SaveMyWallet.Constant;
using SaveMyWallet.Core;
using SaveMyWallet.Dto.EntityDto;
using SaveMyWallet.Dto.QueryDto;
using SaveMyWallet.Dto.QueryResultDto;
using SaveMyWallet.Interfaces;

namespace SaveMyWallet.Infrastructure.Persistence;

internal sealed class SyncStore(LedgerDb db) : ISyncStore
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public async Task<BootstrapQueryResultDto> BootstrapAsync(string ledgerId, CancellationToken ct)
    {
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);
        var cursor = await Cursor(ledgerId, ct);
        var rows = await db.Records.AsNoTracking().Where(r => r.LedgerId == ledgerId)
            .OrderBy(r => r.Kind).ThenBy(r => r.Id).ToListAsync(ct);
        await tx.CommitAsync(ct);
        return new BootstrapQueryResultDto(ledgerId, cursor, rows.Select(ToRecord).Select(SyncRecordResults.FromEntity).ToArray());
    }

    public async Task<PullQueryResultDto> PullAsync(string ledgerId, long cursor, CancellationToken ct)
    {
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);
        var latest = await Cursor(ledgerId, ct);
        if (cursor > latest) throw new LedgerException(409, "invalid_cursor", "Cursor is ahead of this ledger.");
        var batches = await db.Batches.AsNoTracking().Where(b => b.LedgerId == ledgerId && b.Cursor > cursor)
            .OrderBy(b => b.Cursor).Take(SyncConstants.PullPageSize).ToListAsync(ct);
        await tx.CommitAsync(ct);
        var changes = new Dictionary<(string, string), SyncRecordQueryResultDto>();
        foreach (var batch in batches)
        {
            foreach (var row in JsonSerializer.Deserialize<SyncRecordQueryResultDto[]>(batch.Records, Json)!)
                changes[(row.Kind, row.Id)] = row;
            cursor = batch.Cursor;
        }
        return new PullQueryResultDto(ledgerId, cursor, changes.Values.ToArray(), cursor < latest);
    }

    public Task<PushQueryResultDto> PushAsync(string ledgerId, SyncOperationQueryDto operation, CancellationToken ct)
    {
        var request = JsonSerializer.SerializeToElement(operation, Json);
        return Write(ledgerId, operation.OperationId, request, operation.Seed, operation.Changes,
            _ => new RestMutationEntityDto(operation.Changes),
            (_, cursor, current, changed) => new PushQueryResultDto(operation.OperationId, cursor,
                current.Select(SyncRecordResults.FromEntity).ToArray(), changed.Select(r => r.Id).ToArray()), ct);
    }

    public Task ExecuteRestAsync(string ledgerId, string operationId, string fingerprint,
        Func<IReadOnlyList<SyncRecordEntityDto>, RestMutationEntityDto> build, CancellationToken ct) =>
        Write<RestMutationEntityDto, QueryResultBase?>(ledgerId, operationId, JsonSerializer.SerializeToElement(fingerprint), false,
            null, build, static (_, _, _, _) => null, ct);

    public Task<TResult> ExecuteRestAsync<TResult>(string ledgerId, string operationId, string fingerprint,
        Func<IReadOnlyList<SyncRecordEntityDto>, RestMutationEntityDto<TResult>> build, CancellationToken ct)
        where TResult : QueryResultBase =>
        Write(ledgerId, operationId, JsonSerializer.SerializeToElement(fingerprint), false,
            null, build, static (mutation, _, _, _) => mutation.Response, ct);

    private async Task<TResult> Write<TMutation, TResult>(string ledgerId, string operationId, JsonElement request,
        bool seed, IReadOnlyList<SyncChangeQueryDto>? syncChanges, Func<IReadOnlyList<SyncRecordEntityDto>, TMutation> build,
        Func<TMutation, long, IReadOnlyList<SyncRecordEntityDto>, IReadOnlyList<SyncRecordEntityDto>, TResult> buildResponse,
        CancellationToken ct)
        where TMutation : RestMutationEntityDto
        where TResult : QueryResultBase?
    {
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        // All write paths acquire this ledger's lock before checking receipts or incrementing its cursor.
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""INSERT INTO smw_ledgers ("LedgerId","Cursor") VALUES ({ledgerId},0) ON CONFLICT DO NOTHING""", ct);
        var head = await db.Ledgers.FromSql($"""SELECT * FROM smw_ledgers WHERE "LedgerId" = {ledgerId} FOR UPDATE""")
            .SingleAsync(ct);
        var receipt = await db.Receipts.FindAsync([ledgerId, operationId], ct);
        if (receipt is not null)
        {
            if (!JsonElement.DeepEquals(request, JsonElement.Parse(receipt.Request)))
                throw new LedgerException(409, "replay_mismatch", "This operation ID already belongs to another request.");
            return JsonSerializer.Deserialize<TResult>(receipt.Response, Json)!;
        }
        if (seed && head.Cursor != 0) throw new SyncConflict("seed_exists", head.Cursor, []);

        var query = db.Records.Where(r => r.LedgerId == ledgerId);
        if (syncChanges is not null)
        {
            var ids = syncChanges.Select(c => c.Id).Distinct().ToArray();
            // Only insertions can add members to a series. Load their siblings under the ledger lock.
            var seriesIds = syncChanges.Where(c => c.Kind == "entry" && c.Before is null)
                .Select(c => LedgerValues.GetInstallmentIdHint(c.After))
                .OfType<string>().Distinct().ToArray();
            query = seriesIds.Length == 0
                ? query.Where(r => r.Kind == "platform" || ids.Contains(r.Id))
                : db.Records.FromSql($"""
                    SELECT * FROM smw_records WHERE "LedgerId" = {ledgerId} AND
                    ("Kind" = 'platform' OR "Id" = ANY({ids}) OR
                     CASE
                         WHEN "Kind" <> 'entry' THEN NULL
                         WHEN "Value" ? 'installmentId' THEN "Value"->>'installmentId'
                         WHEN COALESCE("Value"->>'kind', "Value"->>'Kind') IN ('single', 'estimate') THEN NULL
                         -- Older clients also wrote other casings of the installmentId property.
                         ELSE (SELECT field.value FROM jsonb_each_text("Value") AS field
                               WHERE lower(field.key COLLATE "C") = 'installmentid' LIMIT 1)
                     END = ANY({seriesIds}))
                    """);
        }
        var rows = await query.ToListAsync(ct);
        var known = rows.Select(ToRecord).ToArray();
        var byKey = rows.ToDictionary(r => (r.Kind, r.Id));
        var mutation = build(known);
        if (syncChanges is null) SyncRules.ValidateEnvelope(mutation.Changes);

        var current = mutation.Changes.Select(c => byKey.TryGetValue((c.Kind, c.Id), out var row)
            ? ToRecord(row) : new SyncRecordEntityDto(c.Kind, c.Id, null, null)).ToArray();
        for (int i = 0; i < current.Length; i++)
        {
            var change = mutation.Changes[i];
            var existing = current[i];
            if (ValuesEqual(change.After, existing.Value)) continue;
            if (existing.Version != change.BaseVersion || !ValuesEqual(change.Before, existing.Value))
                throw new SyncConflict("conflict", head.Cursor, current);
        }
        LedgerRules.Validate(known, mutation.Changes);

        var changed = new List<SyncRecordEntityDto>();
        for (int i = 0; i < current.Length; i++)
        {
            var change = mutation.Changes[i];
            if (ValuesEqual(change.After, current[i].Value)) continue;
            if (!byKey.TryGetValue((change.Kind, change.Id), out var row))
            {
                row = new StoredRecordEntityDto { LedgerId = ledgerId, Kind = change.Kind, Id = change.Id, Version = operationId };
                db.Records.Add(row);
            }
            row.Value = change.After?.GetRawText();
            row.Version = operationId;
            current[i] = new SyncRecordEntityDto(row.Kind, row.Id, change.After, operationId);
            changed.Add(current[i]);
        }
        if (changed.Count > 0)
        {
            head.Cursor++;
            db.Batches.Add(new ChangeBatchEntityDto { LedgerId = ledgerId, Cursor = head.Cursor,
                Records = JsonSerializer.Serialize(changed, Json) });
        }
        var response = buildResponse(mutation, head.Cursor, current, changed);
        db.Receipts.Add(new ReceiptEntityDto { LedgerId = ledgerId, OperationId = operationId,
            Request = request.GetRawText(), Response = JsonSerializer.Serialize(response, Json) });
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return response;
    }

    private Task<long> Cursor(string ledgerId, CancellationToken ct) =>
        db.Ledgers.AsNoTracking().Where(l => l.LedgerId == ledgerId).Select(l => l.Cursor).SingleOrDefaultAsync(ct);

    private static bool ValuesEqual(JsonElement? left, JsonElement? right) =>
        left.HasValue && right.HasValue ? JsonElement.DeepEquals(left.Value, right.Value) : left.HasValue == right.HasValue;

    private static SyncRecordEntityDto ToRecord(StoredRecordEntityDto row) =>
        new(row.Kind, row.Id, row.Value is null ? null : JsonSerializer.Deserialize<JsonElement?>(row.Value), row.Version);
}

using System.Data;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using SaveMyWallet.Constant;
using SaveMyWallet.Core;
using SaveMyWallet.Dto;
using SaveMyWallet.Dto.EntityDto;
using SaveMyWallet.Dto.QueryDto;
using SaveMyWallet.Dto.QueryResultDto;
using SaveMyWallet.Dto.Serialization;
using SaveMyWallet.Interfaces;

namespace SaveMyWallet.Infrastructure.Persistence;

internal sealed class SyncStore(LedgerDb db) : ISyncStore
{
    public async Task<BootstrapQueryResultDto> BootstrapAsync(string ledgerId, CancellationToken ct)
    {
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);
        var cursor = await Cursor(ledgerId, ct);
        var rows = await db.Records.AsNoTracking().Where(r => r.LedgerId == ledgerId)
            .OrderBy(r => r.Kind).ThenBy(r => r.Id).ToListAsync(ct);
        await tx.CommitAsync(ct);
        return new BootstrapQueryResultDto(ledgerId, cursor, rows.Select(StoredRecords.ToRecord).Select(SyncRecordResults.FromEntity).ToArray());
    }

    public async Task<PullQueryResultDto> PullAsync(string ledgerId, long cursor, CancellationToken ct)
    {
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);
        var latest = await Cursor(ledgerId, ct);
        if (cursor > latest) throw new LedgerException(409, "invalid_cursor", "Cursor is ahead of this ledger.");
        var batches = await db.Batches.AsNoTracking().Where(b => b.LedgerId == ledgerId && b.Cursor > cursor)
            .OrderBy(b => b.Cursor).Take(SyncConstants.PullPageSize).ToListAsync(ct);
        await tx.CommitAsync(ct);
        var changes = new Dictionary<(SyncRecordKind, string), SyncRecordQueryResultDto>();
        foreach (var batch in batches)
        {
            foreach (var row in JsonSerializer.Deserialize<SyncRecordQueryResultDto[]>(batch.Records, LedgerJson.Options)!)
                changes[(row.Kind, row.Id)] = row;
            cursor = batch.Cursor;
        }
        return new PullQueryResultDto(ledgerId, cursor, changes.Values.ToArray(), cursor < latest);
    }

    public Task<PushQueryResultDto> PushAsync(string ledgerId, SyncOperationQueryDto operation, CancellationToken ct)
    {
        var request = JsonSerializer.SerializeToElement(operation, LedgerJson.Options);
        return Write(ledgerId, operation.OperationId, request, operation.Seed, operation.Changes,
            _ => new RestMutationEntityDto(operation.Changes),
            (_, cursor, current, changed) => new PushQueryResultDto(operation.OperationId, cursor,
                current.Select(SyncRecordResults.FromEntity).ToArray(), changed.Select(r => r.Id).ToArray()), ct);
    }

    public Task<PushQueryResultDto> RevertAsync(string ledgerId, RevertOperationQueryDto operation, CancellationToken ct) =>
        Write(ledgerId, operation.OperationId, JsonSerializer.SerializeToElement(operation, LedgerJson.Options), false,
            operation.Changes, _ => new RestMutationEntityDto(operation.Changes),
            (_, cursor, current, changed) => new PushQueryResultDto(operation.OperationId, cursor,
                current.Select(SyncRecordResults.FromEntity).ToArray(), changed.Select(r => r.Id).ToArray()),
            ct, operation.RevertOperationIds);

    public Task ExecuteRestAsync(string ledgerId, string operationId, string fingerprint,
        Func<IReadOnlyList<SyncRecordEntityDto>, RestMutationEntityDto> build, CancellationToken ct) =>
        Write<RestMutationEntityDto, QueryResultBase?>(ledgerId, operationId, JsonSerializer.SerializeToElement(fingerprint, LedgerJson.Options), false,
            null, build, static (_, _, _, _) => null, ct);

    public Task<TResult> ExecuteRestAsync<TResult>(string ledgerId, string operationId, string fingerprint,
        Func<IReadOnlyList<SyncRecordEntityDto>, RestMutationEntityDto<TResult>> build, CancellationToken ct)
        where TResult : QueryResultBase =>
        Write(ledgerId, operationId, JsonSerializer.SerializeToElement(fingerprint, LedgerJson.Options), false,
            null, build, static (mutation, _, _, _) => mutation.Response, ct);

    private async Task<TResult> Write<TMutation, TResult>(string ledgerId, string operationId, JsonElement request,
        bool seed, IReadOnlyList<SyncChangeQueryDto>? syncChanges, Func<IReadOnlyList<SyncRecordEntityDto>, TMutation> build,
        Func<TMutation, long, IReadOnlyList<SyncRecordEntityDto>, IReadOnlyList<SyncRecordEntityDto>, TResult> buildResponse,
        CancellationToken ct, IReadOnlyList<string>? revertIds = null)
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
            return JsonSerializer.Deserialize<TResult>(receipt.Response, LedgerJson.Options)!;
        }
        if (seed && head.Cursor != 0) throw new SyncConflict("seed_exists", head.Cursor, []);

        var query = db.Records.Where(r => r.LedgerId == ledgerId);
        if (syncChanges is not null)
        {
            var ids = syncChanges.Select(c => c.Id).Distinct().ToArray();
            // Only insertions can add members to a series. Load their siblings under the ledger lock.
            var seriesIds = syncChanges.Where(c => c.Kind == SyncRecordKind.Entry && c.Before is null)
                .Select(c => c.After).OfType<BillEntryQueryResultDto>().Select(e => e.InstallmentId)
                .OfType<string>().Distinct().ToArray();
            query = query.Where(r => r.Kind == SyncRecordKind.Platform || ids.Contains(r.Id) ||
                (r.Kind == SyncRecordKind.Entry && r.InstallmentId != null && seriesIds.Contains(r.InstallmentId)));
        }
        var rows = await query.ToListAsync(ct);
        var known = rows.Select(StoredRecords.ToRecord).ToArray();
        var byKey = rows.ToDictionary(r => (r.Kind, r.Id));
        var mutation = build(known);
        if (syncChanges is null) SyncRules.ValidateEnvelope(mutation.Changes);

        var current = mutation.Changes.Select(c => byKey.TryGetValue((c.Kind, c.Id), out var row)
            ? StoredRecords.ToRecord(row) : new SyncRecordEntityDto(c.Kind, c.Id, null, null)).ToArray();
        if (revertIds is not null)
            await ReceiptRevert.VerifyAsync(db, ledgerId, revertIds, mutation.Changes, current, head.Cursor, ct);
        for (int i = 0; i < current.Length; i++)
        {
            var change = mutation.Changes[i];
            var existing = current[i];
            if (LedgerValueQueryResultDto.SameValue(change.After, existing.Value)) continue;
            if (existing.Version != change.BaseVersion || !LedgerValueQueryResultDto.SameValue(change.Before, existing.Value))
                throw new SyncConflict("conflict", head.Cursor, current);
        }
        if (revertIds is not null)
        {
            try { LedgerRules.ValidateReceiptRevert(known, mutation.Changes); }
            catch (LedgerException) { throw new SyncConflict("conflict", head.Cursor, current); }
        }
        else
        {
            try { LedgerRules.Validate(known, mutation.Changes); }
            catch (LedgerException ex) when (syncChanges is not null && ex.Code == "unknown_platform")
            {
                // Another device can still have a queued bill for a platform whose creation was undone.
                var platforms = known.Where(r => r.Kind == SyncRecordKind.Platform).Select(r => r.Id)
                    .Concat(mutation.Changes.Where(c => c.Kind == SyncRecordKind.Platform).Select(c => c.Id));
                var missing = mutation.Changes.Select(c => c.After).OfType<BillEntryQueryResultDto>()
                    .Select(b => b.PlatformId).Except(platforms).ToArray();
                var removed = await db.Database.SqlQuery<bool>($"""
                    SELECT EXISTS (SELECT 1 FROM smw_changes, jsonb_array_elements("Records") e
                        WHERE "LedgerId"={ledgerId} AND e->>'kind'='platform' AND e->>'id'=ANY({missing})
                        AND e->'value'='null'::jsonb) AS "Value"
                    """).SingleAsync(ct);
                if (removed) throw new SyncConflict("conflict", head.Cursor, current);
                throw;
            }
        }

        var changed = new List<SyncRecordEntityDto>();
        for (int i = 0; i < current.Length; i++)
        {
            var change = mutation.Changes[i];
            if (LedgerValueQueryResultDto.SameValue(change.After, current[i].Value)) continue;
            if (!byKey.TryGetValue((change.Kind, change.Id), out var row))
            {
                row = new StoredRecordEntityDto { LedgerId = ledgerId, Kind = change.Kind, Id = change.Id, Version = operationId };
                db.Records.Add(row);
            }
            if (revertIds is not null && change.After is null && change.Kind is SyncRecordKind.Entry or SyncRecordKind.Platform)
            {
                db.Records.Remove(row);
                current[i] = new SyncRecordEntityDto(row.Kind, row.Id, null, null);
            }
            else
            {
                StoredRecords.Apply(row, change.After);
                row.Version = operationId;
                current[i] = new SyncRecordEntityDto(row.Kind, row.Id, change.After, operationId);
            }
            changed.Add(current[i]);
        }
        if (changed.Count > 0)
        {
            head.Cursor++;
            db.Batches.Add(new ChangeBatchEntityDto { LedgerId = ledgerId, Cursor = head.Cursor,
                Records = JsonSerializer.Serialize(changed.Select(SyncRecordResults.FromEntity), LedgerJson.Options) });
        }
        var response = buildResponse(mutation, head.Cursor, current, changed);
        db.Receipts.Add(new ReceiptEntityDto { LedgerId = ledgerId, OperationId = operationId,
            Request = request.GetRawText(), Response = JsonSerializer.Serialize(response, LedgerJson.Options) });
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return response;
    }

    private Task<long> Cursor(string ledgerId, CancellationToken ct) =>
        db.Ledgers.AsNoTracking().Where(l => l.LedgerId == ledgerId).Select(l => l.Cursor).SingleOrDefaultAsync(ct);
}

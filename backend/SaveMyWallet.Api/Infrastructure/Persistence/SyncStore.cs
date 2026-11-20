using System.Data;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using SaveMyWallet.Api.Core;
using SaveMyWallet.Api.Dto;
using SaveMyWallet.Api.Interfaces;

namespace SaveMyWallet.Api.Infrastructure.Persistence;

public sealed class SyncStore(LedgerDb db) : ISyncStore
{
    private const int PageSize = 64;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public async Task<BootstrapResult> BootstrapAsync(string ledgerId, CancellationToken ct)
    {
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);
        var cursor = await Cursor(ledgerId, ct);
        var rows = await db.Records.AsNoTracking().Where(r => r.LedgerId == ledgerId)
            .OrderBy(r => r.Kind).ThenBy(r => r.Id).ToListAsync(ct);
        var result = new BootstrapResult(ledgerId, cursor, rows.Select(ToRecord).ToArray());
        await tx.CommitAsync(ct);
        return result;
    }

    public async Task<PullResult> PullAsync(string ledgerId, long cursor, CancellationToken ct)
    {
        if (cursor < 0) throw new LedgerException(400, "invalid_cursor", "Cursor must be nonnegative.");
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);
        var latest = await Cursor(ledgerId, ct);
        if (cursor > latest) throw new LedgerException(409, "invalid_cursor", "Cursor is ahead of this ledger.");
        var batches = await db.Batches.AsNoTracking().Where(b => b.LedgerId == ledgerId && b.Cursor > cursor)
            .OrderBy(b => b.Cursor).Take(PageSize).ToListAsync(ct);
        var changes = new Dictionary<(string, string), SyncRecord>();
        foreach (var batch in batches)
        {
            foreach (var row in JsonSerializer.Deserialize<SyncRecord[]>(batch.Records, Json)!)
                changes[(row.Kind, row.Id)] = row;
            cursor = batch.Cursor;
        }
        await tx.CommitAsync(ct);
        return new PullResult(ledgerId, cursor, changes.Values.ToArray(), cursor < latest);
    }

    public async Task<JsonNode?> PushAsync(string ledgerId, SyncOperation operation, CancellationToken ct)
    {
        SyncRules.ValidateOperation(operation);
        var request = JsonSerializer.SerializeToNode(operation, Json)!;
        return await Write(ledgerId, operation.OperationId, request, operation.Seed,
            _ => new RestMutation(operation.Changes, null), operation.Changes, ct);
    }

    public Task<JsonNode?> ExecuteRestAsync(string ledgerId, string operationId, string fingerprint,
        Func<IReadOnlyList<SyncRecord>, RestMutation> build, CancellationToken ct)
    {
        SyncRules.CheckOperationId(operationId);
        return Write(ledgerId, operationId, JsonValue.Create(fingerprint)!, false, build, null, ct);
    }

    private async Task<JsonNode?> Write(string ledgerId, string operationId, JsonNode request, bool seed,
        Func<IReadOnlyList<SyncRecord>, RestMutation> build, IReadOnlyList<SyncChange>? syncChanges, CancellationToken ct)
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
            if (!JsonNode.DeepEquals(request, JsonNode.Parse(receipt.Request)))
                throw new LedgerException(409, "replay_mismatch", "This operation ID already belongs to another request.");
            return JsonNode.Parse(receipt.Response);
        }
        if (seed && head.Cursor != 0) throw new SyncConflict("seed_exists", head.Cursor, []);

        var query = db.Records.Where(r => r.LedgerId == ledgerId);
        if (syncChanges is not null)
        {
            var ids = syncChanges.Select(c => c.Id).Distinct().ToArray();
            // Only insertions can add members to a series. Load their siblings under the ledger lock.
            var seriesIds = syncChanges.Where(c => c.Kind == "entry" && c.Before is null)
                .Select(c => (c.After as JsonObject)?["installmentId"])
                .OfType<JsonValue>().Select(v => v.TryGetValue<string>(out var id) ? id : null)
                .OfType<string>().Distinct().ToArray();
            query = seriesIds.Length == 0
                ? query.Where(r => r.Kind == "platform" || ids.Contains(r.Id))
                : db.Records.FromSql($"""
                    SELECT * FROM smw_records WHERE "LedgerId" = {ledgerId} AND
                    ("Kind" = 'platform' OR "Id" = ANY({ids}) OR
                     ("Kind" = 'entry' AND "Value"->>'installmentId' = ANY({seriesIds})))
                    """);
        }
        var rows = await query.ToListAsync(ct);
        var known = rows.Select(ToRecord).ToArray();
        var byKey = rows.ToDictionary(r => (r.Kind, r.Id));
        var mutation = build(known);
        if (syncChanges is null) SyncRules.ValidateEnvelope(mutation.Changes);

        var current = mutation.Changes.Select(c => byKey.TryGetValue((c.Kind, c.Id), out var row)
            ? ToRecord(row) : new SyncRecord(c.Kind, c.Id, null, null)).ToArray();
        for (int i = 0; i < current.Length; i++)
        {
            var change = mutation.Changes[i];
            var existing = current[i];
            if (JsonNode.DeepEquals(change.After, existing.Value)) continue;
            if (existing.Version != change.BaseVersion || !JsonNode.DeepEquals(change.Before, existing.Value))
                throw new SyncConflict("conflict", head.Cursor, current);
        }
        LedgerRules.Validate(known, mutation.Changes);

        var changed = new List<SyncRecord>();
        for (int i = 0; i < current.Length; i++)
        {
            var change = mutation.Changes[i];
            if (JsonNode.DeepEquals(change.After, current[i].Value)) continue;
            if (!byKey.TryGetValue((change.Kind, change.Id), out var row))
            {
                row = new StoredRecord { LedgerId = ledgerId, Kind = change.Kind, Id = change.Id, Version = operationId };
                db.Records.Add(row);
            }
            row.Value = change.After?.ToJsonString();
            row.Version = operationId;
            current[i] = new SyncRecord(row.Kind, row.Id, change.After, operationId);
            changed.Add(current[i]);
        }
        if (changed.Count > 0)
        {
            head.Cursor++;
            db.Batches.Add(new ChangeBatch { LedgerId = ledgerId, Cursor = head.Cursor,
                Records = JsonSerializer.Serialize(changed, Json) });
        }
        JsonNode? response = syncChanges is not null
            ? JsonSerializer.SerializeToNode(new PushResult(operationId, head.Cursor, current, changed.Select(r => r.Id).ToArray()), Json)
            : mutation.Response;
        db.Receipts.Add(new Receipt { LedgerId = ledgerId, OperationId = operationId,
            Request = request.ToJsonString(), Response = response?.ToJsonString() ?? "null" });
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return response;
    }

    private Task<long> Cursor(string ledgerId, CancellationToken ct) =>
        db.Ledgers.AsNoTracking().Where(l => l.LedgerId == ledgerId).Select(l => l.Cursor).SingleOrDefaultAsync(ct);

    private static SyncRecord ToRecord(StoredRecord row) =>
        new(row.Kind, row.Id, row.Value is null ? null : JsonNode.Parse(row.Value), row.Version);
}

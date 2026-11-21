using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using SaveMyWallet.Core;
using SaveMyWallet.Dto;
using SaveMyWallet.Dto.EntityDto;
using SaveMyWallet.Dto.QueryDto;
using SaveMyWallet.Dto.QueryResultDto;
using SaveMyWallet.Dto.Serialization;

namespace SaveMyWallet.Infrastructure.Persistence;

internal static class ReceiptRevert
{
    // Caller holds the ledger lock for verification and the subsequent write.
    internal static async Task VerifyAsync(LedgerDb db, string ledgerId, IReadOnlyList<string> sourceIds,
        IReadOnlyList<SyncChangeQueryDto> changes, SyncRecordEntityDto[] current, long cursor, CancellationToken ct)
    {
        SyncConflict Conflict() => new("conflict", cursor, current);
        var first = sourceIds[0].Split('.');
        static bool Hex(string s) => s.Length == 32 && s.All(c => char.IsAsciiDigit(c) || c is >= 'a' and <= 'f');
        if (first.Length != 3 || first[0] != "ai" || !Hex(first[1])) throw Conflict();
        var prefix = $"ai.{first[1]}.";
        if (sourceIds.Any(id => !id.StartsWith(prefix, StringComparison.Ordinal) || !Hex(id[prefix.Length..])))
            throw Conflict();

        var receipts = await db.Receipts.AsNoTracking()
            .Where(r => r.LedgerId == ledgerId && r.OperationId.StartsWith(prefix))
            .OrderBy(r => r.OperationId).Take(sourceIds.Count + 1).ToListAsync(ct);
        if (!sourceIds.ToHashSet().SetEquals(receipts.Select(r => r.OperationId))) throw Conflict();
        var deltas = new Dictionary<(string Kind, string Id), Delta>();
        foreach (var receipt in receipts)
        {
            var request = JsonElement.Parse(receipt.Request);
            if (request.ValueKind != JsonValueKind.Object || request.TryGetProperty("revertOperationIds", out _) ||
                !request.TryGetProperty("seed", out var seed) || seed.GetBoolean()) throw Conflict();
            var response = JsonElement.Parse(receipt.Response);
            var changed = response.GetProperty("records").EnumerateArray()
                .Where(r => r.GetProperty("version").GetString() == receipt.OperationId)
                .Select(Key).ToHashSet();
            foreach (var original in request.GetProperty("changes").EnumerateArray())
            {
                var key = Key(original);
                if (!changed.Contains(key)) continue;
                var before = original.GetProperty("before");
                // A missing global budget on the server has an effective value of zero on clients.
                if (key.Kind == "setting" && before.ValueKind == JsonValueKind.Null)
                    before = JsonSerializer.SerializeToElement(0);
                var delta = new Delta(receipt.OperationId, response.GetProperty("cursor").GetInt64(),
                    before, original.GetProperty("after"));
                if (!deltas.TryAdd(key, delta)) throw Conflict();
            }
        }

        if (changes.Count != deltas.Count) throw Conflict();
        var laterEdits = new Dictionary<(string Kind, string Id), Delta>();
        for (var i = 0; i < changes.Count; ++i)
        {
            var undo = JsonSerializer.SerializeToElement(changes[i], LedgerJson.Options);
            var key = Key(undo);
            if (!deltas.TryGetValue(key, out var original) ||
                !original.IsInverse(undo.GetProperty("before"), undo.GetProperty("after")) ||
                changes[i].BaseVersion != current[i].Version ||
                !LedgerValueQueryResultDto.SameValue(changes[i].Before, current[i].Value))
                throw Conflict();
            if (current[i].Version != original.OperationId) laterEdits.Add(key, original);
        }

        if (laterEdits.Count > 0)
        {
            // Pull coalesces intermediate edits. Check published versions too, so a manual edit
            // followed by a return to the same amount/status still retains its ownership.
            var since = laterEdits.Values.Min(o => o.Cursor);
            var ids = laterEdits.Keys.Select(k => k.Id).Distinct().ToArray();
            var batches = db.Batches.FromSql($"""
                SELECT * FROM smw_changes WHERE "LedgerId"={ledgerId} AND "Cursor">{since}
                AND EXISTS (SELECT 1 FROM jsonb_array_elements("Records") e WHERE e->>'id' = ANY({ids}))
                """).AsNoTracking().AsAsyncEnumerable();
            await foreach (var batch in batches.WithCancellation(ct))
                foreach (var record in JsonElement.Parse(batch.Records).EnumerateArray())
                    if (laterEdits.TryGetValue(Key(record), out var delta) && batch.Cursor > delta.Cursor &&
                        !delta.StillOwns(record.GetProperty("value"))) throw Conflict();
        }

        var platforms = changes.Where(c => c.Kind == SyncRecordKind.Platform && c.After is null).Select(c => c.Id).ToArray();
        var removedEntries = changes.Where(c => c.Kind == SyncRecordKind.Entry && c.After is null).Select(c => c.Id).ToArray();
        var series = changes.Where(c => c.After is null).Select(c => c.Before).OfType<BillEntryQueryResultDto>()
            .Select(e => e.InstallmentId).OfType<string>().Distinct().ToArray();
        if ((platforms.Length > 0 || series.Length > 0) && await db.Records.AnyAsync(r => r.LedgerId == ledgerId &&
            !removedEntries.Contains(r.Id) && (r.PlatformId != null && platforms.Contains(r.PlatformId) ||
            r.InstallmentId != null && series.Contains(r.InstallmentId)), ct))
            throw Conflict();
    }

    private static (string Kind, string Id) Key(JsonElement record) =>
        (record.GetProperty("kind").GetString()!, record.GetProperty("id").GetString()!);

    private sealed class Delta(string operationId, long cursor, JsonElement before, JsonElement after)
    {
        internal string OperationId { get; } = operationId;
        internal long Cursor { get; } = cursor;
        private readonly bool fields = before.ValueKind == JsonValueKind.Object && after.ValueKind == JsonValueKind.Object;

        private static JsonElement Field(JsonElement obj, string key) => obj.TryGetProperty(key, out var value) ? value : default;
        private static bool Same(JsonElement a, JsonElement b) =>
            a.ValueKind == b.ValueKind && (a.ValueKind == JsonValueKind.Undefined || JsonElement.DeepEquals(a, b));
        private static IEnumerable<string> Keys(JsonElement obj) => obj.EnumerateObject().Select(p => p.Name);
        private bool Changed(string key) => !Same(Field(before, key), Field(after, key));

        internal bool StillOwns(JsonElement value) => fields
            ? value.ValueKind == JsonValueKind.Object && Keys(before).Union(Keys(after)).Where(Changed)
                .All(key => Same(Field(value, key), Field(after, key)))
            : Same(value, after);

        internal bool IsInverse(JsonElement current, JsonElement proposed)
        {
            if (!StillOwns(current)) return false;
            if (!fields) return Same(proposed, before);
            if (proposed.ValueKind != JsonValueKind.Object) return false;
            return Keys(before).Union(Keys(after)).Union(Keys(current)).Union(Keys(proposed))
                .All(key => Same(Field(proposed, key), Field(Changed(key) ? before : current, key)));
        }
    }
}

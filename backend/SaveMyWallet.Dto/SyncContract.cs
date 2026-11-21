using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace SaveMyWallet.Dto;

public record SyncRecord(string Kind, string Id, JsonNode? Value, string? Version);
public record SyncChange(
    string Kind, string Id,
    [property: JsonRequired] string? BaseVersion,
    [property: JsonRequired] JsonNode? Before,
    [property: JsonRequired] JsonNode? After);
public record SyncOperation(string OperationId, IReadOnlyList<SyncChange> Changes, bool Seed = false);
public record BootstrapResult(string LedgerId, long Cursor, IReadOnlyList<SyncRecord> Records);
public record PullResult(string LedgerId, long Cursor, IReadOnlyList<SyncRecord> Records, bool HasMore);
public record PushResult(string OperationId, long Cursor, IReadOnlyList<SyncRecord> Records, IReadOnlyList<string> ChangedIds);

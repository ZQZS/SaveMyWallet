using System.Text.Json.Nodes;

namespace SaveMyWallet.Dto;

public record RestMutation(IReadOnlyList<SyncChange> Changes, JsonNode? Response);

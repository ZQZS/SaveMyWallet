using System.Text.Json.Nodes;
using SaveMyWallet.Api.Dto;

namespace SaveMyWallet.Api.Core;

public record RestMutation(IReadOnlyList<SyncChange> Changes, JsonNode? Response);

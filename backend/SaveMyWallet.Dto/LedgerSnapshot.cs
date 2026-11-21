using System.Text.Json.Nodes;

namespace SaveMyWallet.Dto;

public sealed record LedgerSnapshot(
    IReadOnlyList<JsonNode> Platforms,
    IReadOnlyList<JsonNode> Entries,
    LedgerSettings Settings,
    IReadOnlyDictionary<string, JsonNode> SalaryOverrides);

public sealed record LedgerSettings(JsonNode DefaultSalaryCents, JsonNode WarningFloorCents);

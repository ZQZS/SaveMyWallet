using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.Features;
using SaveMyWallet.Api.Core;
using SaveMyWallet.Api.Dto;
using SaveMyWallet.Api.Interfaces;
using SaveMyWallet.Api.Middleware;

namespace SaveMyWallet.Api.Endpoints;

public static class LedgerEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/ledger", async (HttpContext ctx, ISyncStore store, CancellationToken ct) =>
        {
            var snapshot = await store.BootstrapAsync(LedgerAccess.Id(ctx), ct);
            var rows = snapshot.Records.Where(r => r.Value is not null).ToList();
            var settings = rows.Where(r => r.Kind == "setting").ToDictionary(r => r.Id, r => r.Value);
            return Results.Ok(new
            {
                platforms = rows.Where(r => r.Kind == "platform").Select(r => r.Value),
                entries = rows.Where(r => r.Kind == "entry").Select(r => r.Value),
                settings = new
                {
                    defaultSalaryCents = settings.GetValueOrDefault(LedgerRules.DefaultSalary) ?? JsonValue.Create(0),
                    warningFloorCents = settings.GetValueOrDefault(LedgerRules.WarningFloor) ?? JsonValue.Create(0)
                },
                salaryOverrides = rows.Where(r => r.Kind == "override").ToDictionary(r => r.Id, r => r.Value)
            });
        });
        app.MapPost("/platforms", (HttpContext ctx, ISyncStore store, NewPlatform input, CancellationToken ct) =>
            Write(ctx, store, "POST /platforms", input, rows => LedgerCommands.CreatePlatform(rows, input), ct));
        app.MapPost("/bills", (HttpContext ctx, ISyncStore store, NewBill input, CancellationToken ct) =>
            Write(ctx, store, "POST /bills", input, _ => LedgerCommands.CreateBill(input), ct));
        app.MapPost("/bills/batch", (HttpContext ctx, ISyncStore store, NewBill?[] inputs, CancellationToken ct) =>
            Write(ctx, store, "POST /bills/batch", inputs, _ => LedgerCommands.CreateBills(inputs), ct));
        app.MapPost("/bills/{id}/confirm", (HttpContext ctx, ISyncStore store, string id, Confirmation input, CancellationToken ct) =>
        {
            id = BillId(ctx, id);
            return Write(ctx, store, "POST /bills/confirm", new { id, input }, rows => LedgerCommands.Confirm(rows, id, input), ct);
        });
        app.MapPut("/bills/{id}/voided", (HttpContext ctx, ISyncStore store, string id, BillValidity input, CancellationToken ct) =>
        {
            id = BillId(ctx, id);
            return Write(ctx, store, "PUT /bills/voided", new { id, input }, rows => LedgerCommands.SetVoided(rows, id, input.Voided), ct);
        });
        app.MapPut("/bills/{id}/installment/voided", (HttpContext ctx, ISyncStore store, string id, BillValidity input, CancellationToken ct) =>
        {
            id = BillId(ctx, id, 2);
            return Write(ctx, store, "PUT /bills/installment/voided", new { id, input },
                rows => LedgerCommands.SetInstallmentVoided(rows, id, input.Voided), ct);
        });
        app.MapPatch("/payments", (HttpContext ctx, ISyncStore store, Payment input, CancellationToken ct) =>
            Write(ctx, store, "PATCH /payments", input, rows => LedgerCommands.Pay(rows, input), ct));
        app.MapPut("/budget", (HttpContext ctx, ISyncStore store, Budget input, CancellationToken ct) =>
            Write(ctx, store, "PUT /budget", input, rows => LedgerCommands.SaveBudget(rows, input), ct));
    }

    private static string BillId(HttpContext ctx, string routeId, int trailingSegments = 1)
    {
        // Kestrel preserves escaped slashes. Axios percent-encodes the entire backup entry ID.
        var components = ctx.Features.Get<IHttpRequestFeature>()?.RawTarget.Split('?', 2)[0].TrimEnd('/').Split('/');
        return components is not null && components.Length >= trailingSegments + 2
            ? Uri.UnescapeDataString(components[^(trailingSegments + 1)]) : routeId;
    }

    private static async Task<IResult> Write<T>(HttpContext ctx, ISyncStore store, string action, T input,
            Func<IReadOnlyList<SyncRecord>, RestMutation> build, CancellationToken ct)
    {
        var operationId = Guid.NewGuid().ToString("N");
        if (ctx.Request.Headers.TryGetValue("Idempotency-Key", out var keys))
        {
            LedgerRules.Require(keys.Count == 1 && !string.IsNullOrWhiteSpace(keys[0]),
                                "invalid_operation_id", "Supply one nonempty Idempotency-Key.");
            operationId = keys[0]!;
        }
        var fingerprint = Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new { action, input })));
        var result = await store.ExecuteRestAsync(LedgerAccess.Id(ctx), operationId, fingerprint, build, ct);
        return result is null ? Results.NoContent() : Results.Json(result);
    }
}

using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.Features;
using SaveMyWallet.Api.Middleware;
using SaveMyWallet.Core;
using SaveMyWallet.Dto;
using SaveMyWallet.Interfaces;

namespace SaveMyWallet.Api.Endpoints;

public static class LedgerEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/ledger", (HttpContext ctx, ILedgerService service, CancellationToken ct) =>
            service.GetLedgerAsync(LedgerAccess.Id(ctx), ct));
        app.MapPost("/platforms", (HttpContext ctx, ILedgerService service, NewPlatform input, CancellationToken ct) =>
            WriteResult(service.CreatePlatformAsync(LedgerAccess.Id(ctx), OperationId(ctx), input, ct)));
        app.MapPost("/bills", (HttpContext ctx, ILedgerService service, NewBill input, CancellationToken ct) =>
            WriteResult(service.CreateBillAsync(LedgerAccess.Id(ctx), OperationId(ctx), input, ct)));
        app.MapPost("/bills/batch", (HttpContext ctx, ILedgerService service, NewBill?[] inputs, CancellationToken ct) =>
            WriteResult(service.CreateBillsAsync(LedgerAccess.Id(ctx), OperationId(ctx), inputs, ct)));
        app.MapPost("/bills/{id}/confirm", (HttpContext ctx, ILedgerService service, string id, Confirmation input, CancellationToken ct) =>
            WriteResult(service.ConfirmAsync(LedgerAccess.Id(ctx), OperationId(ctx), BillId(ctx, id), input, ct)));
        app.MapPut("/bills/{id}/voided", (HttpContext ctx, ILedgerService service, string id, BillValidity input, CancellationToken ct) =>
            WriteResult(service.SetVoidedAsync(LedgerAccess.Id(ctx), OperationId(ctx), BillId(ctx, id), input, ct)));
        app.MapPut("/bills/{id}/installment/voided", (HttpContext ctx, ILedgerService service, string id, BillValidity input, CancellationToken ct) =>
            WriteResult(service.SetInstallmentVoidedAsync(LedgerAccess.Id(ctx), OperationId(ctx), BillId(ctx, id, 2), input, ct)));
        app.MapPatch("/payments", (HttpContext ctx, ILedgerService service, Payment input, CancellationToken ct) =>
            WriteResult(service.PayAsync(LedgerAccess.Id(ctx), OperationId(ctx), input, ct)));
        app.MapPut("/budget", (HttpContext ctx, ILedgerService service, Budget input, CancellationToken ct) =>
            WriteResult(service.SaveBudgetAsync(LedgerAccess.Id(ctx), OperationId(ctx), input, ct)));
    }

    private static string BillId(HttpContext ctx, string routeId, int trailingSegments = 1)
    {
        // Kestrel preserves escaped slashes. Axios percent-encodes the entire backup entry ID.
        var components = ctx.Features.Get<IHttpRequestFeature>()?.RawTarget.Split('?', 2)[0].TrimEnd('/').Split('/');
        return components is not null && components.Length >= trailingSegments + 2
            ? Uri.UnescapeDataString(components[^(trailingSegments + 1)]) : routeId;
    }

    private static string OperationId(HttpContext ctx)
    {
        if (!ctx.Request.Headers.TryGetValue("Idempotency-Key", out var keys)) return Guid.NewGuid().ToString("N");
        if (keys.Count != 1 || string.IsNullOrWhiteSpace(keys[0]))
            throw new LedgerException(400, "invalid_operation_id", "Supply one nonempty Idempotency-Key.");
        return keys[0]!;
    }

    private static async Task<IResult> WriteResult(Task<JsonNode?> operation)
    {
        var result = await operation;
        return result is null ? Results.NoContent() : Results.Json(result);
    }
}

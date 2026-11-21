using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Http.HttpResults;
using SaveMyWallet.Api.Middleware;
using SaveMyWallet.Core;
using SaveMyWallet.Dto.QueryDto;
using SaveMyWallet.Interfaces;

namespace SaveMyWallet.Api.Endpoints;

public static class LedgerEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/ledger", (HttpContext ctx, ILedgerService service, CancellationToken ct) =>
            service.GetLedgerAsync(LedgerAccess.Id(ctx), ct));
        app.MapPost("/platforms", (HttpContext ctx, ILedgerService service, NewPlatformQueryDto input, CancellationToken ct) =>
            service.CreatePlatformAsync(LedgerAccess.Id(ctx), OperationId(ctx), input, ct));
        app.MapPost("/bills", (HttpContext ctx, ILedgerService service, NewBillQueryDto input, CancellationToken ct) =>
            NoContentAsync(service.CreateBillAsync(LedgerAccess.Id(ctx), OperationId(ctx), input, ct)));
        app.MapPost("/bills/batch", (HttpContext ctx, ILedgerService service, NewBillQueryDto?[] inputs, CancellationToken ct) =>
            NoContentAsync(service.CreateBillsAsync(LedgerAccess.Id(ctx), OperationId(ctx), inputs, ct)));
        app.MapPost("/bills/{id}/confirm", (HttpContext ctx, ILedgerService service, string id, ConfirmationQueryDto input, CancellationToken ct) =>
            NoContentAsync(service.ConfirmAsync(LedgerAccess.Id(ctx), OperationId(ctx), BillId(ctx, id), input, ct)));
        app.MapPut("/bills/voided", (HttpContext ctx, ILedgerService service, VoidBillsQueryDto input, CancellationToken ct) =>
            service.VoidBillsAsync(LedgerAccess.Id(ctx), OperationId(ctx), input, ct));
        app.MapPut("/bills/{id}/voided", (HttpContext ctx, ILedgerService service, string id, BillValidityQueryDto input, CancellationToken ct) =>
            NoContentAsync(service.SetVoidedAsync(LedgerAccess.Id(ctx), OperationId(ctx), BillId(ctx, id), input, ct)));
        app.MapPut("/bills/{id}/installment/voided", (HttpContext ctx, ILedgerService service, string id, BillValidityQueryDto input, CancellationToken ct) =>
            service.SetInstallmentVoidedAsync(LedgerAccess.Id(ctx), OperationId(ctx), BillId(ctx, id, 2), input, ct));
        app.MapPatch("/payments", (HttpContext ctx, ILedgerService service, PaymentQueryDto input, CancellationToken ct) =>
            service.PayAsync(LedgerAccess.Id(ctx), OperationId(ctx), input, ct));
        app.MapPut("/budget", (HttpContext ctx, ILedgerService service, BudgetQueryDto input, CancellationToken ct) =>
            NoContentAsync(service.SaveBudgetAsync(LedgerAccess.Id(ctx), OperationId(ctx), input, ct)));
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

    private static async Task<NoContent> NoContentAsync(Task operation)
    {
        await operation;
        return TypedResults.NoContent();
    }
}

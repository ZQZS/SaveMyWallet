using SaveMyWallet.Api.Middleware;
using SaveMyWallet.Dto.QueryDto;
using SaveMyWallet.Interfaces;

namespace SaveMyWallet.Api.Endpoints;

internal static class SyncEndpoints
{
    internal static void Map(WebApplication app)
    {
        app.MapGet("/sync/bootstrap", (HttpContext ctx, ISyncService service, CancellationToken ct) =>
            service.BootstrapAsync(LedgerAccess.Id(ctx), ct));
        app.MapGet("/sync/pull", (long cursor, HttpContext ctx, ISyncService service, CancellationToken ct) =>
            service.PullAsync(LedgerAccess.Id(ctx), cursor, ct));
        app.MapPost("/sync/push", (SyncOperationQueryDto operation, HttpContext ctx, ISyncService service, CancellationToken ct) =>
            service.PushAsync(LedgerAccess.Id(ctx), operation, ct));
        app.MapPost("/sync/revert", (RevertOperationQueryDto operation, HttpContext ctx, ISyncService service, CancellationToken ct) =>
            service.RevertAsync(LedgerAccess.Id(ctx), operation, ct));
    }
}

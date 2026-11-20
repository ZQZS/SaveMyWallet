using SaveMyWallet.Api.Dto;
using SaveMyWallet.Api.Interfaces;
using SaveMyWallet.Api.Middleware;

namespace SaveMyWallet.Api.Endpoints;

internal static class SyncEndpoints
{
    internal static void Map(WebApplication app)
    {
        app.MapGet("/sync/bootstrap", (HttpContext ctx, ISyncStore store, CancellationToken ct) =>
            store.BootstrapAsync(LedgerAccess.Id(ctx), ct));
        app.MapGet("/sync/pull", (long cursor, HttpContext ctx, ISyncStore store, CancellationToken ct) =>
            store.PullAsync(LedgerAccess.Id(ctx), cursor, ct));
        app.MapPost("/sync/push", (SyncOperation operation, HttpContext ctx, ISyncStore store, CancellationToken ct) =>
            store.PushAsync(LedgerAccess.Id(ctx), operation, ct));
    }
}

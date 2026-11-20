using SaveMyWallet.Api.Core;

namespace SaveMyWallet.Api.Middleware;

internal static class LedgerErrorMiddleware
{
    internal static async Task InvokeAsync(HttpContext context, RequestDelegate next)
    {
        try
        {
            context.Response.Headers.CacheControl = "no-store";
            await next(context);
        }
        catch (SyncConflict conflict)
        {
            context.Response.StatusCode = conflict.Status;
            await context.Response.WriteAsJsonAsync(new { conflict.Code, conflict.Cursor, conflict.Records });
        }
        catch (LedgerException error)
        {
            context.Response.StatusCode = error.Status;
            await context.Response.WriteAsJsonAsync(new { error.Code, error.Message });
        }
    }
}

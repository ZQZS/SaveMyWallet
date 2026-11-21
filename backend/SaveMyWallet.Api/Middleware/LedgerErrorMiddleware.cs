using SaveMyWallet.Core;
using SaveMyWallet.Dto.QueryResultDto;

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
            var records = conflict.Records.Select(SyncRecordResults.FromEntity).ToArray();
            await context.Response.WriteAsJsonAsync(new SyncConflictQueryResultDto(conflict.Code, conflict.Cursor, records));
        }
        catch (LedgerException error)
        {
            context.Response.StatusCode = error.Status;
            await context.Response.WriteAsJsonAsync(new LedgerErrorQueryResultDto(error.Code, error.Message));
        }
    }
}

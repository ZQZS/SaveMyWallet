using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using SaveMyWallet.Core;

namespace SaveMyWallet.Api.Middleware;

internal sealed class LedgerAccess
{
    private static readonly object ItemKey = new();
    private readonly (string Id, byte[] Hash)[] tokens;

    internal LedgerAccess(IConfiguration config)
    {
        var entries = config.GetSection("LedgerTokens").GetChildren().ToArray();
        if (entries.Length == 0) throw new InvalidOperationException("Configure LedgerTokens__<ledgerId> before starting the API.");
        tokens = entries.Select(section =>
        {
            var token = section.Value;
            if (!LedgerRules.IsSafeKey(section.Key, 80) || token is not { Length: >= 32 and <= 1024 } || token.Any(c => c is < '!' or > '~'))
                throw new InvalidOperationException("A ledger identifier or access token is invalid.");
            return (section.Key, SHA256.HashData(Encoding.ASCII.GetBytes(token)));
        }).ToArray();
        if (tokens.Select(t => Convert.ToHexString(t.Hash)).Distinct().Count() != tokens.Length)
            throw new InvalidOperationException("Each ledger requires a distinct access token.");
    }

    public static string Id(HttpContext context) => (string)context.Items[ItemKey]!;

    internal async Task Authorize(HttpContext context, RequestDelegate next)
    {
        if (!AuthenticationHeaderValue.TryParse(context.Request.Headers.Authorization, out var header)
            || !header.Scheme.Equals("Bearer", StringComparison.OrdinalIgnoreCase)
            || header.Parameter is not { Length: >= 32 and <= 1024 } token)
        {
            await Reject(context);
            return;
        }
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(token));
        var matched = tokens.FirstOrDefault(t => CryptographicOperations.FixedTimeEquals(hash, t.Hash));
        if (matched.Id is null)
        {
            await Reject(context);
            return;
        }
        if (context.Request.Headers.TryGetValue("X-Ledger-Id", out var expected)
            && (expected.Count != 1 || expected[0] != matched.Id))
        {
            context.Response.StatusCode = 409;
            await context.Response.WriteAsJsonAsync(new { code = "ledger_mismatch" });
            return;
        }
        context.Items[ItemKey] = matched.Id;
        await next(context);
    }

    private static Task Reject(HttpContext context)
    {
        context.Response.StatusCode = 401;
        context.Response.Headers.WWWAuthenticate = "Bearer";
        return context.Response.WriteAsJsonAsync(new { code = "unauthorized" });
    }
}

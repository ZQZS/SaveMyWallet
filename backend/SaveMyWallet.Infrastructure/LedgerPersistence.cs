using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using SaveMyWallet.Infrastructure.Persistence;
using SaveMyWallet.Interfaces;

namespace SaveMyWallet.Infrastructure;

public static class LedgerPersistence
{
    public static void AddLedgerPersistence(this IServiceCollection services, string connectionString)
    {
        services.AddDbContext<LedgerDb>(options => options.UseNpgsql(connectionString));
        services.AddScoped<ISyncStore, SyncStore>();
    }

    public static async Task InitializeLedgerDatabaseAsync(this IServiceProvider services)
    {
        await using var scope = services.CreateAsyncScope();
        await Schema.ApplyAsync(scope.ServiceProvider.GetRequiredService<LedgerDb>());
    }
}

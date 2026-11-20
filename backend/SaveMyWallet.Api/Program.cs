using Microsoft.EntityFrameworkCore;
using SaveMyWallet.Api.Endpoints;
using SaveMyWallet.Api.Infrastructure.Persistence;
using SaveMyWallet.Api.Interfaces;
using SaveMyWallet.Api.Middleware;

var builder = WebApplication.CreateBuilder(args);
var connectionString = builder.Configuration.GetConnectionString("Ledger")
    ?? throw new InvalidOperationException("Set ConnectionStrings__Ledger to a PostgreSQL connection string.");
var access = new LedgerAccess(builder.Configuration);
builder.Services.AddDbContext<LedgerDb>(options => options.UseNpgsql(connectionString));
builder.Services.ConfigureHttpJsonOptions(options => options.SerializerOptions.AllowDuplicateProperties = false);
builder.Services.AddScoped<ISyncStore, SyncStore>();
var origins = builder.Configuration.GetSection("Cors:Origins").Get<string[]>() ?? [];
if (origins.Length > 0)
    builder.Services.AddCors(options => options.AddDefaultPolicy(policy =>
        policy.WithOrigins(origins).AllowAnyMethod().AllowAnyHeader()));

var app = builder.Build();
await using (var scope = app.Services.CreateAsyncScope())
    await Schema.ApplyAsync(scope.ServiceProvider.GetRequiredService<LedgerDb>());

if (origins.Length > 0) app.UseCors();
app.Use(access.Authorize);
app.Use(LedgerErrorMiddleware.InvokeAsync);
LedgerEndpoints.Map(app);
SyncEndpoints.Map(app);
await app.RunAsync();

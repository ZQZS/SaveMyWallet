using SaveMyWallet.Api.Endpoints;
using SaveMyWallet.Api.Middleware;
using SaveMyWallet.Infrastructure;
using SaveMyWallet.Interfaces;
using SaveMyWallet.Services;

var builder = WebApplication.CreateBuilder(args);
var connectionString = builder.Configuration.GetConnectionString("Ledger")
    ?? throw new InvalidOperationException("Set ConnectionStrings__Ledger to a PostgreSQL connection string.");
var access = new LedgerAccess(builder.Configuration);
builder.Services.AddLedgerPersistence(connectionString);
builder.Services.AddScoped<ILedgerService, LedgerService>();
builder.Services.AddScoped<ISyncService, SyncService>();
builder.Services.ConfigureHttpJsonOptions(options => options.SerializerOptions.AllowDuplicateProperties = false);
var origins = builder.Configuration.GetSection("Cors:Origins").Get<string[]>() ?? [];
if (origins.Length > 0)
    builder.Services.AddCors(options => options.AddDefaultPolicy(policy =>
        policy.WithOrigins(origins).AllowAnyMethod().AllowAnyHeader()));

var app = builder.Build();
await app.Services.InitializeLedgerDatabaseAsync();

if (origins.Length > 0) app.UseCors();
app.Use(access.Authorize);
app.Use(LedgerErrorMiddleware.InvokeAsync);
LedgerEndpoints.Map(app);
SyncEndpoints.Map(app);
await app.RunAsync();

using Microsoft.EntityFrameworkCore;

namespace SaveMyWallet.Api.Infrastructure.Persistence;

internal static class Schema
{
    // Keep each published DDL step immutable. Run new steps in version order under this transaction lock.
    internal static async Task ApplyAsync(LedgerDb db)
    {
        await using var tx = await db.Database.BeginTransactionAsync();
        await db.Database.ExecuteSqlRawAsync("""
            SELECT pg_advisory_xact_lock(5138104721196);
            CREATE TABLE IF NOT EXISTS smw_schema (version integer PRIMARY KEY);
            """);
        var version = await db.Database.SqlQueryRaw<int>("SELECT COALESCE(max(version),0) AS \"Value\" FROM smw_schema").SingleAsync();
        if (version > 1) throw new InvalidOperationException("Upgrade SaveMyWallet.Api to open this database.");
        if (version == 0)
        {
            await db.Database.ExecuteSqlRawAsync("""
                CREATE TABLE smw_ledgers (
                    "LedgerId" text PRIMARY KEY, "Cursor" bigint NOT NULL CHECK ("Cursor" >= 0));
                CREATE TABLE smw_records (
                    "LedgerId" text NOT NULL REFERENCES smw_ledgers, "Kind" text NOT NULL, "Id" text NOT NULL,
                    "Value" jsonb, "Version" text NOT NULL, PRIMARY KEY ("LedgerId", "Kind", "Id"));
                CREATE TABLE smw_changes (
                    "LedgerId" text NOT NULL REFERENCES smw_ledgers, "Cursor" bigint NOT NULL,
                    "Records" jsonb NOT NULL, PRIMARY KEY ("LedgerId", "Cursor"));
                CREATE TABLE smw_receipts (
                    "LedgerId" text NOT NULL REFERENCES smw_ledgers, "OperationId" text NOT NULL,
                    "Request" jsonb NOT NULL, "Response" jsonb NOT NULL, PRIMARY KEY ("LedgerId", "OperationId"));
                INSERT INTO smw_schema VALUES (1);
                """);
        }
        await tx.CommitAsync();
    }
}

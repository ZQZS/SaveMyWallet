using Microsoft.EntityFrameworkCore;

namespace SaveMyWallet.Infrastructure.Persistence;

internal static class Schema
{
    private const int CurrentVersion = 2;

    internal static async Task ApplyAsync(LedgerDb db)
    {
        await using var tx = await db.Database.BeginTransactionAsync();
        await db.Database.ExecuteSqlRawAsync("""
            SELECT pg_advisory_xact_lock(5138104721196);
            CREATE TABLE IF NOT EXISTS smw_schema (version integer PRIMARY KEY);
            """);
        var version = await db.Database.SqlQueryRaw<int?>("""SELECT max(version) AS "Value" FROM smw_schema""").SingleAsync();
        if (version.HasValue && version != CurrentVersion)
            throw new InvalidOperationException($"Database schema {version} is incompatible with this API (expected {CurrentVersion}). Configure a new, empty database.");
        if (version is null)
        {
            await db.Database.ExecuteSqlRawAsync("""
                CREATE TABLE smw_ledgers (
                    "LedgerId" text PRIMARY KEY, "Cursor" bigint NOT NULL CHECK ("Cursor" >= 0));
                CREATE TABLE smw_records (
                    "LedgerId" text NOT NULL REFERENCES smw_ledgers,
                    "Kind" text NOT NULL CHECK ("Kind" IN ('platform','entry','setting','override')),
                    "Id" text NOT NULL CHECK (octet_length("Id") BETWEEN 1 AND 1024),
                    "Version" text NOT NULL,
                    "PlatformName" text,
                    "PlatformId" text,
                    "Title" text,
                    "BillMonth" date,
                    "BillKind" text,
                    "BillStatus" text,
                    "AmountCents" bigint CHECK ("AmountCents" BETWEEN 0 AND 99999999900),
                    "InstallmentIndex" integer,
                    "InstallmentCount" integer,
                    "InstallmentId" text,
                    "DepositCents" bigint CHECK ("DepositCents" BETWEEN 1 AND 99999999900),
                    "IsVoided" boolean,
                    "PlatformRecordKind" text GENERATED ALWAYS AS (
                        CASE WHEN "PlatformId" IS NOT NULL THEN 'platform'::text END) STORED,
                    "PlatformNameKey" text COLLATE "C" GENERATED ALWAYS AS (
                        translate("PlatformName",'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')) STORED,
                    PRIMARY KEY ("LedgerId", "Kind", "Id"),
                    CONSTRAINT smw_records_platform_ref FOREIGN KEY ("LedgerId", "PlatformRecordKind", "PlatformId")
                        REFERENCES smw_records ("LedgerId", "Kind", "Id") DEFERRABLE INITIALLY DEFERRED,
                    CONSTRAINT smw_records_platform_name UNIQUE ("LedgerId", "PlatformNameKey") DEFERRABLE INITIALLY DEFERRED,
                    CONSTRAINT smw_records_name CHECK (
                        ("Kind" = 'platform') = ("PlatformName" IS NOT NULL) AND
                        char_length("PlatformName") BETWEEN 1 AND 40),
                    CONSTRAINT smw_records_entry_fields CHECK (
                        CASE WHEN "Kind" = 'entry' THEN
                            "PlatformId" IS NOT NULL AND "Title" IS NOT NULL AND "BillMonth" IS NOT NULL AND
                            "BillKind" IS NOT NULL AND "BillStatus" IS NOT NULL AND "IsVoided" IS NOT NULL
                        ELSE ROW("PlatformId","Title","BillMonth","BillKind","BillStatus","IsVoided",
                                 "InstallmentId","InstallmentIndex","InstallmentCount","DepositCents") IS NULL END),
                    CONSTRAINT smw_records_amount CHECK (
                        CASE "Kind" WHEN 'platform' THEN "AmountCents" IS NULL
                                    WHEN 'override' THEN true ELSE "AmountCents" IS NOT NULL END),
                    CONSTRAINT smw_records_budget_id CHECK (
                        CASE "Kind" WHEN 'setting' THEN "Id" IN ('defaultSalaryCents','warningFloorCents')
                                    WHEN 'override' THEN "Id" ~ '^(19|20)[0-9][0-9]-(0[1-9]|1[0-2])$' ELSE true END),
                    CONSTRAINT smw_records_bill CHECK ("Kind" <> 'entry' OR (
                        char_length("Title") BETWEEN 1 AND 120 AND
                        "BillMonth" BETWEEN DATE '1900-01-01' AND DATE '2099-12-01' AND EXTRACT(DAY FROM "BillMonth") = 1 AND
                        "BillKind" IN ('single','installment','estimate') AND "BillStatus" IN ('due','paid','estimated') AND
                        ("BillStatus" <> 'estimated' OR "BillKind" = 'estimate') AND
                        ("DepositCents" IS NULL OR "BillKind" = 'estimate') AND
                        "AmountCents" + COALESCE("DepositCents", 0) BETWEEN 1 AND 99999999900 AND
                        ("AmountCents" > 0 OR ("BillKind" = 'estimate' AND "BillStatus" <> 'due')))),
                    CONSTRAINT smw_records_period CHECK (
                        CASE WHEN "BillKind" = 'installment' THEN
                            "InstallmentId" IS NOT NULL AND length("InstallmentId") = 32 AND "InstallmentId" ~ '^[0-9a-f]+$' AND
                            "InstallmentCount" IS NOT NULL AND "InstallmentCount" BETWEEN 1 AND 120 AND
                            "InstallmentIndex" IS NOT NULL AND "InstallmentIndex" BETWEEN 1 AND "InstallmentCount"
                        ELSE ROW("InstallmentId","InstallmentIndex","InstallmentCount") IS NULL END)
                );
                CREATE UNIQUE INDEX smw_records_installment_period ON smw_records ("LedgerId","InstallmentId","InstallmentIndex")
                    WHERE "InstallmentId" IS NOT NULL;
                CREATE TABLE smw_changes (
                    "LedgerId" text NOT NULL REFERENCES smw_ledgers, "Cursor" bigint NOT NULL,
                    "Records" jsonb NOT NULL, PRIMARY KEY ("LedgerId", "Cursor"));
                CREATE TABLE smw_receipts (
                    "LedgerId" text NOT NULL REFERENCES smw_ledgers, "OperationId" text NOT NULL,
                    "Request" jsonb NOT NULL, "Response" jsonb NOT NULL, PRIMARY KEY ("LedgerId", "OperationId"));
                INSERT INTO smw_schema VALUES (2);
                """);
        }
        await tx.CommitAsync();
    }
}

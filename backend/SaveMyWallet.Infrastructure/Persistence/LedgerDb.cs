using Microsoft.EntityFrameworkCore;

namespace SaveMyWallet.Infrastructure.Persistence;

internal sealed class LedgerDb(DbContextOptions<LedgerDb> options) : DbContext(options)
{
    public DbSet<LedgerHead> Ledgers => Set<LedgerHead>();
    public DbSet<StoredRecord> Records => Set<StoredRecord>();
    public DbSet<ChangeBatch> Batches => Set<ChangeBatch>();
    public DbSet<Receipt> Receipts => Set<Receipt>();

    protected override void OnModelCreating(ModelBuilder model)
    {
        var ledgers = model.Entity<LedgerHead>().ToTable("smw_ledgers");
        ledgers.HasKey(x => x.LedgerId);
        var records = model.Entity<StoredRecord>().ToTable("smw_records");
        records.HasKey(x => new { x.LedgerId, x.Kind, x.Id });
        records.Property(x => x.Value).HasColumnType("jsonb");
        var batches = model.Entity<ChangeBatch>().ToTable("smw_changes");
        batches.HasKey(x => new { x.LedgerId, x.Cursor });
        batches.Property(x => x.Records).HasColumnType("jsonb");
        var receipts = model.Entity<Receipt>().ToTable("smw_receipts");
        receipts.HasKey(x => new { x.LedgerId, x.OperationId });
        receipts.Property(x => x.Request).HasColumnType("jsonb");
        receipts.Property(x => x.Response).HasColumnType("jsonb");
    }
}

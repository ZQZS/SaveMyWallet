using Microsoft.EntityFrameworkCore;
using SaveMyWallet.Dto.EntityDto;

namespace SaveMyWallet.Infrastructure.Persistence;

internal sealed class LedgerDb(DbContextOptions<LedgerDb> options) : DbContext(options)
{
    public DbSet<LedgerHeadEntityDto> Ledgers => Set<LedgerHeadEntityDto>();
    public DbSet<StoredRecordEntityDto> Records => Set<StoredRecordEntityDto>();
    public DbSet<ChangeBatchEntityDto> Batches => Set<ChangeBatchEntityDto>();
    public DbSet<ReceiptEntityDto> Receipts => Set<ReceiptEntityDto>();

    protected override void OnModelCreating(ModelBuilder model)
    {
        var ledgers = model.Entity<LedgerHeadEntityDto>().ToTable("smw_ledgers");
        ledgers.HasKey(x => x.LedgerId);
        var records = model.Entity<StoredRecordEntityDto>().ToTable("smw_records");
        records.HasKey(x => new { x.LedgerId, x.Kind, x.Id });
        records.Property(x => x.Value).HasColumnType("jsonb");
        var batches = model.Entity<ChangeBatchEntityDto>().ToTable("smw_changes");
        batches.HasKey(x => new { x.LedgerId, x.Cursor });
        batches.Property(x => x.Records).HasColumnType("jsonb");
        var receipts = model.Entity<ReceiptEntityDto>().ToTable("smw_receipts");
        receipts.HasKey(x => new { x.LedgerId, x.OperationId });
        receipts.Property(x => x.Request).HasColumnType("jsonb");
        receipts.Property(x => x.Response).HasColumnType("jsonb");
    }
}

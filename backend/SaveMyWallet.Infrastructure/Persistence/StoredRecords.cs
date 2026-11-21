using System.Globalization;
using SaveMyWallet.Dto;
using SaveMyWallet.Dto.EntityDto;
using SaveMyWallet.Dto.QueryResultDto;

namespace SaveMyWallet.Infrastructure.Persistence;

internal static class StoredRecords
{
    internal static SyncRecordEntityDto ToRecord(StoredRecordEntityDto row)
    {
        LedgerValueQueryResultDto? value = row.Kind switch
        {
            SyncRecordKind.Platform => new PlatformQueryResultDto(row.Id, row.PlatformName!),
            SyncRecordKind.Entry => new BillEntryQueryResultDto
            {
                Id = row.Id,
                PlatformId = row.PlatformId!,
                Title = row.Title!,
                Month = row.BillMonth!.Value.ToString("yyyy-MM", CultureInfo.InvariantCulture),
                Kind = row.BillKind!.Value,
                Status = row.BillStatus!.Value,
                AmountCents = row.AmountCents!.Value,
                InstallmentId = row.InstallmentId,
                InstallmentIndex = row.InstallmentIndex,
                InstallmentCount = row.InstallmentCount,
                DepositCents = row.DepositCents,
                Voided = row.IsVoided!.Value ? true : null
            },
            SyncRecordKind.Setting => new AmountQueryResultDto(row.AmountCents!.Value),
            SyncRecordKind.Override => row.AmountCents is long cents ? new AmountQueryResultDto(cents) : null,
            _ => throw new InvalidOperationException($"Unknown stored record kind {row.Kind}.")
        };
        return new SyncRecordEntityDto(row.Kind, row.Id, value, row.Version);
    }

    internal static void Apply(StoredRecordEntityDto row, LedgerValueQueryResultDto? value)
    {
        switch (row.Kind, value)
        {
            case (SyncRecordKind.Platform, PlatformQueryResultDto platform):
                row.PlatformName = platform.Name;
                break;
            case (SyncRecordKind.Entry, BillEntryQueryResultDto bill):
                row.PlatformId = bill.PlatformId;
                row.Title = bill.Title;
                row.BillMonth = DateOnly.ParseExact(bill.Month + "-01", "yyyy-MM-dd", CultureInfo.InvariantCulture);
                row.BillKind = bill.Kind;
                row.BillStatus = bill.Status;
                row.AmountCents = bill.AmountCents;
                row.InstallmentId = bill.InstallmentId;
                row.InstallmentIndex = bill.InstallmentIndex;
                row.InstallmentCount = bill.InstallmentCount;
                row.DepositCents = bill.DepositCents;
                row.IsVoided = bill.Voided == true;
                break;
            case (SyncRecordKind.Setting or SyncRecordKind.Override, AmountQueryResultDto amount):
                row.AmountCents = amount.Cents;
                break;
            case (SyncRecordKind.Override, null):
                row.AmountCents = null;
                break;
            default:
                throw new InvalidOperationException($"Invalid value for stored record kind {row.Kind}.");
        }
    }
}

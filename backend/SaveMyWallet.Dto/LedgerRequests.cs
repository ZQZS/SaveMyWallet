using System.Text.Json.Serialization;

namespace SaveMyWallet.Dto;

public sealed record NewPlatform([property: JsonRequired] string Name);

[JsonNumberHandling(JsonNumberHandling.Strict)]
public sealed record NewBill([property: JsonRequired] string PlatformId, [property: JsonRequired] string Title,
    [property: JsonRequired] string Month, [property: JsonRequired] long AmountCents,
    [property: JsonRequired] string Kind, [property: JsonRequired] uint InstallmentCount,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] long? TotalCents = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] long? DepositCents = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? InstallmentIndex = null);

[JsonNumberHandling(JsonNumberHandling.Strict)]
public sealed record Confirmation([property: JsonRequired] string Title, [property: JsonRequired] string Month,
    [property: JsonRequired] long AmountCents,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] long? TotalCents = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] long? DepositCents = null);

public sealed record Payment([property: JsonRequired] string[] Ids, [property: JsonRequired] bool Paid);

public sealed record BillValidity([property: JsonRequired] bool Voided);

[JsonNumberHandling(JsonNumberHandling.Strict)]
public sealed record Budget([property: JsonRequired] string Month, [property: JsonRequired] long DefaultSalaryCents,
    [property: JsonRequired] long WarningFloorCents, [property: JsonRequired] long? OverrideSalaryCents);

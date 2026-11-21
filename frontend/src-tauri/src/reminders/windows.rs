mod calendar;

use super::{now_millis, ReminderRecurrence, DELIVERY, PERMISSION, TIME};
use chrono::{DateTime, Local, SecondsFormat};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::{env, fs, path::PathBuf, time::Duration};
use tauri::utils::config::{AppDirectoriesOverride, Config};
use windows::{
    core::{BSTR, HSTRING},
    Data::Xml::Dom::XmlDocument,
    Win32::{
        Foundation::{
            ERROR_FILE_NOT_FOUND, ERROR_NOT_FOUND, ERROR_PATH_NOT_FOUND, RPC_E_CHANGED_MODE,
        },
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_MULTITHREADED,
            },
            TaskScheduler::{
                ITaskFolder, ITaskService, TaskScheduler, TASK_CREATE_OR_UPDATE,
                TASK_LOGON_INTERACTIVE_TOKEN,
            },
            Variant::VARIANT,
        },
    },
    UI::Notifications::{
        NotificationSetting, ToastNotification, ToastNotificationManager, ToastNotifier,
    },
};
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

const DELIVERY_ARG: &str = "--deliver-pet-reminder";
const CATCH_UP_SECONDS: i64 = 7 * 86400;
const DATABASE_FILE: &str = "reminder-delivery.sqlite3";

// The helper runs without a Tauri app or WebView. Resolve the same local directory in both paths.
fn data_dir(config: &Config) -> Result<PathBuf, String> {
    let configured = match &config.app.app_directories_override {
        Some(AppDirectoriesOverride::Root(root)) => Some(root.clone()),
        Some(AppDirectoriesOverride::Directories(dirs)) => dirs.local_data.clone(),
        None => None,
    };
    configured
        .or_else(|| dirs::data_local_dir().map(|path| path.join(&config.identifier)))
        .ok_or_else(|| DELIVERY.into())
}

fn database(config: &Config) -> Result<Connection, String> {
    let dir = data_dir(config)?;
    fs::create_dir_all(&dir).map_err(|_| DELIVERY)?;
    let db = Connection::open(dir.join(DATABASE_FILE)).map_err(|_| DELIVERY)?;
    db.busy_timeout(Duration::from_secs(10))
        .map_err(|_| DELIVERY)?;
    init_delivery_db(&db)?;
    Ok(db)
}

fn init_delivery_db(db: &Connection) -> Result<(), String> {
    // Older one-shot schedules have a pending row and no registration metadata.
    db.execute_batch("PRAGMA secure_delete = ON;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS pending (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS registrations (
            id INTEGER PRIMARY KEY REFERENCES pending(id) ON DELETE CASCADE,
            token INTEGER NOT NULL, rule TEXT, first_day INTEGER, last_day INTEGER
        )").map_err(|_| DELIVERY)?;
    db.execute(
        "DELETE FROM pending WHERE at < ?1 AND NOT EXISTS
            (SELECT 1 FROM registrations WHERE registrations.id = pending.id AND rule IS NOT NULL)",
        [now_millis() - CATCH_UP_SECONDS * 1000],
    )
    .map_err(|_| DELIVERY)?;
    Ok(())
}

pub(crate) fn purge_expired(config: &Config) {
    if data_dir(config).is_ok_and(|dir| dir.join(DATABASE_FILE).is_file()) {
        let _ = database(config);
    }
}

fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

struct Apartment(bool);

fn os_error(operation: &'static str) -> impl FnOnce(windows::core::Error) -> &'static str {
    move |error| {
        eprintln!("Windows pet reminder {operation}: {:?}", error.code());
        DELIVERY
    }
}
impl Apartment {
    fn enter() -> Result<Self, String> {
        // Tauri's worker may already be in a COM apartment. Only uninitialize our own reference.
        let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if result == RPC_E_CHANGED_MODE {
            return Ok(Self(false));
        }
        result.ok().map_err(os_error("initialize COM"))?;
        Ok(Self(true))
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

fn notifier(config: &Config) -> Result<ToastNotifier, String> {
    // Give the unpackaged Win32 application its own per-user notification identity.
    let key = format!(r"Software\Classes\AppUserModelId\{}", config.identifier);
    let (identity, _) = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(key)
        .map_err(|_| DELIVERY)?;
    identity
        .set_value(
            "DisplayName",
            &config.product_name.as_deref().unwrap_or("SaveMyWallet"),
        )
        .map_err(|_| DELIVERY)?;
    let notifier =
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(&config.identifier))
            .map_err(os_error("create notifier"))?;
    match notifier.Setting() {
        Ok(NotificationSetting::Enabled) => (),
        Ok(_) => return Err(PERMISSION.into()),
        // Windows 10 can have no settings entry before this identity's first toast.
        // Show still posts under our own identity and applies the system's notification settings.
        Err(error) if error.code() == ERROR_NOT_FOUND.to_hresult() => (),
        Err(error) => return Err(os_error("read notification setting")(error).into()),
    }
    Ok(notifier)
}

pub(super) fn notify(config: &Config, id: i32, title: &str, body: &str) -> Result<(), String> {
    let _apartment = Apartment::enter()?;
    let notifier = notifier(config)?;
    let xml = format!(
        r#"<toast><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text></binding></visual></toast>"#,
        escape_xml(title),
        escape_xml(body)
    );
    let doc = XmlDocument::new().map_err(os_error("create notification document"))?;
    doc.LoadXml(&HSTRING::from(xml))
        .map_err(os_error("load notification document"))?;
    let toast = ToastNotification::CreateToastNotification(&doc)
        .map_err(os_error("create notification"))?;
    toast
        .SetTag(&HSTRING::from(id.to_string()))
        .map_err(os_error("set notification tag"))?;
    notifier
        .Show(&toast)
        .map_err(os_error("show notification"))?;
    Ok(())
}

fn task_folder() -> Result<ITaskFolder, String> {
    let empty = VARIANT::default();
    // The caller holds a COM apartment; empty credentials select the current local user.
    unsafe {
        let service: ITaskService = CoCreateInstance(&TaskScheduler, None, CLSCTX_INPROC_SERVER)
            .map_err(os_error("create scheduler"))?;
        service
            .Connect(&empty, &empty, &empty, &empty)
            .map_err(os_error("connect scheduler"))?;
        service
            .GetFolder(&BSTR::from("\\"))
            .map_err(|error| os_error("open task folder")(error).to_owned())
    }
}

fn task_name(config: &Config, id: i32) -> Result<BSTR, String> {
    // Task Scheduler has a machine-wide namespace. Include the user's installation directory.
    let hash = data_dir(config)?
        .to_string_lossy()
        .bytes()
        .fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
        });
    Ok(BSTR::from(format!(
        "{}-PetReminder-{hash:016x}-{id}",
        config.identifier
    )))
}

fn one_time_trigger(at: i64) -> Result<String, String> {
    let secs = at.div_euclid(1000) + i64::from(at.rem_euclid(1000) != 0);
    let boundary = |seconds| {
        DateTime::from_timestamp(seconds, 0)
            .map(|t| t.to_rfc3339_opts(SecondsFormat::Secs, true))
            .ok_or_else(|| TIME.to_owned())
    };
    let start = boundary(secs)?;
    let end = boundary(secs + CATCH_UP_SECONDS)?;
    Ok(format!("<TimeTrigger><StartBoundary>{start}</StartBoundary><EndBoundary>{end}</EndBoundary></TimeTrigger>"))
}

fn task_xml(id: i32, at: i64, token: i64, exe: &str, trigger: &str, recurring: bool) -> String {
    let exe = escape_xml(exe);
    let expiry = if recurring {
        ""
    } else {
        "<DeleteExpiredTaskAfter>PT0S</DeleteExpiredTaskAfter>"
    };
    format!(
        r#"<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<Triggers>{trigger}</Triggers>
<Principals><Principal id="User"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable>{expiry}<ExecutionTimeLimit>PT2M</ExecutionTimeLimit></Settings>
<Actions Context="User"><Exec><Command>{exe}</Command><Arguments>{DELIVERY_ARG} {id} {at} {token}</Arguments></Exec></Actions></Task>"#
    )
}

fn task_missing(error: &windows::core::Error) -> bool {
    [
        ERROR_FILE_NOT_FOUND.to_hresult(),
        ERROR_PATH_NOT_FOUND.to_hresult(),
    ]
    .contains(&error.code())
}

fn current_task(folder: &ITaskFolder, name: &BSTR) -> Result<Option<BSTR>, String> {
    unsafe {
        match folder.GetTask(name) {
            Ok(task) => task
                .Xml()
                .map(Some)
                .map_err(|error| os_error("read prior task")(error).into()),
            Err(error) if task_missing(&error) => Ok(None),
            Err(error) => Err(os_error("find prior task")(error).into()),
        }
    }
}

fn set_task(folder: &ITaskFolder, name: &BSTR, xml: Option<&BSTR>) -> Result<(), String> {
    if let Some(xml) = xml {
        let empty = VARIANT::default();
        unsafe {
            folder.RegisterTask(
                name,
                xml,
                TASK_CREATE_OR_UPDATE.0,
                &empty,
                &empty,
                TASK_LOGON_INTERACTIVE_TOKEN,
                &empty,
            )
        }
        .map_err(os_error("register task"))?;
    } else if let Err(error) = unsafe { folder.DeleteTask(name, 0) } {
        if !task_missing(&error) {
            return Err(os_error("remove task")(error).into());
        }
    }
    Ok(())
}

fn commit_schedule(
    tx: Transaction<'_>,
    folder: &ITaskFolder,
    name: &BSTR,
    replacement: Option<&BSTR>,
) -> Result<(), String> {
    // Keep the previous trigger available for rollback if SQLite cannot commit the OS change.
    let previous = current_task(folder, name)?;
    set_task(folder, name, replacement)?;
    if tx.commit().is_err() {
        set_task(folder, name, previous.as_ref())?;
        return Err(DELIVERY.into());
    }
    Ok(())
}

pub(super) fn schedule(
    config: &Config,
    id: i32,
    at: i64,
    title: &str,
    body: &str,
    rule: Option<&ReminderRecurrence>,
) -> Result<(), String> {
    let _apartment = Apartment::enter()?;
    notifier(config)?;
    let folder = task_folder()?;
    let name = task_name(config, id)?;
    let exe = env::current_exe().map_err(|_| DELIVERY)?;
    let (trigger, first_day) = match rule {
        Some(rule) => {
            let (trigger, first) = rule.trigger(at)?;
            (trigger, Some(first))
        }
        None => (one_time_trigger(at)?, None),
    };
    let mut db = database(config)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| DELIVERY)?;
    tx.execute(
        "INSERT OR REPLACE INTO pending (id, at, title, body) VALUES (?1, ?2, ?3, ?4)",
        params![id, at, title, body],
    )
    .map_err(|_| DELIVERY)?;
    let rule_json = rule
        .map(serde_json::to_string)
        .transpose()
        .map_err(|_| TIME)?;
    let token: i64 = tx
        .query_row(
            "INSERT INTO registrations (id, token, rule, first_day)
         VALUES (?1, abs(random()) | 1, ?2, ?3) RETURNING token",
            params![id, rule_json, first_day],
            |r| r.get(0),
        )
        .map_err(|_| DELIVERY)?;
    let xml = BSTR::from(task_xml(
        id,
        at,
        token,
        exe.to_str().ok_or(DELIVERY)?,
        &trigger,
        rule.is_some(),
    ));
    commit_schedule(tx, &folder, &name, Some(&xml))
}

pub(super) fn cancel(config: &Config, id: i32) -> Result<(), String> {
    let _apartment = Apartment::enter()?;
    let folder = task_folder()?;
    let name = task_name(config, id)?;
    let mut db = database(config)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| DELIVERY)?;
    tx.execute("DELETE FROM pending WHERE id = ?1", [id])
        .map_err(|_| DELIVERY)?;
    commit_schedule(tx, &folder, &name, None)
}

#[derive(Default)]
struct DeliveryPlan {
    message: Option<(String, String)>,
    next_window: Option<DateTime<Local>>,
}

fn claim_delivery(
    tx: &Transaction<'_>,
    id: i32,
    at: i64,
    token: Option<i64>,
    now: DateTime<Local>,
) -> Result<DeliveryPlan, String> {
    let row = tx
        .query_row(
            "SELECT title, body, rule, first_day, last_day FROM pending p
             LEFT JOIN registrations r USING(id) WHERE p.id = ?1 AND p.at = ?2 AND r.token IS ?3",
            params![id, at, token],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|_| DELIVERY)?;
    let Some((title, body, rule, first_day, last_day)) = row else {
        return Ok(DeliveryPlan::default());
    };
    let mut plan = DeliveryPlan::default();
    if let Some(rule) = rule {
        let rule: ReminderRecurrence = serde_json::from_str(&rule).map_err(|_| DELIVERY)?;
        let first = first_day.ok_or(DELIVERY)?;
        let slot = rule.latest_slot(now, first)?;
        let unseen = slot.filter(|slot| last_day.is_none_or(|last| *slot > last));
        if let Some(window) = rule.window()? {
            // The launch boundary remains local when travelling. After sleep, an outdated
            // boundary may land before today's draw or after the window. Rearm in both cases.
            let minimum = unseen
                .or(last_day)
                .map_or(first, |last| first.max(last.saturating_add(1)));
            plan.next_window = Some(window.next(&now, minimum)?);
        }
        let Some(slot) = unseen else {
            return Ok(plan);
        };
        tx.execute(
            "UPDATE registrations SET last_day = ?1 WHERE id = ?2",
            params![slot, id],
        )
        .map_err(|_| DELIVERY)?;
    } else {
        if at > now.timestamp_millis() {
            return Err(TIME.into());
        }
        tx.execute("DELETE FROM pending WHERE id = ?1", [id])
            .map_err(|_| DELIVERY)?;
    }
    plan.message = Some((title, body));
    Ok(plan)
}

fn rearm_window(
    config: &Config,
    id: i32,
    at: i64,
    token: i64,
    next: DateTime<Local>,
) -> Result<(), String> {
    let _apartment = Apartment::enter()?;
    // Keep the interface in a local: Rust 2021 tail-expression temporaries can outlive
    // the apartment guard and call IUnknown::Release after CoUninitialize.
    let folder = task_folder()?;
    let name = task_name(config, id)?;
    let exe = env::current_exe().map_err(|_| DELIVERY)?;
    let trigger = calendar::window_trigger(next);
    let xml = BSTR::from(task_xml(
        id,
        at,
        token,
        exe.to_str().ok_or(DELIVERY)?,
        &trigger,
        true,
    ));
    set_task(&folder, &name, Some(&xml))
}

fn deliver_pending(config: &Config, id: i32, at: i64, token: Option<i64>) -> Result<(), String> {
    let mut db = database(config)?;
    // Hold the same lock used for edits and cancellation through the OS handoff.
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| DELIVERY)?;
    let plan = claim_delivery(&tx, id, at, token, Local::now())?;
    let rearmed = match plan.next_window {
        Some(next) => rearm_window(config, id, at, token.ok_or(DELIVERY)?, next),
        None => Ok(()),
    };
    let delivered = match plan.message {
        Some((title, body)) => notify(config, id, &title, &body),
        None => Ok(()),
    };
    tx.commit().map_err(|_| DELIVERY)?;
    delivered.and(rearmed)
}

fn parse_helper_args(
    mut args: impl Iterator<Item = String>,
) -> Option<Result<(i32, i64, Option<i64>), String>> {
    if args.next().as_deref() != Some(DELIVERY_ARG) {
        return None;
    }
    let pair = args
        .next()
        .and_then(|s| s.parse::<i32>().ok())
        .zip(args.next().and_then(|s| s.parse::<i64>().ok()));
    // Legacy one-shot triggers installed by 0.6.1 supply only the ID and deadline.
    let token = args.next().map(|s| s.parse::<i64>());
    Some(
        pair.and_then(|(id, at)| Some((id, at, token.transpose().ok()?)))
            .filter(|(id, at, token)| {
                *id > 0 && *at > 0 && token.is_none_or(|n| n > 0) && args.next().is_none()
            })
            .ok_or_else(|| DELIVERY.into()),
    )
}

pub(crate) fn deliver_from_args(config: &Config) -> Option<Result<(), String>> {
    parse_helper_args(env::args().skip(1))
        .map(|args| args.and_then(|(id, at, token)| deliver_pending(config, id, at, token)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Datelike, TimeZone};
    #[test]
    fn task_runs_only_the_executable_with_numeric_arguments() {
        let at = 1_900_000_000_123;
        let xml = task_xml(
            42,
            at,
            11,
            r"C:\A&B\<pet>\app.exe",
            &one_time_trigger(at).unwrap(),
            false,
        );
        assert!(xml.contains(r"<Command>C:\A&amp;B\&lt;pet&gt;\app.exe</Command>"));
        assert!(xml.contains("<Arguments>--deliver-pet-reminder 42 1900000000123 11</Arguments>"));
        assert!(xml.contains("2030-03-17T17:46:41Z"));
    }
    #[test]
    fn malformed_helper_mode_never_opens_a_window() {
        let parse = |text: &str| parse_helper_args(text.split_whitespace().map(str::to_owned));
        assert!(parse("").is_none());
        assert_eq!(
            parse("--deliver-pet-reminder 3 42").unwrap().unwrap(),
            (3, 42, None)
        );
        assert!(parse("--deliver-pet-reminder 3 bad").unwrap().is_err());
        assert!(parse("--deliver-pet-reminder 3 42 extra").unwrap().is_err());
    }

    #[test]
    fn registrations_keep_future_cycles_and_reject_old_helpers_after_edit_or_cancel() {
        let mut db = Connection::open_in_memory().unwrap();
        init_delivery_db(&db).unwrap();
        let start = Local.with_ymd_and_hms(2026, 1, 10, 9, 0, 0).unwrap();
        let at = start.timestamp_millis();
        db.execute(
            "INSERT INTO pending VALUES (1, ?1, 'pet', 'repayment')",
            [at],
        )
        .unwrap();
        db.execute(
            "INSERT INTO registrations VALUES (1, 123, ?1, ?2, NULL)",
            params![
                r#"{"frequency":"monthly","dayOfMonth":10,"time":"09:00"}"#,
                start.date_naive().num_days_from_ce()
            ],
        )
        .unwrap();
        init_delivery_db(&db).unwrap(); // An old first occurrence does not expire a recurring registration.
        let tx = db.transaction().unwrap();
        let later = Local.with_ymd_and_hms(2026, 3, 20, 20, 0, 0).unwrap();
        let claim = |token, clock| claim_delivery(&tx, 1, at, token, clock).unwrap().message;
        assert!(claim(None, later).is_none());
        assert!(claim(Some(123), later).is_some());
        assert!(claim(Some(123), later).is_none());
        assert!(claim(
            Some(123),
            Local.with_ymd_and_hms(2026, 4, 10, 9, 0, 0).unwrap()
        )
        .is_some());
        tx.execute("UPDATE registrations SET token = 124 WHERE id = 1", [])
            .unwrap();
        assert!(claim(Some(123), later).is_none());
        tx.execute("DELETE FROM pending WHERE id = 1", []).unwrap();
        assert!(claim(Some(124), later).is_none());
        // A pre-upgrade one-time task still works with its original numeric arguments.
        tx.execute("INSERT INTO pending VALUES (1, ?1, 'pet', 'legacy')", [at])
            .unwrap();
        assert!(claim(Some(123), later).is_none());
        assert_eq!(claim(None, later).unwrap().1, "legacy");
        assert!(claim(None, later).is_none());
    }

    #[test]
    fn window_helpers_rearm_after_missed_days_and_keep_stale_edits_and_cancelled_ids_inert() {
        let mut db = Connection::open_in_memory().unwrap();
        init_delivery_db(&db).unwrap();
        let local = |day, h, m| Local.with_ymd_and_hms(2026, 11, day, h, m, 0).unwrap();
        let first = local(22, 23, 55);
        let at = first.timestamp_millis();
        let slot = first.date_naive().num_days_from_ce();
        db.execute("INSERT INTO pending VALUES (1,?1,'pet','sleep')", [at])
            .unwrap();
        db.execute(
            "INSERT INTO registrations VALUES (1,7,?1,?2,NULL)",
            params![
                r#"{"frequency":"randomWindow","startTime":"23:00","endTime":"01:00","seed":42}"#,
                slot
            ],
        )
        .unwrap();
        let tx = db.transaction().unwrap();
        let claim = |token, now| claim_delivery(&tx, 1, at, Some(token), now).unwrap();
        let first_plan = claim(7, first);
        assert!(first_plan.message.is_some());
        assert_eq!(first_plan.next_window, Some(local(24, 0, 44)));
        assert!(claim(7, local(23, 0, 15)).message.is_none());
        let missed = claim(7, local(24, 15, 0));
        assert!(missed.message.is_none());
        assert!(missed.next_window.unwrap() > local(24, 15, 0));
        tx.execute("UPDATE registrations SET token=8 WHERE id=1", [])
            .unwrap();
        assert!(claim(7, local(24, 15, 0)).next_window.is_none());
        tx.execute("DELETE FROM pending WHERE id=1", []).unwrap();
        assert!(claim(8, local(24, 15, 0)).next_window.is_none());
    }

    #[test]
    #[ignore = "creates and cleans up one temporary Windows Task Scheduler registration"]
    fn failed_database_commit_restores_the_actual_windows_calendar_task() {
        let _com = Apartment::enter().unwrap();
        let folder = task_folder().unwrap();
        let probe = tempfile::Builder::new()
            .prefix("SMW-Repeat-QA-")
            .tempdir()
            .unwrap();
        let mut config = Config {
            identifier: "SMW-Repeat-QA".into(),
            ..Config::default()
        };
        config.app.app_directories_override =
            Some(AppDirectoriesOverride::Root(probe.path().into()));
        let name = task_name(&config, 1).unwrap();
        assert!(current_task(&folder, &name).unwrap().is_none());
        struct Cleanup<'a>(&'a ITaskFolder, &'a BSTR);
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                let _ = set_task(self.0, self.1, None);
            }
        }
        let _cleanup = Cleanup(&folder, &name);
        let first = Local.with_ymd_and_hms(2099, 4, 10, 9, 0, 0).unwrap();
        let exe = env::current_exe().unwrap();
        let at = first.timestamp_millis();
        let rule_xml = |rule: ReminderRecurrence, token| {
            let trigger = rule.trigger(at).unwrap().0;
            BSTR::from(task_xml(
                1,
                at,
                token,
                exe.to_str().unwrap(),
                &trigger,
                true,
            ))
        };
        let daily = rule_xml(
            ReminderRecurrence::Daily {
                time: "09:00".into(),
            },
            111,
        );
        let monthly = rule_xml(
            ReminderRecurrence::Monthly {
                time: "09:00".into(),
                day_of_month: 10,
            },
            222,
        );
        let weekly = rule_xml(
            ReminderRecurrence::Weekly {
                time: "09:00".into(),
                weekday: first.weekday().number_from_monday() as u8,
            },
            333,
        );
        let interval = rule_xml(
            ReminderRecurrence::Interval {
                minutes: 20,
                anchor_at: at,
            },
            444,
        );
        let window = ReminderRecurrence::RandomWindow {
            start_time: "11:30".into(),
            end_time: "13:00".into(),
            seed: 42,
        };
        let next = window
            .window()
            .unwrap()
            .unwrap()
            .next(&first, i64::MIN)
            .unwrap();
        let (trigger, _) = window.trigger(next.timestamp_millis()).unwrap();
        let random = BSTR::from(task_xml(
            1,
            next.timestamp_millis(),
            555,
            exe.to_str().unwrap(),
            &trigger,
            true,
        ));
        let mut db = Connection::open_in_memory().unwrap();
        init_delivery_db(&db).unwrap();
        db.execute("CREATE TABLE bad_parent (id INTEGER REFERENCES pending(id) DEFERRABLE INITIALLY DEFERRED)", []).unwrap();
        let fail_commit = |db: &mut Connection, replacement: Option<&BSTR>| {
            let tx = db.transaction().unwrap();
            tx.execute("INSERT INTO bad_parent VALUES(42)", []).unwrap();
            assert!(commit_schedule(tx, &folder, &name, replacement).is_err());
        };
        fail_commit(&mut db, Some(&daily));
        assert!(current_task(&folder, &name).unwrap().is_none());
        set_task(&folder, &name, Some(&daily)).unwrap();
        set_task(&folder, &name, Some(&monthly)).unwrap();
        set_task(&folder, &name, Some(&interval)).unwrap();
        assert!(current_task(&folder, &name)
            .unwrap()
            .unwrap()
            .to_string()
            .contains("<Interval>PT20M</Interval>"));
        set_task(&folder, &name, Some(&random)).unwrap();
        assert!(current_task(&folder, &name)
            .unwrap()
            .unwrap()
            .to_string()
            .contains("555</Arguments>"));
        // A standalone helper starts without a COM apartment. Exercise its full
        // initialization, task update and interface cleanup on a fresh OS thread.
        std::thread::spawn(move || rearm_window(&config, 1, at, 777, next))
            .join()
            .unwrap()
            .unwrap();
        assert!(current_task(&folder, &name)
            .unwrap()
            .unwrap()
            .to_string()
            .contains("777</Arguments>"));
        set_task(&folder, &name, Some(&weekly)).unwrap();
        fail_commit(&mut db, Some(&monthly));
        assert!(current_task(&folder, &name)
            .unwrap()
            .unwrap()
            .to_string()
            .contains("333</Arguments>"));
        fail_commit(&mut db, None);
        assert!(current_task(&folder, &name)
            .unwrap()
            .unwrap()
            .to_string()
            .contains("333</Arguments>"));
        set_task(&folder, &name, None).unwrap();
        assert!(current_task(&folder, &name).unwrap().is_none());
    }
}

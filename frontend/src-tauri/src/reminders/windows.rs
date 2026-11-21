use super::{now_millis, DELIVERY, PERMISSION, TIME};
use chrono::{DateTime, SecondsFormat};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
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
    db.execute_batch("PRAGMA secure_delete = ON;
        CREATE TABLE IF NOT EXISTS pending (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL)").map_err(|_| DELIVERY)?;
    db.execute(
        "DELETE FROM pending WHERE at < ?1",
        [now_millis() - CATCH_UP_SECONDS * 1000],
    )
    .map_err(|_| DELIVERY)?;
    Ok(db)
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

fn task_xml(id: i32, at: i64, exe: &str) -> Result<String, String> {
    let secs = at.div_euclid(1000) + i64::from(at.rem_euclid(1000) != 0);
    let boundary = |seconds| {
        DateTime::from_timestamp(seconds, 0)
            .map(|t| t.to_rfc3339_opts(SecondsFormat::Secs, true))
            .ok_or_else(|| TIME.to_owned())
    };
    let start = boundary(secs)?;
    let end = boundary(secs + CATCH_UP_SECONDS)?;
    let exe = escape_xml(exe);
    Ok(format!(
        r#"<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<Triggers><TimeTrigger><StartBoundary>{start}</StartBoundary><EndBoundary>{end}</EndBoundary></TimeTrigger></Triggers>
<Principals><Principal id="User"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><DeleteExpiredTaskAfter>PT0S</DeleteExpiredTaskAfter><ExecutionTimeLimit>PT2M</ExecutionTimeLimit></Settings>
<Actions Context="User"><Exec><Command>{exe}</Command><Arguments>{DELIVERY_ARG} {id} {at}</Arguments></Exec></Actions></Task>"#
    ))
}

pub(super) fn schedule(
    config: &Config,
    id: i32,
    at: i64,
    title: &str,
    body: &str,
) -> Result<(), String> {
    let _apartment = Apartment::enter()?;
    notifier(config)?;
    let folder = task_folder()?;
    let name = task_name(config, id)?;
    let exe = env::current_exe().map_err(|_| DELIVERY)?;
    let xml = BSTR::from(task_xml(id, at, exe.to_str().ok_or(DELIVERY)?)?);
    let mut db = database(config)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| DELIVERY)?;
    tx.execute(
        "INSERT OR REPLACE INTO pending (id, at, title, body) VALUES (?1, ?2, ?3, ?4)",
        params![id, at, title, body],
    )
    .map_err(|_| DELIVERY)?;
    let empty = VARIANT::default();
    unsafe {
        folder.RegisterTask(
            &name,
            &xml,
            TASK_CREATE_OR_UPDATE.0,
            &empty,
            &empty,
            TASK_LOGON_INTERACTIVE_TOKEN,
            &empty,
        )
    }
    .map_err(os_error("register task"))?;
    tx.commit().map_err(|_| DELIVERY.into())
}

pub(super) fn cancel(config: &Config, id: i32) -> Result<(), String> {
    let _apartment = Apartment::enter()?;
    let folder = task_folder()?;
    let name = task_name(config, id)?;
    let mut db = database(config)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| DELIVERY)?;
    if let Err(error) = unsafe { folder.DeleteTask(&name, 0) } {
        if ![
            ERROR_FILE_NOT_FOUND.to_hresult(),
            ERROR_PATH_NOT_FOUND.to_hresult(),
        ]
        .contains(&error.code())
        {
            return Err(DELIVERY.into());
        }
    }
    tx.execute("DELETE FROM pending WHERE id = ?1", [id])
        .map_err(|_| DELIVERY)?;
    tx.commit().map_err(|_| DELIVERY.into())
}

fn deliver_pending(config: &Config, id: i32, at: i64) -> Result<(), String> {
    if id <= 0 || at > now_millis() {
        return Err(TIME.into());
    }
    let mut db = database(config)?;
    // Serialize cancellation, replacement and repeated OS launches, even across processes.
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| DELIVERY)?;
    let row: Option<(String, String)> = tx
        .query_row(
            "SELECT title, body FROM pending WHERE id = ?1 AND at = ?2",
            params![id, at],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|_| DELIVERY)?;
    let mut delivered = Ok(());
    if let Some((title, body)) = row {
        delivered = notify(config, id, &title, &body);
        tx.execute(
            "DELETE FROM pending WHERE id = ?1 AND at = ?2",
            params![id, at],
        )
        .map_err(|_| DELIVERY)?;
    }
    tx.commit().map_err(|_| DELIVERY)?;
    delivered
}

fn parse_helper_args(mut args: impl Iterator<Item = String>) -> Option<Result<(i32, i64), String>> {
    if args.next().as_deref() != Some(DELIVERY_ARG) {
        return None;
    }
    let pair = args
        .next()
        .and_then(|s| s.parse::<i32>().ok())
        .zip(args.next().and_then(|s| s.parse::<i64>().ok()));
    Some(
        pair.filter(|(id, at)| *id > 0 && *at > 0 && args.next().is_none())
            .ok_or_else(|| DELIVERY.into()),
    )
}

pub(crate) fn deliver_from_args(config: &Config) -> Option<Result<(), String>> {
    parse_helper_args(env::args().skip(1))
        .map(|args| args.and_then(|(id, at)| deliver_pending(config, id, at)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn task_runs_only_the_executable_with_numeric_arguments() {
        let xml = task_xml(42, 1_900_000_000_123, r"C:\A&B\<pet>\app.exe").unwrap();
        assert!(xml.contains(r"<Command>C:\A&amp;B\&lt;pet&gt;\app.exe</Command>"));
        assert!(xml.contains("<Arguments>--deliver-pet-reminder 42 1900000000123</Arguments>"));
        assert!(xml.contains("2030-03-17T17:46:41Z"));
    }
    #[test]
    fn malformed_helper_mode_never_opens_a_window() {
        let parse = |text: &str| parse_helper_args(text.split_whitespace().map(str::to_owned));
        assert!(parse("").is_none());
        assert_eq!(
            parse("--deliver-pet-reminder 3 42").unwrap().unwrap(),
            (3, 42)
        );
        assert!(parse("--deliver-pet-reminder 3 bad").unwrap().is_err());
        assert!(parse("--deliver-pet-reminder 3 42 extra").unwrap().is_err());
    }
}

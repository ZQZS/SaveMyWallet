mod ai;
mod backup_files;
mod ledger;
mod reminders;
mod sync_client;

use ledger::review::{LedgerWrite, ReviewedLedger};
use ledger::{BillInput, BudgetInput, ConfirmInput, Ledger, StorageResult};
use rusqlite::Connection;
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{Manager, State};

struct Database {
    directory: PathBuf,
    connection: Mutex<Option<Connection>>,
}

impl Database {
    fn access<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> StorageResult<T>,
    ) -> Result<T, String> {
        let mut storage = self
            .connection
            .lock()
            .map_err(|_| "账本连接已中断，请重新打开应用。")?;
        // Opening on first access lets a failed migration or disk read surface in the ledger.
        if storage.is_none() {
            fs::create_dir_all(&self.directory).map_err(|e| format!("无法创建账本目录：{e}"))?;
            let mut conn = Connection::open(self.directory.join("ledger.sqlite3"))
                .map_err(|e| format!("无法打开本地账本：{e}"))?;
            ledger::migrate(&mut conn).map_err(|e| format!("无法载入账本：{e}"))?;
            *storage = Some(conn);
        }
        let conn = storage.as_mut().ok_or("无法连接本地账本")?;
        operation(conn).map_err(|e| e.to_string())
    }

    fn access_checked<T>(
        &self,
        expected_revision: Option<&str>,
        operation: impl FnOnce(LedgerWrite<'_>) -> StorageResult<T>,
    ) -> Result<T, String> {
        self.access(|conn| operation(LedgerWrite::new(conn, expected_revision)))
    }
}

#[tauri::command(async)]
fn load_ledger(db: State<'_, Database>) -> Result<Ledger, String> {
    db.access(ledger::snapshot)
}

#[tauri::command(async)]
fn load_reviewed_ledger(db: State<'_, Database>) -> Result<ReviewedLedger, String> {
    db.access(ledger::review::snapshot)
}

#[tauri::command(async)]
fn create_platform(
    db: State<'_, Database>,
    name: String,
    expected_revision: Option<String>,
) -> Result<String, String> {
    db.access_checked(expected_revision.as_deref(), |write| {
        ledger::add_platform(write, &name)
    })
}

#[tauri::command(async)]
fn create_bill(
    db: State<'_, Database>,
    input: BillInput,
    expected_revision: Option<String>,
) -> Result<(), String> {
    db.access_checked(expected_revision.as_deref(), |write| {
        ledger::add_bill(write, input)
    })
}

#[tauri::command(async)]
fn create_bills(
    db: State<'_, Database>,
    inputs: Vec<BillInput>,
    expected_revision: Option<String>,
) -> Result<(), String> {
    db.access_checked(expected_revision.as_deref(), |write| {
        ledger::add_bills(write, &inputs)
    })
}

#[tauri::command(async)]
fn confirm_estimate(
    db: State<'_, Database>,
    input: ConfirmInput,
    expected_revision: Option<String>,
) -> Result<(), String> {
    db.access_checked(expected_revision.as_deref(), |write| {
        ledger::confirm(write, input)
    })
}

#[tauri::command(async)]
fn set_entry_voided(
    db: State<'_, Database>,
    id: String,
    voided: bool,
    expected_revision: Option<String>,
) -> Result<(), String> {
    db.access_checked(expected_revision.as_deref(), |write| {
        ledger::set_entry_voided(write, &id, voided)
    })
}

#[tauri::command(async)]
fn void_entries(
    db: State<'_, Database>,
    ids: Vec<String>,
    expected_revision: Option<String>,
) -> Result<Vec<String>, String> {
    db.access_checked(expected_revision.as_deref(), |write| {
        ledger::set_entries_voided(write, &ids, true)
    })
}

#[tauri::command(async)]
fn set_installment_voided(
    db: State<'_, Database>,
    id: String,
    voided: bool,
    expected_revision: Option<String>,
) -> Result<Vec<String>, String> {
    db.access_checked(expected_revision.as_deref(), |write| {
        ledger::set_installment_voided(write, &id, voided)
    })
}

#[tauri::command(async)]
fn set_payment(
    db: State<'_, Database>,
    ids: Vec<String>,
    paid: bool,
    expected_revision: Option<String>,
) -> Result<Vec<String>, String> {
    db.access_checked(expected_revision.as_deref(), |write| {
        ledger::mark_payment(write, &ids, paid)
    })
}

#[tauri::command(async)]
fn undo_payment(
    db: State<'_, Database>,
    ids: Vec<String>,
    paid: bool,
    expected_revision: Option<String>,
) -> Result<Vec<String>, String> {
    db.access_checked(expected_revision.as_deref(), |write| {
        ledger::undo_payment(write, &ids, paid)
    })
}

#[tauri::command(async)]
fn save_budget(
    db: State<'_, Database>,
    input: BudgetInput,
    expected_revision: Option<String>,
) -> Result<(), String> {
    db.access_checked(expected_revision.as_deref(), |write| {
        ledger::budget(write, input)
    })
}

#[tauri::command(async)]
fn export_backup(db: State<'_, Database>) -> Result<String, String> {
    db.access(ledger::backup::export)
}

#[tauri::command(async)]
fn preview_backup(contents: String) -> Result<ledger::backup::BackupPreview, String> {
    ledger::backup::preview(&contents).map_err(|error| error.to_string())
}

#[tauri::command(async)]
fn import_backup(db: State<'_, Database>, contents: String) -> Result<(), String> {
    db.access(|conn| ledger::backup::restore(conn, &contents))
}

#[tauri::command(async)]
fn reset_ledger(db: State<'_, Database>, confirmation: String) -> Result<(), String> {
    db.access(|conn| ledger::backup::reset(conn, &confirmation))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    #[cfg(windows)]
    if let Some(result) = reminders::windows::deliver_from_args(context.config()) {
        std::process::exit(if result.is_ok() { 0 } else { 1 });
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(ai::credentials::init())
        .plugin(reminders::init())
        .manage(ai::AiRequests::default())
        .manage(ai::images::SelectedImage::default())
        .setup(|app| {
            #[cfg(windows)]
            reminders::windows::purge_expired(app.config());
            app.manage(sync_client::SyncClient::default());
            app.manage(Database {
                directory: app.path().app_data_dir()?,
                connection: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            reminders::reminder_notify,
            reminders::reminder_schedule,
            reminders::reminder_cancel,
            ai::credentials::ai_key_status,
            ai::credentials::ai_save_key,
            ai::credentials::ai_remove_key,
            ai::ai_test_key,
            ai::ai_explain,
            ai::spending::ai_classify_spending,
            ai::pet_chat::ai_pet_chat,
            ai::pet_chat::agent::ai_agent_chat_turn,
            ai::pet_chat::reminder::ai_pet_reminder_line,
            ai::ai_parse_scenario,
            ai::assistant_inputs::ai_parse_notice,
            ai::assistant_inputs::ai_parse_search,
            ai::ai_recognize,
            ai::ai_cancel,
            ai::images::ai_choose_image,
            ai::images::ai_release_image,
            backup_files::choose_backup_file,
            backup_files::save_backup_file,
            load_ledger,
            load_reviewed_ledger,
            create_platform,
            create_bill,
            create_bills,
            confirm_estimate,
            set_entry_voided,
            void_entries,
            set_installment_voided,
            set_payment,
            undo_payment,
            save_budget,
            export_backup,
            preview_backup,
            import_backup,
            reset_ledger,
            sync_client::sync_status,
            sync_client::sync_preview,
            sync_client::sync_bind,
            sync_client::sync_authenticate,
            sync_client::sync_run,
            sync_client::sync_resolve,
            sync_client::sync_disconnect,
            sync_client::sync_previous_backup
        ])
        .run(context)
        .expect("无法启动 SaveMyWallet");
}

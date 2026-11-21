mod ai;
mod backup_files;
mod ledger;
mod sync_client;

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
}

#[tauri::command(async)]
fn load_ledger(db: State<'_, Database>) -> Result<Ledger, String> {
    db.access(ledger::snapshot)
}

#[tauri::command(async)]
fn create_platform(db: State<'_, Database>, name: String) -> Result<String, String> {
    db.access(|conn| ledger::add_platform(conn, &name))
}

#[tauri::command(async)]
fn create_bill(db: State<'_, Database>, input: BillInput) -> Result<(), String> {
    db.access(|conn| ledger::add_bill(conn, input))
}

#[tauri::command(async)]
fn confirm_estimate(db: State<'_, Database>, input: ConfirmInput) -> Result<(), String> {
    db.access(|conn| ledger::confirm(conn, input))
}

#[tauri::command(async)]
fn set_entry_voided(db: State<'_, Database>, id: String, voided: bool) -> Result<(), String> {
    db.access(|conn| ledger::set_entry_voided(conn, &id, voided))
}

#[tauri::command(async)]
fn set_installment_voided(
    db: State<'_, Database>,
    id: String,
    voided: bool,
) -> Result<Vec<String>, String> {
    db.access(|conn| ledger::set_installment_voided(conn, &id, voided))
}

#[tauri::command(async)]
fn set_payment(
    db: State<'_, Database>,
    ids: Vec<String>,
    paid: bool,
) -> Result<Vec<String>, String> {
    db.access(|conn| ledger::mark_payment(conn, &ids, paid))
}

#[tauri::command(async)]
fn undo_payment(
    db: State<'_, Database>,
    ids: Vec<String>,
    paid: bool,
) -> Result<Vec<String>, String> {
    db.access(|conn| ledger::undo_payment(conn, &ids, paid))
}

#[tauri::command(async)]
fn save_budget(db: State<'_, Database>, input: BudgetInput) -> Result<(), String> {
    db.access(|conn| ledger::budget(conn, input))
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
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(ai::credentials::init())
        .manage(ai::AiRequests::default())
        .manage(ai::images::SelectedImage::default())
        .setup(|app| {
            app.manage(sync_client::SyncClient::default());
            app.manage(Database {
                directory: app.path().app_data_dir()?,
                connection: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ai::credentials::ai_key_status,
            ai::credentials::ai_save_key,
            ai::credentials::ai_remove_key,
            ai::ai_test_key,
            ai::ai_explain,
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
            create_platform,
            create_bill,
            confirm_estimate,
            set_entry_voided,
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
        .run(tauri::generate_context!())
        .expect("无法启动 SaveMyWallet");
}

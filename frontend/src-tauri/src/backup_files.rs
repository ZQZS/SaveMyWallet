use serde::Serialize;
use std::io::Read;
use std::io::Write;
use tauri::WebviewWindow;
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder};
#[cfg(desktop)]
use tauri_plugin_fs::FilePath;
use tauri_plugin_fs::{FsExt, OpenOptions};

pub(crate) const MAX_BACKUP_BYTES: usize = 32 * 1024 * 1024;

#[derive(Serialize)]
pub(crate) struct SelectedBackupFile {
    name: String,
    contents: String,
}

fn picker(window: &WebviewWindow) -> FileDialogBuilder<tauri::Wry> {
    let picker = window.dialog().file().add_filter("JSON", &["json"]);
    #[cfg(desktop)]
    let picker = picker.set_parent(window);
    picker
}

fn read_contents(reader: impl Read, limit: usize) -> Result<String, &'static str> {
    // Some Android content providers expose a stream without a reliable file size.
    let mut bytes = Vec::new();
    reader
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "FILE_READ")?;
    if bytes.len() > limit {
        return Err("FILE_TOO_LARGE");
    }
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        bytes.drain(..3);
    }
    String::from_utf8(bytes).map_err(|_| "FILE_UTF8")
}

#[tauri::command(async)]
pub(crate) fn choose_backup_file(
    window: WebviewWindow,
) -> Result<Option<SelectedBackupFile>, &'static str> {
    let Some(path) = picker(&window).blocking_pick_file() else {
        return Ok(None);
    };
    // A content URI's final segment may be an opaque document ID rather than a filename.
    let name = path
        .as_path()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .unwrap_or("JSON")
        .to_owned();
    let mut options = OpenOptions::new();
    options.read(true);
    let reader = window.fs().open(path, options).map_err(|_| "FILE_READ")?;
    let contents = read_contents(reader, MAX_BACKUP_BYTES)?;
    Ok(Some(SelectedBackupFile { name, contents }))
}

#[cfg(desktop)]
fn write_selected_file(path: FilePath, contents: &[u8]) -> Result<(), &'static str> {
    let target = path.into_path().map_err(|_| "FILE_WRITE")?;
    if !target
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
    {
        return Err("FILE_EXTENSION");
    }
    let dir = target.parent().ok_or("FILE_WRITE")?;
    let mut temp = tempfile::NamedTempFile::new_in(dir).map_err(|_| "FILE_WRITE")?;
    temp.write_all(contents).map_err(|_| "FILE_WRITE")?;
    temp.as_file().sync_all().map_err(|_| "FILE_WRITE")?;
    temp.persist(&target).map_err(|_| "FILE_WRITE")?;
    Ok(())
}

#[tauri::command(async)]
pub(crate) fn save_backup_file(
    window: WebviewWindow,
    contents: String,
    file_name: String,
) -> Result<bool, &'static str> {
    if contents.len() > MAX_BACKUP_BYTES {
        return Err("FILE_TOO_LARGE");
    }
    let name = std::path::Path::new(&file_name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("SaveMyWallet.json");
    let Some(path) = picker(&window).set_file_name(name).blocking_save_file() else {
        return Ok(false);
    };
    #[cfg(desktop)]
    write_selected_file(path, contents.as_bytes())?;
    #[cfg(mobile)]
    {
        // Android ACTION_CREATE_DOCUMENT grants access to exactly the returned URI.
        let mut options = OpenOptions::new();
        options.read(false).write(true).truncate(true).create(true);
        let mut file = window.fs().open(path, options).map_err(|_| "FILE_WRITE")?;
        file.write_all(contents.as_bytes())
            .map_err(|_| "FILE_WRITE")?;
        file.flush().map_err(|_| "FILE_WRITE")?;
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_utf8_stream() {
        let original = "账单📒";
        assert_eq!(
            read_contents(original.as_bytes(), original.len()),
            Ok(original.into())
        );
        assert_eq!(
            read_contents(original.as_bytes(), original.len() - 1),
            Err("FILE_TOO_LARGE")
        );
        assert_eq!(
            read_contents([0xef, 0xbb, 0xbf, b'{', b'}'].as_slice(), 5),
            Ok("{}".into())
        );
        assert_eq!(read_contents([0xc3, 0x28].as_slice(), 2), Err("FILE_UTF8"));
    }

    #[cfg(desktop)]
    #[test]
    fn desktop_export_replaces_the_selected_json_only() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("existing.json");
        std::fs::write(&target, b"existing longer contents").unwrap();
        write_selected_file(FilePath::Path(target.clone()), b"{}").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"{}");
        let wrong = dir.path().join("wrong.sqlite3");
        std::fs::write(&wrong, b"untouched").unwrap();
        assert_eq!(
            write_selected_file(FilePath::Path(wrong.clone()), b"{}"),
            Err("FILE_EXTENSION")
        );
        assert_eq!(std::fs::read(wrong).unwrap(), b"untouched");
    }
}

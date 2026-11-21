use tauri::{plugin::TauriPlugin, AppHandle, Wry};

const STORAGE: &str = "AI_KEY_STORAGE";
const MISSING: &str = "AI_KEY_MISSING";
const INVALID: &str = "AI_KEY_INVALID";
// Windows Credential Manager's maximum size for a generic credential blob.
const MAX_KEY_BYTES: usize = 2560;

pub(crate) fn init() -> TauriPlugin<Wry> {
    let builder = tauri::plugin::Builder::new("device-credentials");
    #[cfg(target_os = "android")]
    let builder = builder.setup(|app, api| {
        use tauri::Manager;
        // The local ledger remains usable if this optional native bridge fails to load.
        if let Ok(handle) =
            api.register_android_plugin("app.savemywallet.ledger", "DeepSeekCredentialPlugin")
        {
            app.manage(device::Credentials(handle));
        }
        Ok(())
    });
    builder.build()
}

fn validate(key: &str) -> Result<&str, String> {
    if key.is_empty() || key.len() > MAX_KEY_BYTES || !key.bytes().all(|ch| ch.is_ascii_graphic()) {
        return Err(INVALID.into());
    }
    Ok(key)
}

pub(crate) fn load(app: &AppHandle) -> Result<String, String> {
    let key = device::read(app)?.ok_or(MISSING)?;
    validate(&key)?;
    Ok(key)
}

#[tauri::command(async)]
pub(crate) fn ai_key_status(app: AppHandle) -> Result<bool, String> {
    device::read(&app).map(|key| key.is_some())
}

#[tauri::command(async)]
pub(crate) fn ai_save_key(app: AppHandle, key: String) -> Result<(), String> {
    device::save(&app, validate(key.trim())?)
}

#[tauri::command(async)]
pub(crate) fn ai_remove_key(app: AppHandle) -> Result<(), String> {
    device::remove(&app)
}

#[cfg(windows)]
mod device {
    use super::*;
    use std::{ptr, slice, str};
    use windows_sys::Win32::{
        Foundation::{GetLastError, ERROR_NOT_FOUND},
        Security::Credentials::{
            CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
            CRED_TYPE_GENERIC,
        },
    };

    fn target(app: &AppHandle) -> String {
        format!("{}/DeepSeek", app.config().identifier)
    }

    fn wide(target: &str) -> Vec<u16> {
        target.encode_utf16().chain(Some(0)).collect()
    }

    fn read_target(target: &str) -> Result<Option<String>, String> {
        let name = wide(target);
        let mut raw = ptr::null_mut();
        // SAFETY: name is NUL-terminated. On success Windows allocates raw until CredFree.
        if unsafe { CredReadW(name.as_ptr(), CRED_TYPE_GENERIC, 0, &mut raw) } == 0 {
            return if unsafe { GetLastError() } == ERROR_NOT_FOUND {
                Ok(None)
            } else {
                Err(STORAGE.into())
            };
        }
        let credential = unsafe { &*raw };
        let size = credential.CredentialBlobSize as usize;
        let value = if credential.CredentialBlob.is_null() || size == 0 || size > MAX_KEY_BYTES {
            Err(STORAGE.to_owned())
        } else {
            // SAFETY: the credential blob covers the reported byte count until CredFree below.
            let bytes = unsafe { slice::from_raw_parts(credential.CredentialBlob, size) };
            str::from_utf8(bytes)
                .map(|s| Some(s.to_owned()))
                .map_err(|_| STORAGE.to_owned())
        };
        unsafe { CredFree(raw.cast()) };
        value
    }

    fn save_target(target: &str, key: &str) -> Result<(), String> {
        let mut name = wide(target);
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: name.as_mut_ptr(),
            CredentialBlobSize: key.len() as u32,
            CredentialBlob: key.as_ptr().cast_mut(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };
        // SAFETY: Windows reads both input buffers synchronously during CredWriteW.
        if unsafe { CredWriteW(&credential, 0) } == 0 {
            return Err(STORAGE.into());
        }
        Ok(())
    }

    fn remove_target(target: &str) -> Result<(), String> {
        let name = wide(target);
        if unsafe { CredDeleteW(name.as_ptr(), CRED_TYPE_GENERIC, 0) } == 0
            && unsafe { GetLastError() } != ERROR_NOT_FOUND
        {
            return Err(STORAGE.into());
        }
        Ok(())
    }

    pub(super) fn read(app: &AppHandle) -> Result<Option<String>, String> {
        read_target(&target(app))
    }
    pub(super) fn save(app: &AppHandle, key: &str) -> Result<(), String> {
        save_target(&target(app), key)
    }
    pub(super) fn remove(app: &AppHandle) -> Result<(), String> {
        remove_target(&target(app))
    }

    #[test]
    #[ignore = "requires a Windows user logon with a writable credential store"]
    fn windows_test_credential_can_be_replaced_and_removed() {
        // Keep the synthetic credential independent of the app's real target and other runs.
        let temp = tempfile::tempdir().unwrap();
        let target = format!("SaveMyWallet-credential-test/{}", temp.path().display());
        struct Cleanup<'a>(&'a str);
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                let _ = remove_target(self.0);
            }
        }
        let _cleanup = Cleanup(&target);
        assert!(read_target(&target).unwrap().is_none());
        save_target(&target, "synthetic-first").unwrap();
        assert_eq!(
            read_target(&target).unwrap().as_deref(),
            Some("synthetic-first")
        );
        save_target(&target, "synthetic-replacement").unwrap();
        assert_eq!(
            read_target(&target).unwrap().as_deref(),
            Some("synthetic-replacement")
        );
        remove_target(&target).unwrap();
        remove_target(&target).unwrap();
        assert!(read_target(&target).unwrap().is_none());
    }
}

#[cfg(target_os = "android")]
mod device {
    use super::*;
    use tauri::{plugin::PluginHandle, Manager};

    pub(super) struct Credentials(pub(super) PluginHandle<Wry>);

    fn bridge(app: &AppHandle) -> Result<tauri::State<'_, Credentials>, String> {
        app.try_state::<Credentials>()
            .ok_or_else(|| STORAGE.to_owned())
    }
    pub(super) fn read(app: &AppHandle) -> Result<Option<String>, String> {
        bridge(app)?
            .0
            .run_mobile_plugin("readKey", ())
            .map_err(|_| STORAGE.into())
    }
    pub(super) fn save(app: &AppHandle, key: &str) -> Result<(), String> {
        bridge(app)?
            .0
            .run_mobile_plugin("saveKey", serde_json::json!({ "key": key }))
            .map_err(|_| STORAGE.into())
    }
    pub(super) fn remove(app: &AppHandle) -> Result<(), String> {
        bridge(app)?
            .0
            .run_mobile_plugin("removeKey", ())
            .map_err(|_| STORAGE.into())
    }
}

#[cfg(not(any(windows, target_os = "android")))]
mod device {
    use super::*;

    pub(super) fn read(_: &AppHandle) -> Result<Option<String>, String> {
        Err(STORAGE.into())
    }
    pub(super) fn save(_: &AppHandle, _: &str) -> Result<(), String> {
        Err(STORAGE.into())
    }
    pub(super) fn remove(_: &AppHandle) -> Result<(), String> {
        Err(STORAGE.into())
    }
}

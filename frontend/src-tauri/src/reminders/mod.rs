use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{plugin::TauriPlugin, AppHandle, Wry};

const DELIVERY: &str = "REMINDER_DELIVERY";
const PERMISSION: &str = "REMINDER_PERMISSION";
const TIME: &str = "REMINDER_TIME";

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(tag = "frequency", rename_all = "lowercase", deny_unknown_fields)]
pub(super) enum ReminderRecurrence {
    Daily {
        time: String,
    },
    Weekly {
        time: String,
        weekday: u8,
    },
    Monthly {
        time: String,
        #[serde(rename = "dayOfMonth")]
        day_of_month: u8,
    },
    Interval {
        minutes: u16,
        #[serde(rename = "anchorAt")]
        anchor_at: i64,
    },
    #[serde(rename = "randomWindow")]
    RandomWindow {
        #[serde(rename = "startTime")]
        start_time: String,
        #[serde(rename = "endTime")]
        end_time: String,
        seed: u32,
    },
}

fn parse_clock(time: &str) -> Result<chrono::NaiveTime, String> {
    let bytes = time.as_bytes();
    if bytes.len() != 5
        || bytes[2] != b':'
        || ![bytes[0], bytes[1], bytes[3], bytes[4]]
            .iter()
            .all(u8::is_ascii_digit)
    {
        return Err(TIME.into());
    }
    chrono::NaiveTime::parse_from_str(time, "%H:%M").map_err(|_| TIME.into())
}

impl ReminderRecurrence {
    fn clock(&self) -> Result<chrono::NaiveTime, String> {
        let time = match self {
            Self::Daily { time } => time,
            Self::Weekly {
                time,
                weekday: 1..=7,
            } => time,
            Self::Monthly {
                time,
                day_of_month: 1..=31,
            } => time,
            _ => return Err(TIME.into()),
        };
        parse_clock(time)
    }

    fn validate(&self) -> Result<(), String> {
        match self {
            Self::Interval { minutes, anchor_at } => {
                if !(10..=44640).contains(minutes)
                    || minutes % 10 != 0
                    || *anchor_at <= 0
                    || anchor_at % 1000 != 0
                    || chrono::DateTime::from_timestamp_millis(*anchor_at).is_none()
                {
                    return Err(TIME.into());
                }
            }
            Self::RandomWindow {
                start_time,
                end_time,
                seed,
            } => {
                if parse_clock(start_time)? == parse_clock(end_time)? || *seed > i32::MAX as u32 {
                    return Err(TIME.into());
                }
            }
            _ => {
                self.clock()?;
            }
        }
        Ok(())
    }
}

#[cfg(windows)]
pub(super) mod windows;

pub(super) fn init() -> TauriPlugin<Wry> {
    let builder = tauri::plugin::Builder::new("pet-reminders");
    #[cfg(target_os = "android")]
    let builder = builder.setup(|app, api| {
        use tauri::Manager;
        if let Ok(handle) =
            api.register_android_plugin("app.savemywallet.ledger", "PetReminderPlugin")
        {
            app.manage(android::Bridge(handle));
        }
        Ok(())
    });
    builder.build()
}

fn validate(id: i32, title: &str, body: &str) -> Result<(), String> {
    if id < 0
        || [title, body].iter().any(|s| {
            s.trim().is_empty()
                || s.chars()
                    .any(|ch| ch.is_control() && !matches!(ch, '\t' | '\n' | '\r'))
        })
        || title.chars().count() > 200
        || body.chars().count() > 1024
    {
        return Err(DELIVERY.into());
    }
    Ok(())
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[tauri::command(async)]
pub(super) fn reminder_notify(
    app: AppHandle,
    id: i32,
    title: String,
    body: String,
    request_permission: bool,
) -> Result<(), String> {
    validate(id, &title, &body)?;
    #[cfg(windows)]
    {
        let _ = request_permission;
        windows::notify(app.config(), id, &title, &body)
    }
    #[cfg(target_os = "android")]
    {
        android::send(
            &app,
            "notifyNow",
            serde_json::json!({ "id": id, "title": title, "body": body }),
            request_permission,
        )
    }
    #[cfg(not(any(windows, target_os = "android")))]
    {
        let _ = (app, request_permission);
        Err("REMINDER_UNAVAILABLE".into())
    }
}

#[tauri::command(async)]
pub(super) fn reminder_schedule(
    app: AppHandle,
    id: i32,
    at: i64,
    title: String,
    body: String,
    request_permission: bool,
    recurrence: Option<ReminderRecurrence>,
) -> Result<(), String> {
    validate(id, &title, &body)?;
    // ID 0 is reserved for immediate test notifications. Stored reminders have positive IDs.
    if id == 0 {
        return Err(DELIVERY.into());
    }
    if at <= now_millis() {
        return Err(TIME.into());
    }
    if let Some(rule) = &recurrence {
        rule.validate()?;
    }
    #[cfg(windows)]
    {
        let _ = request_permission;
        windows::schedule(app.config(), id, at, &title, &body, recurrence.as_ref())
    }
    #[cfg(target_os = "android")]
    {
        android::send(
            &app,
            "schedule",
            serde_json::json!({ "id": id, "at": at, "title": title, "body": body, "recurrence": recurrence }),
            request_permission,
        )
    }
    #[cfg(not(any(windows, target_os = "android")))]
    {
        let _ = (app, request_permission);
        Err("REMINDER_UNAVAILABLE".into())
    }
}

#[tauri::command(async)]
pub(super) fn reminder_cancel(app: AppHandle, id: i32) -> Result<(), String> {
    if id <= 0 {
        return Err(DELIVERY.into());
    }
    #[cfg(windows)]
    {
        windows::cancel(app.config(), id)
    }
    #[cfg(target_os = "android")]
    {
        android::cancel(&app, id)
    }
    #[cfg(not(any(windows, target_os = "android")))]
    {
        let _ = app;
        Err("REMINDER_UNAVAILABLE".into())
    }
}

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use tauri::{plugin::PluginHandle, Manager};
    pub(super) struct Bridge(pub(super) PluginHandle<Wry>);

    #[derive(serde::Deserialize)]
    struct Permission {
        granted: bool,
    }

    pub(super) fn send(
        app: &AppHandle,
        method: &str,
        payload: serde_json::Value,
        request: bool,
    ) -> Result<(), String> {
        let bridge = app.try_state::<Bridge>().ok_or(DELIVERY)?;
        let permission: Permission = bridge
            .0
            .run_mobile_plugin("permission", serde_json::json!({ "request": request }))
            .map_err(|_| DELIVERY)?;
        if !permission.granted {
            return Err(PERMISSION.into());
        }
        bridge
            .0
            .run_mobile_plugin(method, payload)
            .map_err(|error| {
                let message = error.to_string();
                if message.contains(PERMISSION) {
                    PERMISSION.into()
                } else if message.contains(TIME) {
                    TIME.into()
                } else {
                    DELIVERY.into()
                }
            })
    }

    pub(super) fn cancel(app: &AppHandle, id: i32) -> Result<(), String> {
        app.try_state::<Bridge>()
            .ok_or(DELIVERY)?
            .0
            .run_mobile_plugin("cancel", serde_json::json!({ "id": id }))
            .map_err(|_| DELIVERY.into())
    }
}

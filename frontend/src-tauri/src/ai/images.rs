use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::{io::Read, sync::Mutex};
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::{FsExt, OpenOptions};

const MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Default)]
struct Selection {
    generation: u64,
    preview: Option<String>,
}

#[derive(Default)]
pub(crate) struct SelectedImage(Mutex<Selection>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImagePreview {
    image_token: String,
    preview_url: String,
}

impl SelectedImage {
    fn select(&self, preview_url: String) -> Result<ImagePreview, &'static str> {
        let mut selection = self.0.lock().map_err(|_| "AI_IMAGE_EXPIRED")?;
        selection.generation += 1;
        selection.preview = Some(preview_url.clone());
        Ok(ImagePreview {
            image_token: selection.generation.to_string(),
            preview_url,
        })
    }

    pub(crate) fn data_url(&self, token: &str) -> Result<String, &'static str> {
        let selection = self.0.lock().map_err(|_| "AI_IMAGE_EXPIRED")?;
        if token == selection.generation.to_string() {
            if let Some(preview) = &selection.preview {
                return Ok(preview.clone());
            }
        }
        Err("AI_IMAGE_EXPIRED")
    }

    fn release(&self, token: &str) {
        if let Ok(mut selection) = self.0.lock() {
            if token == selection.generation.to_string() {
                selection.preview = None;
            }
        }
    }
}

fn read_image(reader: impl Read, max_bytes: usize) -> Result<String, &'static str> {
    let mut bytes = Vec::new();
    reader
        .take(max_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "FILE_READ")?;
    if bytes.len() > max_bytes {
        return Err("AI_IMAGE_TOO_LARGE");
    }
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        return Err("AI_IMAGE_FORMAT");
    };
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[tauri::command(async)]
pub(crate) fn ai_choose_image(
    window: WebviewWindow,
    images: State<'_, SelectedImage>,
) -> Result<Option<ImagePreview>, &'static str> {
    let picker = window
        .dialog()
        .file()
        .add_filter("PNG / JPEG / WebP", &["png", "jpg", "jpeg", "webp"]);
    #[cfg(desktop)]
    let picker = picker.set_parent(&window);
    let Some(path) = picker.blocking_pick_file() else {
        return Ok(None);
    };
    let mut options = OpenOptions::new();
    options.read(true);
    let reader = window.fs().open(path, options).map_err(|_| "FILE_READ")?;
    images.select(read_image(reader, MAX_BYTES)?).map(Some)
}

#[tauri::command]
pub(crate) fn ai_release_image(images: State<'_, SelectedImage>, image_token: String) {
    images.release(&image_token);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_selected_raster_images_fit_the_upload_limit() {
        let png = include_bytes!("../../../resources/ai/fixtures/vision-synthetic.png").as_slice();
        assert!(read_image(png, png.len())
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert_eq!(read_image(png, png.len() - 1), Err("AI_IMAGE_TOO_LARGE"));
        assert_eq!(
            read_image(b"<svg/>".as_slice(), MAX_BYTES),
            Err("AI_IMAGE_FORMAT")
        );
        assert_eq!(
            read_image(b"RIFF1234WAVE".as_slice(), MAX_BYTES),
            Err("AI_IMAGE_FORMAT")
        );
    }

    #[test]
    fn stale_image_tokens_cannot_read_or_release_a_new_selection() {
        let images = SelectedImage::default();
        let first = images.select("one".into()).unwrap();
        let second = images.select("two".into()).unwrap();
        assert_eq!(images.data_url(&first.image_token), Err("AI_IMAGE_EXPIRED"));
        images.release(&first.image_token);
        assert_eq!(images.data_url(&second.image_token), Ok("two".into()));
        images.release(&second.image_token);
        assert_eq!(
            images.data_url(&second.image_token),
            Err("AI_IMAGE_EXPIRED")
        );
    }
}

use super::MAX_BYTES;
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{
    codecs::{jpeg::JpegEncoder, png::PngEncoder},
    imageops::{resize, FilterType},
    metadata::Orientation,
    DynamicImage, ExtendedColorType, GenericImageView, ImageDecoder, ImageEncoder, ImageError,
    ImageFormat, ImageReader, Limits,
};
use std::io::Cursor;

const DIMENSIONS: &str = "AI_IMAGE_DIMENSIONS";
const FORMAT: &str = "AI_IMAGE_FORMAT";
const MAX_PIXELS: u64 = 32_000_000;
const MAX_DECODE_BYTES: u64 = 96 * 1024 * 1024;
const MAX_TILES: u32 = 16;
const MAX_DATA_URL_BYTES: usize = 30 * 1024 * 1024;
const TILE_WIDTH: u32 = 1080;

fn image_error(error: ImageError) -> String {
    match error {
        ImageError::Limits(_) => DIMENSIONS.into(),
        _ => FORMAT.into(),
    }
}

/// Prepare only the image selected for this import. Keep ordinary screenshots byte-for-byte.
pub(crate) fn prepare_bill_images(image: String) -> Result<Vec<String>, String> {
    let (prefix, encoded) = image.split_once(',').ok_or(FORMAT)?;
    let format = match prefix {
        "data:image/png;base64" => ImageFormat::Png,
        "data:image/jpeg;base64" => ImageFormat::Jpeg,
        "data:image/webp;base64" => ImageFormat::WebP,
        _ => return Err(FORMAT.into()),
    };
    if encoded.len() > MAX_BYTES.div_ceil(3) * 4 {
        return Err("AI_IMAGE_TOO_LARGE".into());
    }
    let bytes = STANDARD.decode(encoded).map_err(|_| FORMAT)?;
    if bytes.len() > MAX_BYTES {
        return Err("AI_IMAGE_TOO_LARGE".into());
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    limits.max_image_width = Some(65_535);
    limits.max_image_height = Some(65_535);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(image_error)?;
    let orientation = decoder.orientation().map_err(image_error)?;
    let (mut width, mut height) = decoder.dimensions();
    if matches!(
        orientation,
        Orientation::Rotate90
            | Orientation::Rotate270
            | Orientation::Rotate90FlipH
            | Orientation::Rotate270FlipH
    ) {
        std::mem::swap(&mut width, &mut height);
    }
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(DIMENSIONS.into());
    }
    if height <= width * 3 || height <= 2048 {
        if width.max(height) > 8192 {
            return Err(DIMENSIONS.into());
        }
        return Ok(vec![image]);
    }
    drop(image);
    let output_width = width.min(TILE_WIDTH);
    let output_height =
        (u64::from(height) * u64::from(output_width)).div_ceil(u64::from(width)) as u32;
    // Leave room for overlap and for shifting a cut to a gap between lines of text.
    let margin = (output_width / 20).clamp(16, 54);
    let tile_height = (output_width * 3 / 2).clamp(1024, 1536);
    let count = output_height.div_ceil(tile_height - 3 * margin);
    if count > MAX_TILES || decoder.total_bytes() > MAX_DECODE_BYTES {
        return Err(DIMENSIONS.into());
    }
    let mut raster = DynamicImage::from_decoder(decoder).map_err(image_error)?;
    raster.apply_orientation(orientation);
    let source_margin = (margin * width).div_ceil(output_width);
    encode_tiles(&raster, output_width, count, source_margin)
}

fn encode_tiles(
    raster: &DynamicImage,
    output_width: u32,
    count: u32,
    margin: u32,
) -> Result<Vec<String>, String> {
    let (width, height) = raster.dimensions();
    let mut tiles = Vec::with_capacity(count as usize);
    let mut total_bytes = 0;
    let mut start: u32 = 0;
    for n in 1..=count {
        let end = if n == count {
            height
        } else {
            quiet_cut(raster, height * n / count, margin / 2)
        };
        let top = start.saturating_sub(margin);
        let bottom = (end + margin).min(height);
        let band = raster.view(0, top, width, bottom - top);
        // Resize one band at a time. A full-height resize needs a large floating-point
        // intermediate even when the original JPEG fits easily in phone memory.
        let pixels = if output_width == width {
            band.to_image()
        } else {
            let output_height = ((bottom - top) * output_width).div_ceil(width);
            resize(&*band, output_width, output_height, FilterType::Triangle)
        };
        let mut compressed = Vec::new();
        let prefix = if raster.color().has_alpha() {
            PngEncoder::new(&mut compressed)
                .write_image(
                    pixels.as_raw(),
                    pixels.width(),
                    pixels.height(),
                    ExtendedColorType::Rgba8,
                )
                .map_err(image_error)?;
            "data:image/png;base64,"
        } else {
            JpegEncoder::new_with_quality(&mut compressed, 90)
                .encode_image(&pixels)
                .map_err(image_error)?;
            "data:image/jpeg;base64,"
        };
        let length = prefix.len() + compressed.len().div_ceil(3) * 4;
        total_bytes += length;
        if total_bytes > MAX_DATA_URL_BYTES {
            return Err(DIMENSIONS.into());
        }
        let mut url = String::with_capacity(length);
        url.push_str(prefix);
        STANDARD.encode_string(compressed, &mut url);
        tiles.push(url);
        start = end;
    }
    Ok(tiles)
}

/// Favor rows with little horizontal contrast, in either a light or a dark theme.
fn quiet_cut(image: &DynamicImage, middle: u32, radius: u32) -> u32 {
    let step = (image.width() / 256).max(1) as usize;
    (middle - radius..=middle + radius)
        .min_by_key(|&y| {
            let mut variation = 0u32;
            let mut previous = image.get_pixel(0, y);
            for x in (0..image.width()).step_by(step) {
                let pixel = image.get_pixel(x, y);
                for channel in 0..3 {
                    variation += u32::from(pixel[channel].abs_diff(previous[channel]));
                }
                previous = pixel;
            }
            (variation, middle.abs_diff(y))
        })
        .unwrap_or(middle)
}

#[cfg(test)]
mod tests;

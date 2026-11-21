use super::*;
use image::{Rgb, RgbImage, Rgba, RgbaImage};

fn data_url(image: DynamicImage, format: ImageFormat) -> String {
    let mut bytes = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut bytes), format)
        .unwrap();
    format!(
        "data:{};base64,{}",
        format.to_mime_type(),
        STANDARD.encode(bytes)
    )
}

fn decode_tile(url: &str) -> DynamicImage {
    let (_, encoded) = url.split_once(',').unwrap();
    image::load_from_memory(&STANDARD.decode(encoded).unwrap()).unwrap()
}

#[test]
fn ordinary_screenshots_keep_their_encoding() {
    for format in [ImageFormat::Png, ImageFormat::Jpeg, ImageFormat::WebP] {
        let url = data_url(DynamicImage::new_rgb8(64, 128), format);
        assert_eq!(prepare_bill_images(url.clone()).unwrap(), [url]);
    }
}

#[test]
fn cuts_prefer_a_gap_between_text_rows_on_light_or_dark_backgrounds() {
    for background in [18, 248] {
        let image = RgbImage::from_fn(300, 100, |x, y| {
            let in_text = y != 47 && (20..275).contains(&x) && x % 6 < 3;
            Rgb([if in_text {
                255 - background
            } else {
                background
            }; 3])
        });
        assert_eq!(quiet_cut(&image.into(), 50, 6), 47);
    }
}

#[test]
fn long_png_and_webp_tiles_cover_each_scanline_in_order_with_overlap() {
    let (width, height) = (144, 2150);
    let raster = RgbaImage::from_fn(width, height, |x, y| {
        Rgba([x as u8, (y >> 8) as u8, y as u8, 205])
    });
    for format in [ImageFormat::Png, ImageFormat::WebP] {
        let tiles = prepare_bill_images(data_url(raster.clone().into(), format)).unwrap();
        assert_eq!(tiles.len(), 3);
        let mut previous_end = 0;
        for (i, tile) in tiles.iter().enumerate() {
            let band = decode_tile(tile);
            assert_eq!(band.width(), width);
            let first_pixel = band.get_pixel(0, 0);
            let start = u32::from(first_pixel[1]) * 256 + u32::from(first_pixel[2]);
            if i == 0 {
                assert_eq!(start, 0);
            } else {
                assert_eq!(previous_end - start, 32);
            }
            for y in 0..band.height() {
                assert_eq!(band.get_pixel(42, y), *raster.get_pixel(42, start + y));
            }
            previous_end = start + band.height();
        }
        assert_eq!(previous_end, height);
    }
}

#[test]
fn scrolling_statement_jpeg_keeps_visible_width_and_both_ends() {
    let image = RgbImage::from_fn(1260, 9460, |_, y| {
        if y < 64 {
            Rgb([220, 20, 20])
        } else if y > 9396 {
            Rgb([20, 20, 220])
        } else {
            Rgb([252; 3])
        }
    });
    let tiles = prepare_bill_images(data_url(image.into(), ImageFormat::Jpeg)).unwrap();
    assert_eq!(tiles.len(), 6);
    let first = decode_tile(&tiles[0]);
    let last = decode_tile(tiles.last().unwrap());
    assert_eq!(first.width(), 1080);
    assert_eq!(last.width(), 1080);
    assert!(first.get_pixel(0, 0)[0] > 210);
    assert!(last.get_pixel(0, last.height() - 1)[2] > 210);
}

#[test]
fn excessive_or_corrupt_images_fail_without_sending_partial_tiles() {
    assert_eq!(
        prepare_bill_images("data:image/jpeg;base64,AAAA".into()),
        Err(FORMAT.into())
    );
    let wide = data_url(DynamicImage::new_rgb8(9000, 1), ImageFormat::Png);
    assert_eq!(prepare_bill_images(wide), Err(DIMENSIONS.into()));
    let too_many_tiles = data_url(DynamicImage::new_rgb8(8, 32_000), ImageFormat::Png);
    assert_eq!(prepare_bill_images(too_many_tiles), Err(DIMENSIONS.into()));
    let oversized =
        "data:image/png;base64,".to_owned() + &"A".repeat(MAX_BYTES.div_ceil(3) * 4 + 4);
    assert_eq!(
        prepare_bill_images(oversized),
        Err("AI_IMAGE_TOO_LARGE".into())
    );
}

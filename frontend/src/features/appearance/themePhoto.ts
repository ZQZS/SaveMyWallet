const maxFileBytes = 20 * 1024 * 1024
const maxPixels = 64_000_000
const maxJpegBytes = 350 * 1024

export class ThemePhotoError extends Error {
  readonly code: 'format' | 'size' | 'decode'

  constructor(code: 'format' | 'size' | 'decode') {
    super(code)
    this.name = 'ThemePhotoError'
    this.code = code
  }
}

function imageType(header: Uint8Array): string | undefined {
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg'
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (png.every((value, index) => header[index] === value)) return 'image/png'
  const text = String.fromCharCode(...header)
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return 'image/webp'
  return undefined
}

function jpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob?.type === 'image/jpeg' && blob.size > 0) resolve(blob)
      else reject(new ThemePhotoError('decode'))
    }, 'image/jpeg', quality)
  })
}

function readJpeg(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string' && reader.result.startsWith('data:image/jpeg;base64,') && reader.result.length <= 500_000) {
        resolve(reader.result)
      } else {
        reject(new ThemePhotoError('decode'))
      }
    }
    reader.onerror = () => reject(new ThemePhotoError('decode'))
    reader.readAsDataURL(blob)
  })
}

export async function prepareThemePhoto(file: File): Promise<string> {
  if (file.size > maxFileBytes) throw new ThemePhotoError('size')
  const image = new Image()
  const canvas = document.createElement('canvas')
  let url: string | undefined
  try {
    const header = new Uint8Array(await file.slice(0, 12).arrayBuffer())
    const type = imageType(header)
    if (!type || (file.type && file.type !== type)) throw new ThemePhotoError('format')

    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new ThemePhotoError('decode'))
      image.decoding = 'async'
      url = URL.createObjectURL(file)
      image.src = url
    })
    const { naturalWidth: width, naturalHeight: height } = image
    if (!width || !height) throw new ThemePhotoError('decode')
    if (width * height > maxPixels) throw new ThemePhotoError('size')
    await image.decode()
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new ThemePhotoError('decode')

    for (const maxEdge of [1280, 960, 640]) {
      const scale = Math.min(1, maxEdge / Math.max(width, height))
      canvas.width = Math.max(1, Math.round(width * scale))
      canvas.height = Math.max(1, Math.round(height * scale))
      context.fillStyle = '#fff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      for (const quality of [0.84, 0.67, 0.5]) {
        const blob = await jpegBlob(canvas, quality)
        if (blob.size <= maxJpegBytes) return await readJpeg(blob)
      }
    }
    throw new ThemePhotoError('size')
  } catch (error) {
    if (error instanceof ThemePhotoError) throw error
    throw new ThemePhotoError('decode')
  } finally {
    image.onload = null
    image.onerror = null
    image.removeAttribute('src')
    if (url) URL.revokeObjectURL(url)
    canvas.width = canvas.height = 0
  }
}

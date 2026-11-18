import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

/**
 * 附件投毒：在上传前改写本地文件，让模型读取附件时能看到用户填写的文本。
 *
 * 纯本地处理，不依赖服务端代理；原始 Blob 仍保存在 IndexedDB，重新上传时可以重新投毒。
 * 每种方式按文件类型尽力而为：文本正文 / 图片文字 / DOCX 正文 / 图片元数据 / 文件尾附加 /
 * 文件名 / 伴随文本附件。失败时回退为原文件，不阻断上传。
 */

export type AttachmentPoisonMethod =
  | 'text'
  | 'docx'
  | 'imageOverlay'
  | 'imageMetadata'
  | 'binaryTrailer'
  | 'filename'
  | 'sidecar'

export type AttachmentPoisonPosition = 'prepend' | 'append'

export type AttachmentPoisonConfig = {
  enabled: boolean
  content: string
  methods: AttachmentPoisonMethod[]
  position: AttachmentPoisonPosition
}

export const ATTACHMENT_POISON_METHODS: AttachmentPoisonMethod[] = [
  'text',
  'docx',
  'imageOverlay',
  'imageMetadata',
  'binaryTrailer',
  'filename',
  'sidecar',
]

export const ATTACHMENT_POISON_LIMITS = {
  content: 4000,
  filenameSlug: 40,
} as const

const METHOD_SET = new Set<string>(ATTACHMENT_POISON_METHODS)

export const defaultAttachmentPoison = (): AttachmentPoisonConfig => ({
  enabled: false,
  content: '',
  methods: ['text', 'imageOverlay'],
  position: 'append',
})

export const normalizeAttachmentPoison = (value: unknown): AttachmentPoisonConfig => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return defaultAttachmentPoison()
  }
  const raw = value as Record<string, unknown>
  const methods: AttachmentPoisonMethod[] = []
  if (Array.isArray(raw.methods)) {
    for (const item of raw.methods) {
      if (typeof item === 'string' && METHOD_SET.has(item)) {
        const method = item as AttachmentPoisonMethod
        if (!methods.includes(method)) {
          methods.push(method)
        }
      }
    }
  } else {
    methods.push('text', 'imageOverlay')
  }
  return {
    enabled: raw.enabled === true,
    content:
      typeof raw.content === 'string' ? raw.content.slice(0, ATTACHMENT_POISON_LIMITS.content) : '',
    methods,
    position: raw.position === 'prepend' ? 'prepend' : 'append',
  }
}

const hashString = (value: string): string => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

/** 配置指纹：上传任务与会话附件用它判断是否需要按新配置重新上传 */
export const attachmentPoisonSignature = (config: AttachmentPoisonConfig): string => {
  if (!config.enabled || config.content.trim() === '' || config.methods.length === 0) {
    return 'off'
  }
  const methods = [...config.methods].sort()
  return `poison-${hashString(JSON.stringify({ content: config.content, methods, position: config.position }))}`
}

export const poisonBlock = (content: string): string =>
  content.trim() === '' ? '' : `\n\n[ATTACHMENT NOTE]\n${content.trim()}\n[/ATTACHMENT NOTE]\n`

const getExt = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

const replaceExt = (name: string, ext: string): string => {
  const dot = name.lastIndexOf('.')
  return `${dot > 0 ? name.slice(0, dot) : name}.${ext}`
}

const TEXT_EXTS = new Set([
  'txt',
  'md',
  'markdown',
  'mdown',
  'mkd',
  'csv',
  'tsv',
  'html',
  'htm',
  'xhtml',
  'xml',
  'json',
  'jsonl',
  'ndjson',
  'log',
  'yaml',
  'yml',
  'ini',
  'conf',
  'cfg',
  'toml',
  'properties',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'mts',
  'cts',
  'css',
  'scss',
  'sass',
  'less',
  'py',
  'pyw',
  'go',
  'java',
  'kt',
  'kts',
  'c',
  'cc',
  'cpp',
  'cxx',
  'h',
  'hpp',
  'cs',
  'rs',
  'rb',
  'php',
  'pl',
  'pm',
  'sh',
  'bash',
  'zsh',
  'fish',
  'bat',
  'cmd',
  'ps1',
  'psm1',
  'sql',
  'tex',
  'latex',
  'r',
  'swift',
  'scala',
  'lua',
  'vim',
  'vue',
  'svelte',
  'astro',
  'sol',
  'graphql',
  'gql',
  'proto',
  'dart',
  'ex',
  'exs',
  'erl',
  'hrl',
  'fs',
  'fsx',
  'clj',
  'cljs',
  'cljc',
  'groovy',
  'gradle',
  'make',
  'cmake',
  'dockerfile',
  'gitignore',
  'env',
])

const TEXT_MIME_PARTS = [
  'json',
  'xml',
  'javascript',
  'yaml',
  'x-yaml',
  'x-sh',
  'x-httpd-php',
  'rtf',
]

export const isTextLikeAttachment = (name: string, mime: string): boolean => {
  if (mime.startsWith('text/')) {
    return true
  }
  if (TEXT_EXTS.has(getExt(name))) {
    return true
  }
  const normalized = mime.toLowerCase()
  return TEXT_MIME_PARTS.some((part) => normalized.includes(part))
}

const isSvg = (name: string, mime: string) => mime === 'image/svg+xml' || getExt(name) === 'svg'
const canOverlay = (name: string, mime: string, isImage: boolean) => isImage && !isSvg(name, mime)
const isJpeg = (name: string, mime: string) =>
  mime === 'image/jpeg' || ['jpg', 'jpeg', 'jfif', 'pjpeg'].includes(getExt(name))
const isPng = (name: string, mime: string) => mime === 'image/png' || getExt(name) === 'png'
const isZipLike = (name: string) => ['docx', 'pptx', 'xlsx', 'epub', 'svg'].includes(getExt(name))
const canTrailer = (name: string) => !isZipLike(name)

const stripControls = (value: string): string =>
  Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0
      return code === 9 || code === 10 || code === 13 || code >= 32
    })
    .join('')

const stripFilenameChars = (value: string, replacement = ''): string =>
  Array.from(value)
    .map((character) => {
      const code = character.codePointAt(0) ?? 0
      return code < 32 || '\\/:*?"<>|'.includes(character) ? replacement : character
    })
    .join('')

const escapeXml = (value: string): string =>
  stripControls(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')

const blobFromBytes = (bytes: Uint8Array, type: string): Blob =>
  new Blob([bytes.buffer as ArrayBuffer], { type })

/** 文本 / 代码 / 标记文件：直接在正文前后插入带标记的文本 */
const poisonText = async (blob: Blob, config: AttachmentPoisonConfig): Promise<Blob | null> => {
  try {
    const block = poisonBlock(config.content)
    if (block === '') {
      return null
    }
    const original = await blob.text()
    return new Blob(
      [config.position === 'prepend' ? `${block}${original}` : `${original}${block}`],
      {
        type: blob.type || 'text/plain',
      }
    )
  } catch {
    return null
  }
}

/** DOCX 是 ZIP：在 word/document.xml 的 w:body 末尾插入一个段落 */
const poisonDocx = async (blob: Blob, content: string): Promise<Blob | null> => {
  try {
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()))
    const document = files['word/document.xml']
    if (!document) {
      return null
    }
    const xml = strFromU8(document)
    const poisoned = escapeXml(`[ATTACHMENT NOTE]\n${content.trim()}`).replace(
      /\n/g,
      '</w:t></w:r><w:br/><w:r><w:t xml:space="preserve">'
    )
    // 调用方已经确保 content 非空；这里仍检查 body，避免破坏异常文档
    if (!xml.includes('</w:body>')) {
      return null
    }
    const paragraph = `<w:p><w:r><w:t xml:space="preserve">${poisoned}</w:t></w:r></w:p>`
    // sectPr 必须是 body 的最后一个元素；插在它前面，避免 Word 忽略追加段落
    const sect = xml.lastIndexOf('<w:sectPr')
    const insertAt = sect >= 0 ? sect : xml.lastIndexOf('</w:body>')
    files['word/document.xml'] = strToU8(
      `${xml.slice(0, insertAt)}${paragraph}${xml.slice(insertAt)}`
    )
    return blobFromBytes(
      zipSync(files),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
  } catch {
    return null
  }
}

type LoadedImage = {
  source: CanvasImageSource
  width: number
  height: number
  close: () => void
}

const loadImage = async (blob: Blob): Promise<LoadedImage | null> => {
  if (typeof document === 'undefined') {
    return null
  }
  if ('createImageBitmap' in globalThis) {
    try {
      const bitmap = await createImageBitmap(blob)
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      }
    } catch {
      // 回退到 HTMLImageElement
    }
  }
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    }
  } catch {
    URL.revokeObjectURL(url)
    return null
  }
}

const wrapText = (context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] => {
  const lines: string[] = []
  for (const paragraph of text.split(/\r?\n/)) {
    if (paragraph === '') {
      lines.push('')
      continue
    }
    let line = ''
    for (const character of Array.from(paragraph)) {
      const next = line + character
      if (line !== '' && context.measureText(next).width > maxWidth) {
        lines.push(line)
        line = character
      } else {
        line = next
      }
    }
    if (line !== '') {
      lines.push(line)
    }
  }
  return lines
}

const imageOutput = (blob: Blob, name: string): { type: string; ext: string } => {
  if (isJpeg(name, blob.type)) {
    return { type: 'image/jpeg', ext: 'jpg' }
  }
  if (blob.type === 'image/webp' || getExt(name) === 'webp') {
    return { type: 'image/webp', ext: 'webp' }
  }
  return { type: 'image/png', ext: 'png' }
}

/** 图片：把正文绘制成顶部/底部文字面板，模型能直接通过视觉读取 */
const poisonImage = async (
  blob: Blob,
  name: string,
  config: AttachmentPoisonConfig
): Promise<{ blob: Blob; name: string } | null> => {
  const loaded = await loadImage(blob)
  if (!loaded || loaded.width <= 0 || loaded.height <= 0) {
    return null
  }
  try {
    const scale = Math.min(1, 2048 / Math.max(loaded.width, loaded.height))
    const width = Math.max(1, Math.round(loaded.width * scale))
    const height = Math.max(1, Math.round(loaded.height * scale))
    const fontSize = Math.max(14, Math.min(32, Math.round(width / 40)))
    const lineHeight = Math.round(fontSize * 1.35)
    const padding = Math.max(12, Math.round(width * 0.02))
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) {
      return null
    }
    context.font = `${fontSize}px -apple-system, "Segoe UI", sans-serif`
    const text = `[ATTACHMENT NOTE]\n${config.content.trim()}`
    let lines = wrapText(context, text, width - padding * 2)
    const maxLines = 400
    if (lines.length > maxLines) {
      lines = [...lines.slice(0, maxLines - 1), '…']
    }
    const panelHeight = Math.min(8192 - height, lines.length * lineHeight + padding * 2)
    if (panelHeight <= 0) {
      return null
    }
    canvas.width = width
    canvas.height = height + panelHeight
    const draw = canvas.getContext('2d')
    if (!draw) {
      return null
    }
    draw.font = `${fontSize}px -apple-system, "Segoe UI", sans-serif`
    draw.textBaseline = 'top'
    const panelTop = config.position === 'prepend' ? 0 : height
    const imageTop = config.position === 'prepend' ? panelHeight : 0
    draw.drawImage(loaded.source, 0, imageTop, width, height)
    draw.fillStyle = 'rgba(0, 0, 0, 0.82)'
    draw.fillRect(0, panelTop, width, panelHeight)
    draw.fillStyle = '#ffffff'
    lines.forEach((line, index) => {
      const y = panelTop + padding + index * lineHeight
      if (y + lineHeight <= panelTop + panelHeight) {
        draw.fillText(line, padding, y)
      }
    })
    const output = imageOutput(blob, name)
    const result = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, output.type, output.type === 'image/jpeg' ? 0.92 : undefined)
    })
    if (!result) {
      return null
    }
    // 浏览器可能不支持目标编码（例如 WebP），按实际 Blob 类型修正扩展名
    const actualExt =
      result.type === 'image/jpeg' ? 'jpg' : result.type === 'image/webp' ? 'webp' : 'png'
    return {
      blob: result,
      name: replaceExt(name, actualExt),
    }
  } finally {
    loaded.close()
  }
}

/** JPEG COM / PNG tEXt：把内容写进图片元数据（实验性，部分提取器会读到） */
const poisonImageMetadata = async (
  blob: Blob,
  name: string,
  content: string
): Promise<Blob | null> => {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const textBytes = new TextEncoder().encode(`[ATTACHMENT NOTE] ${content.trim()}`)
    if (isJpeg(name, blob.type)) {
      if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || textBytes.length > 65533) {
        return null
      }
      const length = textBytes.length + 2
      const output = new Uint8Array(bytes.length + 4 + textBytes.length)
      output.set(bytes.subarray(0, 2), 0)
      output[2] = 0xff
      output[3] = 0xfe
      output[4] = (length >> 8) & 0xff
      output[5] = length & 0xff
      output.set(textBytes, 6)
      output.set(bytes.subarray(2), 6 + textBytes.length)
      return blobFromBytes(output, 'image/jpeg')
    }
    if (!isPng(name, blob.type)) {
      return null
    }
    const signature = [137, 80, 78, 71, 13, 10, 26, 10]
    if (bytes.length < 8 || signature.some((value, index) => bytes[index] !== value)) {
      return null
    }
    let offset = 8
    let iend = -1
    while (offset + 12 <= bytes.length) {
      const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0)
      const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
      if (type === 'IEND') {
        iend = offset
        break
      }
      offset += 12 + length
    }
    if (iend < 0) {
      return null
    }
    const data = new Uint8Array(8 + textBytes.length)
    data.set([67, 111, 109, 109, 101, 110, 116, 0], 0) // "Comment\0"
    data.set(textBytes, 8)
    const chunk = new Uint8Array(12 + data.length)
    new DataView(chunk.buffer).setUint32(0, data.length)
    chunk.set([116, 69, 88, 116], 4) // tEXt
    chunk.set(data, 8)
    new DataView(chunk.buffer).setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)))
    const output = new Uint8Array(bytes.length + chunk.length)
    output.set(bytes.subarray(0, iend), 0)
    output.set(chunk, iend)
    output.set(bytes.subarray(iend), iend + chunk.length)
    return blobFromBytes(output, 'image/png')
  } catch {
    return null
  }
}

let crcTable: Uint32Array | null = null

const crc32 = (bytes: Uint8Array): number => {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let index = 0; index < 256; index += 1) {
      let value = index
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      }
      crcTable[index] = value >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** 文件尾附加：PDF / 未知二进制等解析器可能读到；ZIP 类（Office/EPUB）跳过以免破坏结构 */
const poisonTrailer = async (blob: Blob, content: string): Promise<Blob | null> => {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const note = new TextEncoder().encode(poisonBlock(content))
    const output = new Uint8Array(bytes.length + note.length)
    output.set(bytes, 0)
    output.set(note, bytes.length)
    return blobFromBytes(output, blob.type)
  } catch {
    return null
  }
}

const poisonFilename = (name: string, content: string): string => {
  const firstLine = content.trim().split(/\r?\n/)[0] ?? ''
  const slug = stripFilenameChars(firstLine)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ATTACHMENT_POISON_LIMITS.filenameSlug)
  if (slug === '') {
    return name
  }
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  return `poison-${slug}-${base}`.slice(0, 120 - ext.length) + ext
}

export type PoisonedUpload = {
  blob: Blob
  name: string
  poison: string
  applied: AttachmentPoisonMethod[]
}

export const applyAttachmentPoison = async (
  blob: Blob,
  name: string,
  isImage: boolean,
  config: AttachmentPoisonConfig
): Promise<PoisonedUpload> => {
  const poison = attachmentPoisonSignature(config)
  if (poison === 'off') {
    return { blob, name, poison: 'off', applied: [] }
  }
  const ext = getExt(name)
  const applied: AttachmentPoisonMethod[] = []
  let output = blob
  let outputName = name
  let contentApplied = false

  if (config.methods.includes('text') && isTextLikeAttachment(name, blob.type)) {
    const next = await poisonText(output, config)
    if (next) {
      output = next
      applied.push('text')
      contentApplied = true
    }
  }

  if (config.methods.includes('docx') && ext === 'docx' && !contentApplied) {
    const next = await poisonDocx(output, config.content)
    if (next) {
      output = next
      applied.push('docx')
      contentApplied = true
    }
  }

  if (
    config.methods.includes('imageOverlay') &&
    canOverlay(name, blob.type, isImage) &&
    !contentApplied
  ) {
    const next = await poisonImage(output, outputName, config)
    if (next) {
      output = next.blob
      outputName = next.name
      applied.push('imageOverlay')
      contentApplied = true
    }
  }

  if (
    config.methods.includes('imageMetadata') &&
    (isJpeg(name, blob.type) || isPng(name, blob.type))
  ) {
    const next = await poisonImageMetadata(output, outputName, config.content)
    if (next) {
      output = next
      applied.push('imageMetadata')
    }
  }

  if (config.methods.includes('binaryTrailer') && canTrailer(name) && !contentApplied) {
    const next = await poisonTrailer(output, config.content)
    if (next) {
      output = next
      applied.push('binaryTrailer')
      contentApplied = true
    }
  }

  if (config.methods.includes('filename')) {
    const next = poisonFilename(outputName, config.content)
    if (next !== outputName) {
      outputName = next
      applied.push('filename')
    }
  }

  return { blob: output, name: outputName, poison, applied }
}

/** 伴随文本附件：额外生成一个 .txt，随原附件一起上传，适合 PDF / Office / 任意格式 */
export const createPoisonSidecar = (originalName: string, content: string): File => {
  const safeName = stripFilenameChars(originalName, '_').slice(0, 60)
  const text = poisonBlock(content)
  return new File([text], `attachment-note-${safeName}.txt`, { type: 'text/plain' })
}

export const attachmentPoisonMethodApplies = (
  method: AttachmentPoisonMethod,
  name: string,
  mime: string,
  isImage: boolean
): boolean => {
  switch (method) {
    case 'text':
      return isTextLikeAttachment(name, mime)
    case 'docx':
      return getExt(name) === 'docx'
    case 'imageOverlay':
      return canOverlay(name, mime, isImage)
    case 'imageMetadata':
      return isJpeg(name, mime) || isPng(name, mime)
    case 'binaryTrailer':
      return canTrailer(name)
    case 'filename':
    case 'sidecar':
      return true
    default:
      return false
  }
}

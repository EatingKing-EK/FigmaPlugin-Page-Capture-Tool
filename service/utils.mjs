import crypto from 'node:crypto'
import fs from 'node:fs/promises'

export class HttpError extends Error {
  constructor(statusCode, message) {
    super(message)
    this.name = 'HttpError'
    this.statusCode = statusCode
  }
}

export async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true })
}

export function normalizeUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    throw new Error('请输入有效的网页链接。')
  }

  const trimmed = rawUrl.trim()
  const withProtocol = /^[a-z]+:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`
  const normalizedUrl = new URL(withProtocol)

  if (!['http:', 'https:'].includes(normalizedUrl.protocol)) {
    throw new Error('仅支持抓取 http 或 https 链接。')
  }

  return normalizedUrl.toString()
}

export function explainErrorInChinese(error) {
  const rawMessage =
    error instanceof Error ? error.message : String(error || '未知错误')
  const normalizedMessage = rawMessage.toLowerCase()

  if (normalizedMessage.includes('err_name_not_resolved')) {
    return '域名解析失败，请检查链接是否正确或目标站点是否可访问。'
  }

  if (normalizedMessage.includes('err_connection_refused')) {
    return '目标站点拒绝连接，请确认该链接当前允许访问。'
  }

  if (
    normalizedMessage.includes('timeout') ||
    normalizedMessage.includes('timed out')
  ) {
    return '访问超时，目标页面响应过慢或当前网络不可用。'
  }

  if (
    normalizedMessage.includes('cert') ||
    normalizedMessage.includes('ssl')
  ) {
    return '目标站点的证书校验失败，当前无法安全抓取。'
  }

  if (normalizedMessage.includes('net::err_abort')) {
    return '页面加载被中断，请稍后重试。'
  }

  return rawMessage
}

export async function readJsonBody(request, maxBytes = 32 * 1024) {
  const chunks = []
  let totalBytes = 0

  for await (const chunk of request) {
    totalBytes += chunk.length

    if (totalBytes > maxBytes) {
      throw new HttpError(413, '请求体过大，请减少请求内容后重试。')
    }

    chunks.push(chunk)
  }

  if (chunks.length === 0) {
    return {}
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, '请求体不是有效的 JSON。')
  }
}

export function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

export function writeError(response, error) {
  const statusCode = error instanceof HttpError ? error.statusCode : 500
  const message =
    error instanceof Error ? error.message : '服务内部错误，请稍后重试。'

  writeJson(response, statusCode, {
    message,
  })
}

export function setCorsHeaders(response, requestOrigin, allowedOrigins = ['*']) {
  if (allowedOrigins.includes('*')) {
    response.setHeader('Access-Control-Allow-Origin', '*')
  } else if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    response.setHeader('Access-Control-Allow-Origin', requestOrigin)
    response.setHeader('Vary', 'Origin')
  }

  response.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Page-Capture-Key',
  )
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
}

export function createPublicFileUrl(baseUrl, jobId, fileName) {
  return `${baseUrl}/artifacts/${encodeURIComponent(jobId)}/${encodeURIComponent(fileName)}`
}

export function sleep(durationMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Capture aborted'))
      return
    }

    const timer = setTimeout(resolve, durationMs)

    if (!signal) {
      return
    }

    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('Capture aborted'))
      },
      { once: true },
    )
  })
}

export function createStateHash(buffers) {
  const hash = crypto.createHash('sha1')

  for (const buffer of buffers) {
    hash.update(buffer)
  }

  return hash.digest('hex')
}

export function createJobId() {
  return crypto.randomUUID()
}

export function sanitizeFilePart(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}

export function assertNotAborted(signal) {
  if (signal?.aborted) {
    throw new Error('Capture aborted')
  }
}

export function isAbortError(error) {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()

  return message.includes('capture aborted') || message.includes('aborted')
}

export function summarizeInteractionName(label, fallbackPrefix, index) {
  if (label && label.trim().length > 0) {
    return label.trim()
  }

  return `${fallbackPrefix} ${index + 1}`
}

export function isConstantTimeEqual(leftValue, rightValue) {
  const left = Buffer.from(leftValue)
  const right = Buffer.from(rightValue)

  if (left.length !== right.length) {
    return false
  }

  return crypto.timingSafeEqual(left, right)
}

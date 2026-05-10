import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { URL } from 'node:url'

import {
  API_KEY,
  ARTIFACTS_ROOT,
  CLEANUP_INTERVAL_MS,
  CORS_ALLOWED_ORIGINS,
  MAX_REQUEST_BODY_BYTES,
  PUBLIC_BASE_URL,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
  SERVICE_HOST,
  SERVICE_PORT,
} from './config.mjs'
import { CaptureService } from './capture-service.mjs'
import {
  ensureDirectory,
  HttpError,
  isConstantTimeEqual,
  readJsonBody,
  setCorsHeaders,
  writeError,
  writeJson,
} from './utils.mjs'

await ensureDirectory(ARTIFACTS_ROOT)

const captureService = new CaptureService({
  baseUrl: PUBLIC_BASE_URL,
})
const rateLimitBuckets = new Map()

const server = http.createServer(async (request, response) => {
  setCorsHeaders(response, request.headers.origin, CORS_ALLOWED_ORIGINS)

  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    response.end()
    return
  }

  const requestUrl = new URL(
    request.url || '/',
    `http://${request.headers.host || `${SERVICE_HOST}:${SERVICE_PORT}`}`,
  )

  try {
    enforceRateLimit(request, requestUrl)

    if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
      writeJson(response, 200, await captureService.health())
      return
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/validate') {
      ensureAuthorized(request)
      const body = await readJsonBody(request, MAX_REQUEST_BODY_BYTES)
      writeJson(response, 200, await captureService.validateUrl(body.url))
      return
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/capture') {
      ensureAuthorized(request)
      const body = await readJsonBody(request, MAX_REQUEST_BODY_BYTES)
      writeJson(response, 202, await captureService.startCapture(body.url))
      return
    }

    if (request.method === 'GET' && requestUrl.pathname.startsWith('/api/jobs/')) {
      ensureAuthorized(request)
      const parts = requestUrl.pathname.split('/')
      const jobId = parts[3]
      const snapshot = captureService.getJob(jobId)

      if (!snapshot) {
        writeJson(response, 404, {
          message: '任务不存在或已过期。',
        })
        return
      }

      writeJson(response, 200, snapshot)
      return
    }

    if (
      request.method === 'POST' &&
      requestUrl.pathname.startsWith('/api/jobs/') &&
      requestUrl.pathname.endsWith('/stop')
    ) {
      ensureAuthorized(request)
      const parts = requestUrl.pathname.split('/')
      const jobId = parts[3]
      const snapshot = captureService.stopJob(jobId)

      if (!snapshot) {
        writeJson(response, 404, {
          message: '任务不存在或已过期。',
        })
        return
      }

      writeJson(response, 200, snapshot)
      return
    }

    if (request.method === 'GET' && requestUrl.pathname.startsWith('/artifacts/')) {
      const [, , jobId, ...restParts] = requestUrl.pathname.split('/')
      const fileName = restParts.join('/')
      const resolvedPath = path.resolve(
        ARTIFACTS_ROOT,
        jobId,
        decodeURIComponent(fileName),
      )
      const allowedRoot = path.resolve(ARTIFACTS_ROOT, jobId)

      if (!isPathInside(resolvedPath, allowedRoot)) {
        writeJson(response, 400, {
          message: '无效的文件路径。',
        })
        return
      }

      const fileBuffer = await fs.readFile(resolvedPath)
      response.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
      })
      response.end(fileBuffer)
      return
    }

    writeJson(response, 404, {
      message: '未找到请求的接口。',
    })
  } catch (error) {
    writeError(response, error)
  }
})

const cleanupTimer = setInterval(() => {
  captureService.cleanupExpiredJobs().catch((error) => {
    console.error('清理过期任务失败：', error)
  })
}, CLEANUP_INTERVAL_MS)

server.listen(SERVICE_PORT, SERVICE_HOST, () => {
  console.log(`竞品页面捕捉器抓取服务已启动：http://${SERVICE_HOST}:${SERVICE_PORT}`)
  console.log(`公开访问基准地址：${PUBLIC_BASE_URL}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    clearInterval(cleanupTimer)
    server.close()
    await captureService.dispose()
    process.exit(0)
  })
}

function ensureAuthorized(request) {
  if (!API_KEY) {
    return
  }

  const authHeader = request.headers.authorization || ''
  const tokenFromAuth = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length)
    : ''
  const tokenFromHeader = request.headers['x-page-capture-key'] || ''
  const token = Array.isArray(tokenFromHeader) ? tokenFromHeader[0] : tokenFromHeader
  const suppliedToken = token || tokenFromAuth

  if (!suppliedToken) {
    throw new HttpError(401, '缺少访问令牌。')
  }

  if (!isConstantTimeEqual(String(suppliedToken), API_KEY)) {
    throw new HttpError(403, '访问令牌无效。')
  }
}

function isPathInside(childPath, parentPath) {
  const relativePath = path.relative(parentPath, childPath)

  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  )
}

function enforceRateLimit(request, requestUrl) {
  if (!requestUrl.pathname.startsWith('/api/')) {
    return
  }

  const now = Date.now()
  const clientKey = getClientKey(request)
  const bucket = rateLimitBuckets.get(clientKey) || []
  const recentRequests = bucket.filter(
    (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
  )

  if (recentRequests.length >= RATE_LIMIT_MAX_REQUESTS) {
    rateLimitBuckets.set(clientKey, recentRequests)
    throw new HttpError(429, '请求过于频繁，请稍后再试。')
  }

  recentRequests.push(now)
  rateLimitBuckets.set(clientKey, recentRequests)
}

function getClientKey(request) {
  const forwardedFor = request.headers['x-forwarded-for']
  const forwardedIp = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : forwardedFor?.split(',')[0]

  return forwardedIp?.trim() || request.socket.remoteAddress || 'unknown'
}

import path from 'node:path'

function readNumberEnv(name, fallback) {
  const rawValue = process.env[name]
  const value = Number(rawValue)

  return Number.isFinite(value) && value > 0 ? value : fallback
}

function readListEnv(name, fallback = []) {
  const rawValue = process.env[name]

  if (!rawValue) {
    return fallback
  }

  return rawValue
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

export const SERVICE_HOST = process.env.PAGE_CAPTURE_HOST || '0.0.0.0'
export const SERVICE_PORT = readNumberEnv('PORT', 3845)
const RAILWAY_PUBLIC_BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : ''
export const PUBLIC_BASE_URL =
  process.env.PAGE_CAPTURE_PUBLIC_BASE_URL ||
  RAILWAY_PUBLIC_BASE_URL ||
  `http://localhost:${SERVICE_PORT}`

export const API_KEY = process.env.PAGE_CAPTURE_API_KEY || ''
export const CORS_ALLOWED_ORIGINS = readListEnv('PAGE_CAPTURE_ALLOWED_ORIGINS', [
  '*',
])
export const MAX_REQUEST_BODY_BYTES = readNumberEnv(
  'PAGE_CAPTURE_MAX_REQUEST_BODY_BYTES',
  32 * 1024,
)
export const RATE_LIMIT_WINDOW_MS = readNumberEnv(
  'PAGE_CAPTURE_RATE_LIMIT_WINDOW_MS',
  60 * 1000,
)
export const RATE_LIMIT_MAX_REQUESTS = readNumberEnv(
  'PAGE_CAPTURE_RATE_LIMIT_MAX_REQUESTS',
  120,
)

export const VIEWPORT = {
  width: 1440,
  height: 960,
}

export const CAPTURE_SEGMENT_HEIGHT = 3200
export const MAX_CAPTURE_PAGE_HEIGHT = readNumberEnv(
  'PAGE_CAPTURE_MAX_PAGE_HEIGHT',
  24000,
)
export const NAVIGATION_TIMEOUT_MS = 15000
export const VALIDATION_TIMEOUT_MS = 12000
export const INTERACTION_WAIT_MS = 1500
export const MAX_INTERACTIVE_ELEMENTS = 120
export const ARTIFACTS_ROOT = path.resolve(process.cwd(), '.capture-artifacts')
export const JOB_RETENTION_MS = readNumberEnv(
  'PAGE_CAPTURE_JOB_RETENTION_MS',
  60 * 60 * 1000,
)
export const CLEANUP_INTERVAL_MS = readNumberEnv(
  'PAGE_CAPTURE_CLEANUP_INTERVAL_MS',
  5 * 60 * 1000,
)
export const MAX_RUNNING_JOBS = readNumberEnv('PAGE_CAPTURE_MAX_RUNNING_JOBS', 2)
export const MAX_QUEUED_JOBS = readNumberEnv('PAGE_CAPTURE_MAX_QUEUED_JOBS', 20)
export const ALLOW_PRIVATE_TARGETS =
  process.env.PAGE_CAPTURE_ALLOW_PRIVATE_TARGETS === 'true'

export const BROWSER_EXECUTABLE_CANDIDATES = [
  process.env.PAGE_CAPTURE_BROWSER_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean)

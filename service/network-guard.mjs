import dns from 'node:dns/promises'
import net from 'node:net'

import { normalizeUrl } from './utils.mjs'

export function createNetworkGuard({ allowPrivateTargets = false } = {}) {
  const hostSafetyCache = new Map()

  async function normalizeAndValidateUrl(rawUrl) {
    const normalizedUrl = normalizeUrl(rawUrl)
    await assertSafeFinalUrl(normalizedUrl)

    return normalizedUrl
  }

  async function assertSafeFinalUrl(rawUrl) {
    if (allowPrivateTargets) {
      return
    }

    const parsedUrl = new URL(rawUrl)

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('仅支持抓取 http 或 https 链接。')
    }

    if (!(await isPublicHost(parsedUrl.hostname))) {
      throw new Error('出于安全原因，公网服务不允许抓取本机、内网或保留网段地址。')
    }
  }

  async function isRequestAllowed(rawUrl) {
    if (allowPrivateTargets) {
      return true
    }

    let parsedUrl

    try {
      parsedUrl = new URL(rawUrl)
    } catch {
      return false
    }

    if (['about:', 'blob:', 'data:'].includes(parsedUrl.protocol)) {
      return true
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return false
    }

    return isPublicHost(parsedUrl.hostname)
  }

  async function isPublicHost(hostname) {
    const normalizedHostname = normalizeHostname(hostname)

    if (isPrivateHostname(normalizedHostname)) {
      return false
    }

    if (!hostSafetyCache.has(normalizedHostname)) {
      hostSafetyCache.set(normalizedHostname, resolvePublicHost(normalizedHostname))
    }

    return hostSafetyCache.get(normalizedHostname)
  }

  return {
    normalizeAndValidateUrl,
    assertSafeFinalUrl,
    isRequestAllowed,
  }
}

async function resolvePublicHost(hostname) {
  const directIpVersion = net.isIP(hostname)

  if (directIpVersion !== 0) {
    return isPublicAddress(hostname)
  }

  const records = await dns.lookup(hostname, {
    all: true,
    verbatim: false,
  })

  if (records.length === 0) {
    return false
  }

  return records.every((record) => isPublicAddress(record.address))
}

function normalizeHostname(hostname) {
  return hostname.replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '').toLowerCase()
}

function isPrivateHostname(hostname) {
  return hostname === 'localhost' || hostname.endsWith('.localhost')
}

function isPublicAddress(address) {
  const ipVersion = net.isIP(address)

  if (ipVersion === 4) {
    return isPublicIpv4(address)
  }

  if (ipVersion === 6) {
    return isPublicIpv6(address)
  }

  return false
}

function isPublicIpv4(address) {
  const parts = address.split('.').map((part) => Number(part))

  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false
  }

  const [first, second] = parts

  if (first === 0 || first === 10 || first === 127) return false
  if (first === 100 && second >= 64 && second <= 127) return false
  if (first === 169 && second === 254) return false
  if (first === 172 && second >= 16 && second <= 31) return false
  if (first === 192 && second === 168) return false
  if (first === 198 && (second === 18 || second === 19)) return false
  if (first >= 224) return false

  return true
}

function isPublicIpv6(address) {
  const normalizedAddress = address.toLowerCase()

  if (normalizedAddress === '::' || normalizedAddress === '::1') {
    return false
  }

  if (normalizedAddress.startsWith('::ffff:')) {
    const mappedIpv4 = normalizedAddress.slice('::ffff:'.length)
    return isPublicIpv4(mappedIpv4)
  }

  return !(
    normalizedAddress.startsWith('fc') ||
    normalizedAddress.startsWith('fd') ||
    /^fe[89ab]/.test(normalizedAddress) ||
    normalizedAddress.startsWith('ff')
  )
}

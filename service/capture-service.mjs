import fs from 'node:fs/promises'
import path from 'node:path'

import {
  ALLOW_PRIVATE_TARGETS,
  ARTIFACTS_ROOT,
  CAPTURE_SEGMENT_HEIGHT,
  INTERACTION_WAIT_MS,
  JOB_RETENTION_MS,
  MAX_CAPTURE_PAGE_HEIGHT,
  MAX_INTERACTIVE_ELEMENTS,
  MAX_QUEUED_JOBS,
  MAX_RUNNING_JOBS,
  NAVIGATION_TIMEOUT_MS,
  VALIDATION_TIMEOUT_MS,
  VIEWPORT,
} from './config.mjs'
import { getBrowser, disposeBrowser, resolveBrowserExecutable } from './browser.mjs'
import { discoverInteractivePoints } from './interactive.mjs'
import { createNetworkGuard } from './network-guard.mjs'
import {
  assertNotAborted,
  createJobId,
  createPublicFileUrl,
  createStateHash,
  ensureDirectory,
  explainErrorInChinese,
  HttpError,
  isAbortError,
  sanitizeFilePart,
  sleep,
  summarizeInteractionName,
} from './utils.mjs'

export class CaptureService {
  constructor({ baseUrl }) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.jobs = new Map()
    this.queue = []
    this.runningJobs = 0
    this.networkGuard = createNetworkGuard({
      allowPrivateTargets: ALLOW_PRIVATE_TARGETS,
    })
  }

  async health() {
    return {
      ok: true,
      message: '抓取服务运行中。',
      browserExecutable: resolveBrowserExecutable() || 'playwright-managed',
      limits: {
        maxRunningJobs: MAX_RUNNING_JOBS,
        maxQueuedJobs: MAX_QUEUED_JOBS,
        maxInteractiveElements: MAX_INTERACTIVE_ELEMENTS,
        maxCapturePageHeight: MAX_CAPTURE_PAGE_HEIGHT,
        allowPrivateTargets: ALLOW_PRIVATE_TARGETS,
      },
      queue: {
        running: this.runningJobs,
        queued: this.queue.length,
        totalJobs: this.jobs.size,
      },
    }
  }

  async validateUrl(rawUrl) {
    let normalizedUrl = ''
    let context = null
    let page = null

    try {
      normalizedUrl = await this.networkGuard.normalizeAndValidateUrl(rawUrl)
      const browser = await getBrowser()
      context = await browser.newContext({ viewport: VIEWPORT })
      await configureContext(context, this.networkGuard)
      page = await context.newPage()
      configurePage(page)

      const response = await page.goto(normalizedUrl, {
        waitUntil: 'domcontentloaded',
        timeout: VALIDATION_TIMEOUT_MS,
      })

      await settlePage(page)
      await this.networkGuard.assertSafeFinalUrl(page.url())

      const status = response?.status() ?? 200

      if (status >= 400) {
        return {
          ok: false,
          normalizedUrl,
          message: `目标页面返回了 HTTP ${status}，当前无法继续抓取。`,
        }
      }

      return {
        ok: true,
        normalizedUrl: page.url(),
        message: `链接可访问，已就绪：${page.url()}`,
      }
    } catch (error) {
      return {
        ok: false,
        normalizedUrl,
        message: explainErrorInChinese(error),
      }
    } finally {
      await page?.close().catch(() => {})
      await context?.close().catch(() => {})
    }
  }

  async startCapture(rawUrl) {
    if (this.queue.length >= MAX_QUEUED_JOBS) {
      throw new HttpError(429, '当前抓取队列已满，请稍后再试。')
    }

    let normalizedUrl

    try {
      normalizedUrl = await this.networkGuard.normalizeAndValidateUrl(rawUrl)
    } catch (error) {
      throw new HttpError(400, explainErrorInChinese(error))
    }
    const jobId = createJobId()
    const artifactDirectory = path.join(ARTIFACTS_ROOT, jobId)
    const controller = new AbortController()

    await ensureDirectory(artifactDirectory)

    const job = {
      id: jobId,
      url: normalizedUrl,
      status: 'queued',
      message: '任务已进入队列，等待抓取资源。',
      startedAt: new Date().toISOString(),
      finishedAt: '',
      artifactDirectory,
      controller,
      progress: {
        current: 0,
        total: 0,
      },
      items: [],
      knownVisualStates: new Set(),
    }

    this.jobs.set(jobId, job)
    this.queue.push(jobId)
    this.dispatchQueue()

    return this.toSnapshot(job)
  }

  getJob(jobId) {
    const job = this.jobs.get(jobId)
    return job ? this.toSnapshot(job) : null
  }

  stopJob(jobId) {
    const job = this.jobs.get(jobId)

    if (!job) {
      return null
    }

    if (job.status === 'queued') {
      this.queue = this.queue.filter((queuedJobId) => queuedJobId !== jobId)
      job.status = 'stopped'
      job.message = '任务已在队列中停止。'
      job.finishedAt = new Date().toISOString()
      return this.toSnapshot(job)
    }

    if (job.status === 'running') {
      job.status = 'stopping'
      job.message = '正在停止抓取任务...'
      job.controller.abort()
    }

    return this.toSnapshot(job)
  }

  async cleanupExpiredJobs(now = Date.now()) {
    const deletionTasks = []

    for (const [jobId, job] of this.jobs.entries()) {
      if (!job.finishedAt) {
        continue
      }

      const finishedAt = Date.parse(job.finishedAt)

      if (!Number.isFinite(finishedAt) || now - finishedAt < JOB_RETENTION_MS) {
        continue
      }

      this.jobs.delete(jobId)
      deletionTasks.push(
        fs.rm(job.artifactDirectory, { recursive: true, force: true }),
      )
    }

    await Promise.allSettled(deletionTasks)
  }

  async dispose() {
    for (const job of this.jobs.values()) {
      job.controller.abort()
    }

    await disposeBrowser()
  }

  toSnapshot(job) {
    return {
      id: job.id,
      status: job.status,
      message: job.message,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      progress: job.progress,
      queuePosition: job.status === 'queued' ? this.queue.indexOf(job.id) + 1 : 0,
      items: job.items,
    }
  }

  dispatchQueue() {
    while (this.runningJobs < MAX_RUNNING_JOBS && this.queue.length > 0) {
      const jobId = this.queue.shift()
      const job = this.jobs.get(jobId)

      if (!job || job.status !== 'queued') {
        continue
      }

      this.runningJobs += 1
      job.status = 'running'
      job.message = '正在初始化浏览器抓取任务...'

      this.runCaptureJob(job)
        .catch((error) => {
          job.status = isAbortError(error) ? 'stopped' : 'failed'
          job.message = isAbortError(error)
            ? '抓取任务已停止。'
            : explainErrorInChinese(error)
          job.finishedAt = new Date().toISOString()
        })
        .finally(() => {
          this.runningJobs -= 1
          this.dispatchQueue()
        })
    }
  }

  async runCaptureJob(job) {
    const browser = await getBrowser()
    const context = await browser.newContext({ viewport: VIEWPORT })
    await configureContext(context, this.networkGuard)
    const landingPage = await context.newPage()

    configurePage(landingPage)

    try {
      job.message = '正在打开目标页面...'
      await landingPage.goto(job.url, {
        waitUntil: 'domcontentloaded',
        timeout: NAVIGATION_TIMEOUT_MS,
      })
      await settlePage(landingPage, job.controller.signal)
      await this.networkGuard.assertSafeFinalUrl(landingPage.url())

      const landingCapture = await captureVisualState({
        job,
        targetPage: landingPage,
        filePrefix: 'landing',
        itemName: '落地页',
        summary: '目标页面的初始落地页截图。',
        captureKind: 'landing',
        sourceUrl: job.url,
        finalUrl: landingPage.url(),
        baseUrl: this.baseUrl,
      })

      if (landingCapture) {
        job.items.push(landingCapture)
      }

      job.message = '正在分析页面交互点...'
      const interactions = await discoverInteractivePoints(
        landingPage,
        MAX_INTERACTIVE_ELEMENTS,
      )
      job.progress = {
        current: 1,
        total: interactions.length + 1,
      }
      job.message = `已发现 ${interactions.length} 个交互点，开始逐个捕捉。`

      await landingPage.close().catch(() => {})

      for (const interaction of interactions) {
        assertNotAborted(job.controller.signal)

        job.progress.current += 1
        job.message = `正在捕捉：${interaction.label || interaction.tagName}`

        const item = await captureInteractionState({
          context,
          interaction,
          job,
          baseUrl: this.baseUrl,
          networkGuard: this.networkGuard,
        })

        if (item) {
          job.items.push(item)
        }
      }

      job.status = 'completed'
      job.message = `抓取完成，共整理 ${job.items.length} 条结果。`
      job.finishedAt = new Date().toISOString()
    } catch (error) {
      job.status = isAbortError(error) ? 'stopped' : 'failed'
      job.message = isAbortError(error)
        ? '抓取任务已停止。'
        : explainErrorInChinese(error)
      job.finishedAt = new Date().toISOString()
    } finally {
      await landingPage.close().catch(() => {})
      await context.close().catch(() => {})
    }
  }
}

async function captureInteractionState({
  context,
  interaction,
  job,
  baseUrl,
  networkGuard,
}) {
  const sourcePage = await context.newPage()
  configurePage(sourcePage)

  try {
    const itemName = summarizeInteractionName(
      interaction.label,
      interaction.tagName === 'a' ? '链接' : '交互点',
      interaction.index,
    )

    if (interaction.href.startsWith('mailto:') || interaction.href.startsWith('tel:')) {
      return createTextOnlyItem({
        interaction,
        captureKind: 'no-change',
        sourceUrl: job.url,
        finalUrl: job.url,
        summary: `交互“${itemName}”会触发外部协议，当前版本不会直接截图。`,
      })
    }

    await sourcePage.goto(job.url, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATION_TIMEOUT_MS,
    })
    await settlePage(sourcePage, job.controller.signal)
    await networkGuard.assertSafeFinalUrl(sourcePage.url())

    const locator = sourcePage.locator(interaction.selector).first()
    const count = await locator.count()

    if (count === 0) {
      return createTextOnlyItem({
        interaction,
        captureKind: 'error',
        sourceUrl: job.url,
        finalUrl: job.url,
        summary: `未能重新定位交互点“${itemName}”。`,
      })
    }

    const popupPromise = sourcePage
      .waitForEvent('popup', {
        timeout: 6000,
      })
      .catch(() => null)

    await locator.scrollIntoViewIfNeeded().catch(() => {})
    await locator.click({ timeout: 7000 })

    const popupPage = await popupPromise
    const targetPage = popupPage || sourcePage
    configurePage(targetPage)
    await settlePage(targetPage, job.controller.signal)
    await networkGuard.assertSafeFinalUrl(targetPage.url())

    const targetUrl = targetPage.url()
    const captureKind = popupPage
      ? 'popup'
      : targetUrl !== job.url
        ? 'navigation'
        : 'state-change'

    const visualState = await captureVisualState({
      job,
      targetPage,
      filePrefix: sanitizeFilePart(`${interaction.index + 1}-${itemName}`),
      itemName,
      summary: buildInteractionSummary(itemName, captureKind, targetUrl),
      captureKind,
      sourceUrl: job.url,
      finalUrl: targetUrl,
      baseUrl,
    })

    if (popupPage && !popupPage.isClosed()) {
      await popupPage.close().catch(() => {})
    }

    if (!visualState) {
      return createTextOnlyItem({
        interaction,
        captureKind: 'no-change',
        sourceUrl: job.url,
        finalUrl: targetUrl,
        summary: `点击“${itemName}”后未检测到新的视觉状态，因此没有额外截图。`,
      })
    }

    return visualState
  } catch (error) {
    return createTextOnlyItem({
      interaction,
      captureKind: 'error',
      sourceUrl: job.url,
      finalUrl: job.url,
      summary: `点击“${summarizeInteractionName(
        interaction.label,
        '交互点',
        interaction.index,
      )}”失败：${explainErrorInChinese(error)}`,
    })
  } finally {
    await sourcePage.close().catch(() => {})
  }
}

async function captureVisualState({
  job,
  targetPage,
  filePrefix,
  itemName,
  summary,
  captureKind,
  sourceUrl,
  finalUrl,
  baseUrl,
}) {
  const screenshotArtifacts = await capturePageSegments({
    artifactDirectory: job.artifactDirectory,
    filePrefix,
    page: targetPage,
    baseUrl,
    jobId: job.id,
  })
  const visualStateKey = `${finalUrl}::${screenshotArtifacts.hash}`

  if (job.knownVisualStates.has(visualStateKey)) {
    return null
  }

  job.knownVisualStates.add(visualStateKey)

  return {
    id: createJobId(),
    name: itemName,
    summary,
    sourceUrl,
    finalUrl,
    captureKind,
    hasVisual: true,
    previewUrl: screenshotArtifacts.segments[0]?.url || '',
    segments: screenshotArtifacts.segments,
  }
}

async function capturePageSegments({
  artifactDirectory,
  filePrefix,
  page,
  baseUrl,
  jobId,
}) {
  const metrics = await page.evaluate(() => {
    const documentElement = document.documentElement
    const body = document.body

    return {
      width: Math.max(
        documentElement.clientWidth,
        documentElement.scrollWidth,
        body?.scrollWidth || 0,
      ),
      height: Math.max(
        documentElement.clientHeight,
        documentElement.scrollHeight,
        body?.scrollHeight || 0,
      ),
    }
  })

  const viewportSize = page.viewportSize() || VIEWPORT
  const width = Math.min(metrics.width, viewportSize.width)
  const height = Math.max(
    viewportSize.height,
    Math.min(metrics.height, MAX_CAPTURE_PAGE_HEIGHT),
  )
  const buffers = []
  const segments = []
  const maxScrollOffset = Math.max(height - viewportSize.height, 0)
  let offset = 0
  let segmentIndex = 1

  while (offset < height) {
    const scrollOffset = Math.min(offset, maxScrollOffset)
    const clipY = Math.max(0, offset - scrollOffset)
    const availableViewportHeight = Math.max(viewportSize.height - clipY, 0)
    const clipHeight = Math.min(
      CAPTURE_SEGMENT_HEIGHT,
      availableViewportHeight,
      height - offset,
    )

    if (clipHeight <= 0) {
      break
    }

    await page.evaluate((nextOffset) => {
      window.scrollTo(0, nextOffset)
    }, scrollOffset)
    await sleep(150)

    const fileName = `${filePrefix}-${segmentIndex}.png`
    const outputPath = path.join(artifactDirectory, fileName)
    const buffer = await page.screenshot({
      type: 'png',
      caret: 'hide',
      animations: 'disabled',
      clip: {
        x: 0,
        y: clipY,
        width,
        height: clipHeight,
      },
    })

    await fs.writeFile(outputPath, buffer)
    buffers.push(buffer)
    segments.push({
      fileName,
      width,
      height: clipHeight,
      url: createPublicFileUrl(baseUrl, jobId, fileName),
    })

    offset += clipHeight
    segmentIndex += 1
  }

  await page
    .evaluate(() => {
      window.scrollTo(0, 0)
    })
    .catch(() => {})

  return {
    hash: createStateHash(buffers),
    segments,
  }
}

function createTextOnlyItem({
  interaction,
  captureKind,
  sourceUrl,
  finalUrl,
  summary,
}) {
  return {
    id: createJobId(),
    name: summarizeInteractionName(
      interaction.label,
      interaction.tagName === 'a' ? '链接' : '交互点',
      interaction.index,
    ),
    summary,
    sourceUrl,
    finalUrl,
    captureKind,
    hasVisual: false,
    previewUrl: '',
    segments: [],
  }
}

function buildInteractionSummary(itemName, captureKind, finalUrl) {
  if (captureKind === 'popup') {
    return `点击“${itemName}”后打开了新页面：${finalUrl}`
  }

  if (captureKind === 'navigation') {
    return `点击“${itemName}”后跳转到了：${finalUrl}`
  }

  return `点击“${itemName}”后在当前页面产生了可见变化。`
}

async function configureContext(context, networkGuard) {
  await context.route('**/*', async (route) => {
    const requestUrl = route.request().url()

    try {
      if (await networkGuard.isRequestAllowed(requestUrl)) {
        await route.continue()
      } else {
        await route.abort('blockedbyclient')
      }
    } catch {
      await route.abort('blockedbyclient')
    }
  })
}

function configurePage(page) {
  page.on('dialog', async (dialog) => {
    await dialog.dismiss().catch(() => {})
  })

  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)
  page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS)
}

async function settlePage(page, signal) {
  assertNotAborted(signal)

  await page
    .waitForLoadState('networkidle', {
      timeout: 3500,
    })
    .catch(() => {})

  await page
    .addStyleTag({
      content: `
        *, *::before, *::after {
          animation: none !important;
          transition: none !important;
          scroll-behavior: auto !important;
        }
      `,
    })
    .catch(() => {})

  await sleep(INTERACTION_WAIT_MS, signal)
}

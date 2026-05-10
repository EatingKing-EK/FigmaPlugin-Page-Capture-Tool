import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'

import { BROWSER_EXECUTABLE_CANDIDATES } from './config.mjs'

let browserPromise = null

export async function getBrowser() {
  if (!browserPromise) {
    const executablePath = resolveBrowserExecutable()
    const launchOptions = {
      headless: true,
      args: [
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-setuid-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    }

    if (executablePath) {
      launchOptions.executablePath = executablePath
    }

    browserPromise = chromium.launch(launchOptions)
  }

  return browserPromise
}

export async function disposeBrowser() {
  if (!browserPromise) {
    return
  }

  const browser = await browserPromise
  browserPromise = null
  await browser.close()
}

export function resolveBrowserExecutable() {
  const executablePath = BROWSER_EXECUTABLE_CANDIDATES.find((candidate) =>
    fs.existsSync(candidate),
  )

  if (executablePath) {
    return executablePath
  }

  return resolvePlaywrightImageChromium() || undefined
}

function resolvePlaywrightImageChromium() {
  const browsersRoot = process.env.PLAYWRIGHT_BROWSERS_PATH || '/ms-playwright'

  if (!fs.existsSync(browsersRoot)) {
    return ''
  }

  const browserDirectories = fs
    .readdirSync(browsersRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('chromium'))
    .map((entry) => path.join(browsersRoot, entry.name))

  for (const browserDirectory of browserDirectories) {
    const candidatePaths = [
      path.join(browserDirectory, 'chrome-linux', 'chrome'),
      path.join(browserDirectory, 'chrome-win', 'chrome.exe'),
    ]

    const candidatePath = candidatePaths.find((candidate) => fs.existsSync(candidate))

    if (candidatePath) {
      return candidatePath
    }
  }

  return ''
}

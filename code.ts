/// <reference no-default-lib="true" />
/// <reference lib="es2020" />
/// <reference types="@figma/plugin-typings" />

const PLUGIN_WINDOW_SIZE = {
  width: 460,
  height: 760,
}

type ResizeUiMessage = {
  type: 'resize-ui'
  width: number
  height: number
}

type ImportSegment = {
  bytes: ArrayBuffer | Uint8Array
  width: number
  height: number
  fileName: string
}

type ImportItem = {
  id: string
  name: string
  summary: string
  sourceUrl: string
  finalUrl: string
  captureKind: string
  segments: ImportSegment[]
}

type ImportScreenshotsMessage = {
  type: 'import-screenshots'
  items: ImportItem[]
}

type CancelMessage = {
  type: 'cancel'
}

type PluginMessage = ResizeUiMessage | ImportScreenshotsMessage | CancelMessage

figma.showUI(__html__, {
  width: PLUGIN_WINDOW_SIZE.width,
  height: PLUGIN_WINDOW_SIZE.height,
  themeColors: true,
})

figma.ui.onmessage = (message: PluginMessage) => {
  if (message.type === 'resize-ui') {
    figma.ui.resize(message.width, message.height)
    return
  }

  if (message.type === 'cancel') {
    figma.closePlugin()
    return
  }

  if (message.type === 'import-screenshots') {
    try {
      const importedNodes = importScreenshots(message.items)
      figma.currentPage.selection = importedNodes
      figma.viewport.scrollAndZoomIntoView(importedNodes)
      figma.closePlugin(`已导入 ${message.items.length} 组截图。`)
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message : '导入截图时发生未知错误。'
      figma.notify(`导入失败：${messageText}`, { error: true })
    }
  }
}

function importScreenshots(items: ImportItem[]): SceneNode[] {
  if (items.length === 0) {
    throw new Error('请先选择至少一张可导入的截图。')
  }

  const rootFrame = figma.createFrame()
  rootFrame.name = createRootName(items[0].sourceUrl)
  rootFrame.layoutMode = 'VERTICAL'
  rootFrame.primaryAxisSizingMode = 'AUTO'
  rootFrame.counterAxisSizingMode = 'AUTO'
  rootFrame.itemSpacing = 32
  rootFrame.paddingTop = 24
  rootFrame.paddingRight = 24
  rootFrame.paddingBottom = 24
  rootFrame.paddingLeft = 24
  rootFrame.cornerRadius = 20
  rootFrame.clipsContent = false
  rootFrame.fills = [
    {
      type: 'SOLID',
      color: {
        r: 0.973,
        g: 0.976,
        b: 0.984,
      },
    },
  ]
  rootFrame.strokes = [
    {
      type: 'SOLID',
      color: {
        r: 0.867,
        g: 0.886,
        b: 0.922,
      },
    },
  ]
  rootFrame.strokeWeight = 1

  for (const item of items) {
    rootFrame.appendChild(createCaptureFrame(item))
  }

  figma.currentPage.appendChild(rootFrame)
  centerNodeInViewport(rootFrame)

  return [rootFrame]
}

function createCaptureFrame(item: ImportItem): FrameNode {
  const captureFrame = figma.createFrame()
  captureFrame.name = `${item.name} / ${item.captureKind}`
  captureFrame.layoutMode = 'VERTICAL'
  captureFrame.primaryAxisSizingMode = 'AUTO'
  captureFrame.counterAxisSizingMode = 'AUTO'
  captureFrame.itemSpacing = 16
  captureFrame.paddingTop = 20
  captureFrame.paddingRight = 20
  captureFrame.paddingBottom = 20
  captureFrame.paddingLeft = 20
  captureFrame.cornerRadius = 16
  captureFrame.clipsContent = false
  captureFrame.fills = [
    {
      type: 'SOLID',
      color: {
        r: 1,
        g: 1,
        b: 1,
      },
    },
  ]
  captureFrame.strokes = [
    {
      type: 'SOLID',
      color: {
        r: 0.878,
        g: 0.898,
        b: 0.933,
      },
    },
  ]
  captureFrame.strokeWeight = 1
  captureFrame.setPluginData('captureSummary', item.summary)
  captureFrame.setPluginData('sourceUrl', item.sourceUrl)
  captureFrame.setPluginData('finalUrl', item.finalUrl)
  captureFrame.setPluginData('captureKind', item.captureKind)

  for (let index = 0; index < item.segments.length; index += 1) {
    const segment = item.segments[index]
    captureFrame.appendChild(createImageNode(item.name, segment, index))
  }

  return captureFrame
}

function createImageNode(
  itemName: string,
  segment: ImportSegment,
  index: number,
): RectangleNode {
  const image = figma.createImage(normalizeBytes(segment.bytes))
  const rect = figma.createRectangle()
  const scale = segment.width > 1200 ? 1200 / segment.width : 1
  const width = Math.max(1, Math.round(segment.width * scale))
  const height = Math.max(1, Math.round(segment.height * scale))

  rect.name = `${itemName} / 段 ${index + 1}`
  rect.resize(width, height)
  rect.cornerRadius = 12
  rect.fills = [
    {
      type: 'IMAGE',
      imageHash: image.hash,
      scaleMode: 'FILL',
    },
  ]

  return rect
}

function normalizeBytes(bytes: ArrayBuffer | Uint8Array): Uint8Array {
  if (bytes instanceof Uint8Array) {
    return bytes
  }

  return new Uint8Array(bytes)
}

function createRootName(sourceUrl: string): string {
  const hostname = sourceUrl
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .trim()

  return hostname
    ? `竞品页面捕捉器 / ${hostname}`
    : '竞品页面捕捉器 / 截图导入'
}

function centerNodeInViewport(node: LayoutMixin & SceneNode): void {
  const center = figma.viewport.center
  node.x = center.x - node.width / 2
  node.y = center.y - node.height / 2
}

import { app, BrowserWindow, dialog, session, shell } from 'electron'
import path from 'node:path'
import { HarnessRuntime } from './harness-runtime.js'
import { hasSameOrigin, isAllowedExternalUrl } from './harness-output.js'
import { installBundledPlugins, prepareProfile } from './plugin-installer.js'

let mainWindow: BrowserWindow | undefined
let harness: HarnessRuntime | undefined
let harnessStartPromise: Promise<string> | undefined
let windowCreationPromise: Promise<void> | undefined
let quitting = false
const smokeTestExitAfterReady = process.argv.includes('--smoke-test-exit-after-ready')

if (process.platform === 'win32') {
  app.setAppUserModelId('com.harness.deepseek-harness-desktop')
}

function resolveWorkspace(): string {
  const markerIndex = process.argv.indexOf('--workspace')
  const cliWorkspace = markerIndex >= 0 ? process.argv[markerIndex + 1] : undefined
  const configured = cliWorkspace ?? process.env.DSH_WORKSPACE

  return configured === undefined
    ? app.getPath('documents')
    : path.resolve(configured)
}

async function ensureHarness(): Promise<string> {
  if (harness?.url !== undefined && harness.running) return harness.url
  if (harnessStartPromise !== undefined) return await harnessStartPromise

  harness = new HarnessRuntime({
    workspace: resolveWorkspace(),
    onUnexpectedExit(code, stderr) {
      if (quitting) return

      console.error(`[electron] DeepSeek Harness 意外退出，退出码 ${code}.\n${stderr}`)
      dialog.showErrorBox(
        'DeepSeek Harness 已停止',
        `后台服务意外退出，退出码 ${code}。\n${stderr}`,
      )
      app.quit()
    },
  })

  const startPromise = harness.start()
  harnessStartPromise = startPromise

  try {
    return await startPromise
  } finally {
    if (harnessStartPromise === startPromise) harnessStartPromise = undefined
  }
}

async function createMainWindow(): Promise<void> {
  const harnessUrl = await ensureHarness()
  const harnessOrigin = new URL(harnessUrl).origin

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'DeepSeek Harness Desktop',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      partition: 'persist:dsh-desktop',
    },
  })

  mainWindow = win

  win.webContents.on('will-navigate', (event, targetUrl) => {
    if (!hasSameOrigin(targetUrl, harnessOrigin)) {
      event.preventDefault()
      // 外部 HTTP(S) 链接转发到系统浏览器，而非静默阻止
      if (isAllowedExternalUrl(targetUrl)) void shell.openExternal(targetUrl)
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    if (quitting) return
    console.error(`[electron] Renderer 已停止：${details.reason}`)
    dialog.showErrorBox('页面进程已停止', `原因：${details.reason}`)
  })

  win.webContents.on('did-fail-load', (_event, code, description, targetUrl) => {
    console.error(`[electron] 页面加载失败：${code} ${description} ${targetUrl}`)
  })

  win.once('ready-to-show', () => win.show())
  win.once('closed', () => {
    if (mainWindow === win) mainWindow = undefined
  })

  await win.loadURL(harnessUrl)
}

async function ensureMainWindow(): Promise<void> {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return
  }

  if (windowCreationPromise !== undefined) return await windowCreationPromise

  const creationPromise = createMainWindow()
  windowCreationPromise = creationPromise

  try {
    await creationPromise
  } finally {
    if (windowCreationPromise === creationPromise) windowCreationPromise = undefined
  }
}

async function bootstrap(): Promise<void> {
  session.fromPartition('persist:dsh-desktop').setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  )

  // DSH 启动前预检 profile（构建脚本白名单、冲突包清理、node-pty 补丁）
  try {
    await prepareProfile()
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[electron] profile 预检失败（DSH 可能异常）：${message}`)
  }

  await ensureMainWindow()

  // 在窗口就绪后后台安装内置插件
  // 安装成功后下次启动自动加载，避免阻塞首次启动
  void (async () => {
    try {
      console.log('[electron] 正在后台检查并安装内置插件...')
      const installed = await installBundledPlugins()
      if (installed.length > 0) {
        console.log(`[electron] 内置插件已就绪: ${installed.join(', ')}`)
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[electron] 内置插件安装失败（DSH 仍可正常运行）：${message}`)
    }
  })()

  if (smokeTestExitAfterReady) {
    setTimeout(() => app.quit(), 5_000)
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!app.isReady()) return

    void ensureMainWindow().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      dialog.showErrorBox('窗口激活失败', message)
    })
  })

  app.whenReady()
    .then(bootstrap)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error)
      console.error(`[electron] 启动失败：${message}`)
      dialog.showErrorBox('DeepSeek Harness 启动失败', message)
      app.quit()
    })
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length > 0) return

  void ensureMainWindow().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox('窗口创建失败', message)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (quitting || harness === undefined || !harness.running) return

  event.preventDefault()
  quitting = true

  void harness.stop().finally(() => app.exit(0))
})

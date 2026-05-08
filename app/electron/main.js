const { app, Tray, Menu, nativeImage, Notification, clipboard, desktopCapturer, shell, BrowserWindow, ipcMain, systemPreferences } = require('electron');

// Quick check for macOS Accessibility trust. Prints `true` if the current
// running process is trusted for Accessibility; `false` otherwise.
app.whenReady().then(() => {
  try {
    const trusted = systemPreferences.isTrustedAccessibilityClient(false);
    console.log('Accessibility permission:', trusted);
  } catch (e) {
    console.error('Accessibility permission check failed:', e && e.message ? e.message : e);
  }
});
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { extractScreenText } = require('./ocr');
const { AppMonitor } = require('./app-monitor');

const APP_NAME = 'Recall';
const CAPTURE_INTERVAL_MS = Number(process.env.RECALL_CAPTURE_INTERVAL_MS || 30_000);
const CLIPBOARD_INTERVAL_MS = Number(process.env.RECALL_CLIPBOARD_INTERVAL_MS || 5_000);
const CALENDAR_INTERVAL_MS = Number(process.env.RECALL_CALENDAR_INTERVAL_MS || 15 * 60_000);
const SCREEN_CAPTURE_INTERVAL_MS = Number(process.env.RECALL_SCREEN_CAPTURE_INTERVAL_MS || 2 * 60_000);
const APP_MONITOR_INTERVAL_MS = Number(process.env.RECALL_APP_MONITOR_INTERVAL_MS || 10_000);
const SCREEN_CAPTURE_ENABLED = process.env.RECALL_SCREEN_CAPTURE !== '0';
const PYTHON_BIN = process.env.RECALL_PYTHON || 'python3';
const TRAY_ICON_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAAOElEQVR42mNgGErgPw5MsQEkGfifREy0QaTKk+UanIahS+LTOGoQFZIAVaKfqgmSalmEqpl2YAEAlkOTbRqLSw4AAAAASUVORK5CYII=';

let tray = null;
let captureTimer = null;
let clipboardTimer = null;
let calendarTimer = null;
let screenTimer = null;
let appMonitorTimer = null;
let appMonitor = null;
let lastClipboardText = '';
let testResultWindow = null;
let liveJsonWindow = null;
let liveJsonTimer = null;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showTestResultWindow(payload) {
  const detail = JSON.stringify(payload, null, 2);
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Active App Detection Result</title>
    <style>
      :root { color-scheme: light dark; }
      * {
        box-sizing: border-box;
      }
      html, body {
        margin: 0;
        padding: 0;
        height: 100%;
        width: 100%;
      }
      body {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        background: #0f172a;
        color: #e2e8f0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .wrap {
        padding: 20px;
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
      }
      h1 {
        margin: 0 0 16px;
        font-size: 14px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #93c5fd;
        flex-shrink: 0;
      }
      .content-wrapper {
        flex: 1;
        overflow: auto;
        display: flex;
      }
      pre {
        margin: 0;
        padding: 16px;
        border-radius: 8px;
        border: 1px solid #334155;
        background: #020617;
        white-space: pre-wrap;
        word-wrap: break-word;
        overflow-wrap: break-word;
        word-break: break-word;
        line-height: 1.5;
        width: 100%;
        flex: 1;
      }
      pre::-webkit-scrollbar {
        width: 8px;
        height: 8px;
      }
      pre::-webkit-scrollbar-track {
        background: #0f172a;
      }
      pre::-webkit-scrollbar-thumb {
        background: #475569;
        border-radius: 4px;
      }
      pre::-webkit-scrollbar-thumb:hover {
        background: #64748b;
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>Test active app detection result</h1>
      <div class="content-wrapper">
        <pre>${escapeHtml(detail)}</pre>
      </div>
    </div>
  </body>
</html>`;

  if (testResultWindow && !testResultWindow.isDestroyed()) {
    testResultWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);
    testResultWindow.show();
    testResultWindow.focus();
    return;
  }

  testResultWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    title: 'Active App Detection Result',
    autoHideMenuBar: true,
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
    },
  });

  testResultWindow.on('closed', () => {
    testResultWindow = null;
  });

  testResultWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);
  testResultWindow.show();
  testResultWindow.focus();
}

function showLiveJsonWindow() {
  if (liveJsonWindow && !liveJsonWindow.isDestroyed()) {
    liveJsonWindow.show();
    liveJsonWindow.focus();
    return;
  }

  liveJsonWindow = new BrowserWindow({
    width: 900,
    height: 700,
    title: 'Live App JSON',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-viewer.js'),
      contextIsolation: true,
      enableRemoteModule: false,
    },
  });

  const html = `<!doctype html><html><head><meta charset="utf-8"/><title>Live App JSON</title><style>html,body{height:100%;margin:0;font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;background:#0b1220;color:#e6eef8} .wrap{padding:16px;display:flex;flex-direction:column;height:100%} h1{margin:0 0 12px;font-size:16px;color:#93c5fd} pre{flex:1;background:#020617;border:1px solid #2b3440;padding:12px;border-radius:8px;overflow:auto;white-space:pre-wrap;word-break:break-word} .meta{font-size:12px;color:#9fb0d7;margin-bottom:8px}</style></head><body><div class="wrap"><h1>Live App JSON</h1><div class="meta">Updates every second. File source: debug-logs</div><pre id="json">Loading…</pre></div><script>const pre=document.getElementById('json');window.electronAPI.onLiveJson((payload)=>{try{pre.textContent=JSON.stringify(payload,null,2);}catch(e){pre.textContent=String(payload);} });</script></body></html>`;

  liveJsonWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);
  liveJsonWindow.show();
  liveJsonWindow.focus();

  // Start a timer to stream the latest debug JSON files
  const debugDir = path.join(recallDataDir(), 'debug-logs');

  function getLatest(prefix) {
    try {
      if (!fs.existsSync(debugDir)) return null;
      const files = fs.readdirSync(debugDir).filter((f) => f.startsWith(prefix) && f.endsWith('.json'));
      if (!files.length) return null;
      const sorted = files
        .map((f) => ({ f, m: fs.statSync(path.join(debugDir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      const chosen = sorted[0].f;
      const raw = fs.readFileSync(path.join(debugDir, chosen), 'utf8');
      return { path: path.join(debugDir, chosen), json: JSON.parse(raw) };
    } catch (e) {
      return null;
    }
  }

  if (liveJsonTimer) clearInterval(liveJsonTimer);
  liveJsonTimer = setInterval(() => {
    if (!liveJsonWindow || liveJsonWindow.isDestroyed()) return;
    const active = getLatest('app-detection-');
    const list = getLatest('app-list-');
    const payload = { timestamp: new Date().toISOString(), active: active ? active.json : null, active_path: active ? active.path : null, list: list ? list.json : null, list_path: list ? list.path : null };
    try {
      liveJsonWindow.webContents.send('live-json', payload);
    } catch (e) {
      console.debug('live-json send failed:', e && e.message ? e.message : e);
    }
  }, 1000);

  liveJsonWindow.on('closed', () => {
    liveJsonWindow = null;
    if (liveJsonTimer) {
      clearInterval(liveJsonTimer);
      liveJsonTimer = null;
    }
  });
}

function projectRoot() {
  return path.resolve(__dirname, '..', '..');
}

function recallDataDir() {
  return path.join(app.getPath('userData'), 'recall');
}

function latestBriefingPath() {
  return path.join(recallDataDir(), 'latest-briefing.txt');
}

function settingsPath() {
  return path.join(recallDataDir(), 'settings.json');
}

function screenshotsDir() {
  return path.join(recallDataDir(), 'screenshots');
}

function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function bundledRecallExecutable() {
  const executable = process.platform === 'win32' ? 'recall-ai.exe' : 'recall-ai';
  const candidates = [
    path.join(process.resourcesPath || '', 'python', executable),
    path.join(projectRoot(), 'dist-python', executable),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

function ensureSettingsFile() {
  fs.mkdirSync(recallDataDir(), { recursive: true });
  if (!fs.existsSync(settingsPath())) {
    fs.writeFileSync(
      settingsPath(),
      JSON.stringify(
        {
          vision_provider: "ocr",
          openai_api_key: "",
          ollama_url: "http://127.0.0.1:11434",
          ollama_model: "llava",
          screen_capture_enabled: true,
          screen_capture_interval_minutes: 2,
        },
        null,
        2,
      ),
      'utf8',
    );
  }
}

function recallEnvironment() {
  const env = {
    ...process.env,
    RECALL_DATA_DIR: process.env.RECALL_DATA_DIR || recallDataDir(),
    PYTHONPATH: [projectRoot(), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
  };

  try {
    ensureSettingsFile();
    const settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    if (!env.OPENAI_API_KEY && settings.openai_api_key) {
      env.OPENAI_API_KEY = settings.openai_api_key;
    }
    if (settings.vision_provider) {
      env.RECALL_VISION_PROVIDER = settings.vision_provider;
    }
    if (settings.ollama_url) {
      env.RECALL_OLLAMA_URL = settings.ollama_url;
    }
    if (settings.ollama_model) {
      env.RECALL_OLLAMA_MODEL = settings.ollama_model;
    }
  } catch (error) {
    console.error('Recall settings load failed:', error.message);
  }

  return env;
}

function runRecall(args, payload = null) {
  return new Promise((resolve, reject) => {
    const recallExecutable = bundledRecallExecutable();
    const command = recallExecutable || PYTHON_BIN;
    const commandArgs = recallExecutable ? args : ['-m', 'recall_ai.cli', ...args];
    const child = spawn(command, commandArgs, {
      cwd: projectRoot(),
      env: recallEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `${PYTHON_BIN} exited with ${code}`));
      }
    });

    if (payload) {
      child.stdin.write(JSON.stringify(payload));
    }
    child.stdin.end();
  });
}

async function captureWindowActivity() {
  try {
    // Try to import active-win, but it may not be available
    let activeWin = null;
    try {
      const imported = await import('active-win');
      activeWin = imported.default || imported;
    } catch (e) {
      console.debug('active-win not available, skipping window activity capture');
      return;
    }

    if (!activeWin) {
      return;
    }

    const windowInfo = await activeWin();
    if (!windowInfo) {
      return;
    }

    await runRecall(['capture', classifyWindowKind(windowInfo)], {
      source: 'active-window',
      app_name: windowInfo.owner?.name || 'Unknown app',
      title: windowInfo.title || 'Untitled window',
      url: windowInfo.url || null,
      metadata: {
        ownerPath: windowInfo.owner?.path || null,
        platform: os.platform(),
      },
    });
  } catch (error) {
    console.debug('captureWindowActivity error:', error.message);
  }
}

function classifyWindowKind(windowInfo) {
  const appName = (windowInfo.owner?.name || '').toLowerCase();
  const title = (windowInfo.title || '').toLowerCase();
  const documentApps = [
    'word',
    'excel',
    'powerpoint',
    'pages',
    'numbers',
    'keynote',
    'docs',
    'notion',
    'obsidian',
  ];
  const documentExtensions = ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.pdf', '.md', '.txt'];

  if (
    documentApps.some((name) => appName.includes(name)) ||
    documentExtensions.some((extension) => title.includes(extension))
  ) {
    return 'document';
  }

  return 'window';
}

async function captureClipboardActivity() {
  try {
    const text = clipboard.readText();
    if (!text || text === lastClipboardText) {
      return;
    }

    lastClipboardText = text;
    await runRecall(['capture', 'clipboard'], {
      source: 'clipboard',
      title: 'Clipboard update',
      content: text,
      metadata: {
        length: text.length,
      },
    });
  } catch (error) {
    console.error('Recall clipboard capture failed:', error.message);
  }
}

async function captureCalendarActivity() {
  const calendarPath = process.env.RECALL_CALENDAR_PATH;
  if (!calendarPath) {
    return;
  }

  try {
    await runRecall(['import-calendar', calendarPath]);
  } catch (error) {
    console.error('Recall calendar ingest failed:', error.message);
  }
}

async function captureScreenActivity({ notify = false } = {}) {
  if (!SCREEN_CAPTURE_ENABLED) {
    return;
  }

  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1440, height: 900 },
    });
    const source = sources[0];
    if (!source || source.thumbnail.isEmpty()) {
      throw new Error('No screen thumbnail was available. Screen Recording permission may be required.');
    }

    fs.mkdirSync(screenshotsDir(), { recursive: true });
    const screenshotPath = path.join(screenshotsDir(), `screen-${timestampForFilename()}.png`);
    fs.writeFileSync(screenshotPath, source.thumbnail.toPNG());

    const screenText = await extractScreenText(screenshotPath);
    const summary = await runRecall(['capture-screen', screenshotPath], {
      screen_text: screenText,
    });
    if (notify) {
      new Notification({
        title: 'Recall captured your screen',
        body: summary ? summary.slice(0, 180) : 'Saved a local screenshot for the next briefing.',
      }).show();
    }
  } catch (error) {
    console.error('Recall screen capture failed:', error.message);
    if (notify) {
      new Notification({
        title: 'Recall screen capture failed',
        body: `${error.message}. On macOS, enable Screen Recording for Recall in Privacy & Security.`,
      }).show();
    }
  }
}

async function generateBriefing() {
  try {
    const briefing = await runRecall(['briefing']);
    if (!briefing) {
      return;
    }

    fs.mkdirSync(recallDataDir(), { recursive: true });
    fs.writeFileSync(latestBriefingPath(), `${briefing}\n`, 'utf8');
    await shell.openPath(latestBriefingPath());

    new Notification({
      title: 'Recall morning briefing',
      body: briefing.length > 180 ? `${briefing.slice(0, 177)}...` : briefing,
    }).show();
  } catch (error) {
    console.error('Recall briefing failed:', error.message);
  }
}

async function openLatestBriefing() {
  const briefingPath = latestBriefingPath();
  if (!fs.existsSync(briefingPath)) {
    new Notification({
      title: 'Recall',
      body: 'No readable briefing exists yet. Choose Generate and open briefing first.',
    }).show();
    return;
  }
  await shell.openPath(briefingPath);
}

async function openSettingsFile() {
  ensureSettingsFile();
  await shell.openPath(settingsPath());
}

async function openViewerWindow() {
  const viewerWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload-viewer.js'),
      contextIsolation: true,
      enableRemoteModule: false,
    },
  });

  viewerWindow.loadFile(path.join(__dirname, 'viewer.html'));
}

async function getBriefingForIPC() {
  const briefingPath = latestBriefingPath();
  if (!fs.existsSync(briefingPath)) {
    return null;
  }
  return fs.readFileSync(briefingPath, 'utf8');
}

async function getActivitiesForIPC() {
  try {
    const queryResult = await runRecall(['query-activities']);
    if (!queryResult) {
      return [];
    }
    try {
      return JSON.parse(queryResult);
    } catch (e) {
      console.error('Failed to parse activities JSON:', e);
      return [];
    }
  } catch (error) {
    console.error('Failed to get activities:', error);
    return [];
  }
}

function createTray() {
  const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG, 'base64'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip(`${APP_NAME} is capturing local work context`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Generate and open briefing',
        click: generateBriefing,
      },
      {
        label: 'Open latest briefing',
        click: openLatestBriefing,
      },
      {
        label: 'Capture screen now',
        click: () => captureScreenActivity({ notify: true }),
      },
      {
        label: 'Snapshot open apps',
        click: async () => {
          try {
            if (!appMonitor) {
              new Notification({ title: APP_NAME, body: 'App monitor not initialized.' }).show();
              return;
            }
            const result = await appMonitor.logAppList();
            const parsed = result ? result.trim() : '';
            new Notification({ title: APP_NAME, body: parsed ? 'Open apps snapshot saved.' : 'Snapshot completed.' }).show();
          } catch (e) {
            new Notification({ title: APP_NAME, body: `Snapshot failed: ${e.message}` }).show();
          }
        },
      },
      {
        label: 'Live JSON viewer',
        click: async () => {
          try {
            showLiveJsonWindow();
          } catch (e) {
            new Notification({ title: APP_NAME, body: `Live viewer failed: ${e.message}` }).show();
          }
        },
      },
      {
        label: 'Test active app detection',
        click: async () => {
          try {
            if (!appMonitor) {
              new Notification({ title: APP_NAME, body: 'App monitor not initialized.' }).show();
              return;
            }
            const app = await appMonitor.getActiveApp();
            const out = {
              timestamp: new Date().toISOString(),
              activeApp: app,
              detected: app !== null,
              note: app ? 'Active app detection is working.' : 'Could not detect active app. Check System Preferences > Security & Privacy > Accessibility.',
            };

            showTestResultWindow(out);
          } catch (e) {
            new Notification({ title: APP_NAME, body: `Test failed: ${e.message}` }).show();
          }
        },
      },
      {
        label: 'Debug capture',
        click: async () => {
          try {
            if (!appMonitor) {
              new Notification({ title: APP_NAME, body: 'App monitor not initialized.' }).show();
              return;
            }
            const apps = await appMonitor.listOpenApps();
            let activities = [];
            try {
              const q = await runRecall(['query-activities']);
              activities = q ? JSON.parse(q) : [];
            } catch (err) {
              console.error('Query activities failed:', err.message);
            }

            const out = {
              timestamp: new Date().toISOString(),
              apps: apps,
              activities_count: activities.length,
              activities: activities.slice(0, 200),
            };

            fs.mkdirSync(recallDataDir(), { recursive: true });
            const outPath = path.join(recallDataDir(), `debug-capture-${timestampForFilename()}.json`);
            fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
            await shell.openPath(outPath);
            new Notification({ title: APP_NAME, body: `Debug capture saved (${activities.length} activities).` }).show();
          } catch (e) {
            new Notification({ title: APP_NAME, body: `Debug capture failed: ${e.message}` }).show();
          }
        },
      },
      {
        label: 'Open settings',
        click: openSettingsFile,
      },
      {
        label: 'View briefing & activities',
        click: openViewerWindow,
      },
      {
        label: 'Open local data folder (advanced)',
        click: () => shell.openPath(recallDataDir()),
      },
      { type: 'separator' },
      {
        label: 'Quit Recall',
        click: () => app.quit(),
      },
    ]),
  );
}

async function startBackgroundCapture() {
  ensureSettingsFile();
  await runRecall(['init-db']);
  await captureWindowActivity();
  await captureClipboardActivity();
  await captureCalendarActivity();
  await captureScreenActivity();

  captureTimer = setInterval(captureWindowActivity, CAPTURE_INTERVAL_MS);
  clipboardTimer = setInterval(captureClipboardActivity, CLIPBOARD_INTERVAL_MS);
  calendarTimer = setInterval(captureCalendarActivity, CALENDAR_INTERVAL_MS);
  screenTimer = setInterval(captureScreenActivity, SCREEN_CAPTURE_INTERVAL_MS);

  // Start app activity monitor
  appMonitor = new AppMonitor(projectRoot(), recallDataDir());
  appMonitorTimer = appMonitor.startMonitoring(APP_MONITOR_INTERVAL_MS);
  console.log(`[Recall] App monitor started (interval: ${APP_MONITOR_INTERVAL_MS}ms)`);
}

// Set up IPC handlers for the viewer window
ipcMain.handle('get-briefing', getBriefingForIPC);
ipcMain.handle('get-activities', getActivitiesForIPC);

app.whenReady().then(async () => {
  app.setName(APP_NAME);
  createTray();
  await startBackgroundCapture();
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});

app.on('before-quit', () => {
  if (captureTimer) {
    clearInterval(captureTimer);
  }
  if (clipboardTimer) {
    clearInterval(clipboardTimer);
  }
  if (calendarTimer) {
    clearInterval(calendarTimer);
  }
  if (screenTimer) {
    clearInterval(screenTimer);
  }
  if (appMonitorTimer) {
    appMonitor.stopMonitoring(appMonitorTimer);
  }
});

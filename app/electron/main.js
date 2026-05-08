const { app, Tray, Menu, nativeImage, Notification, clipboard, desktopCapturer, shell, BrowserWindow, ipcMain, systemPreferences, dialog } = require('electron');

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
    const activeWin = (await import('active-win')).default;
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
    console.error('Recall window capture failed:', error.message);
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

            await dialog.showMessageBox({
              type: 'info',
              title: 'Active App Detection',
              message: 'Test active app detection result',
              detail: JSON.stringify(out, null, 2),
              buttons: ['OK'],
              noLink: true,
            });
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

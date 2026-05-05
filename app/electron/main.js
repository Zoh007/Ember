const { app, Tray, Menu, nativeImage, Notification, clipboard, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const APP_NAME = 'Recall';
const CAPTURE_INTERVAL_MS = Number(process.env.RECALL_CAPTURE_INTERVAL_MS || 30_000);
const CLIPBOARD_INTERVAL_MS = Number(process.env.RECALL_CLIPBOARD_INTERVAL_MS || 5_000);
const CALENDAR_INTERVAL_MS = Number(process.env.RECALL_CALENDAR_INTERVAL_MS || 15 * 60_000);
const PYTHON_BIN = process.env.RECALL_PYTHON || 'python3';
const TRAY_ICON_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAAOElEQVR42mNgGErgPw5MsQEkGfifREy0QaTKk+UanIahS+LTOGoQFZIAVaKfqgmSalmEqpl2YAEAlkOTbRqLSw4AAAAASUVORK5CYII=';

let tray = null;
let captureTimer = null;
let clipboardTimer = null;
let calendarTimer = null;
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

function bundledRecallExecutable() {
  const executable = process.platform === 'win32' ? 'recall-ai.exe' : 'recall-ai';
  const candidates = [
    path.join(process.resourcesPath || '', 'python', executable),
    path.join(projectRoot(), 'dist-python', executable),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

function runRecall(args, payload = null) {
  return new Promise((resolve, reject) => {
    const recallExecutable = bundledRecallExecutable();
    const command = recallExecutable || PYTHON_BIN;
    const commandArgs = recallExecutable ? args : ['-m', 'recall_ai.cli', ...args];
    const child = spawn(command, commandArgs, {
      cwd: projectRoot(),
      env: {
        ...process.env,
        RECALL_DATA_DIR: process.env.RECALL_DATA_DIR || recallDataDir(),
        PYTHONPATH: [projectRoot(), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      },
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
  await runRecall(['init-db']);
  await captureWindowActivity();
  await captureClipboardActivity();
  await captureCalendarActivity();

  captureTimer = setInterval(captureWindowActivity, CAPTURE_INTERVAL_MS);
  clipboardTimer = setInterval(captureClipboardActivity, CLIPBOARD_INTERVAL_MS);
  calendarTimer = setInterval(captureCalendarActivity, CALENDAR_INTERVAL_MS);
}

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
});

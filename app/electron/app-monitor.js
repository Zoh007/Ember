const { spawn, execFile } = require('child_process');
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');

// Lazy-loaded active-win module (dynamic import fallback for ESM)
let activeWin = null;

/**
 * Monitor the active application and log to SQLite
 */
class AppMonitor extends EventEmitter {
  constructor(projectRoot, recallDataDir) {
    super();
    this.projectRoot = projectRoot;
    this.recallDataDir = recallDataDir;
    // current active app key and session id
    this.currentAppKey = null;
    this.currentSessionId = null;
    this.recallExecutable = this._findRecallExecutable();
  }

  /**
   * Find the bundled recall-ai executable
   */
  _findRecallExecutable() {
    const executable = process.platform === 'win32' ? 'recall-ai.exe' : 'recall-ai';
    const candidates = [
      path.join(process.resourcesPath || '', 'python', executable),
      path.join(this.projectRoot, 'dist-python', executable),
    ];
    return candidates.find((candidate) => candidate && fs.existsSync(candidate));
  }

  /**
   * Get the currently focused app with detailed debug logging.
   */
  async getActiveApp() {
    const debugLog = {
      timestamp: new Date().toISOString(),
      activeWinResult: null,
      activeWinError: null,
      osascriptAppNameStdout: null,
      osascriptWindowTitleStdout: null,
      finalResult: null,
    };

    // Attempt dynamic import of `active-win` if available and not yet loaded.
    if (!activeWin) {
      try {
        const imported = await import('active-win');
        activeWin = imported.default || imported;
      } catch (e) {
        console.debug('[AppMonitor] dynamic import active-win failed:', e?.message || e);
      }
    }
    // If the native `active-win` module loaded successfully, prefer it.
    if (activeWin) {
      try {
        // Call active-win with default options. In many environments this
        // returns `{ owner: { name }, title }` which is ideal for our use.
        const win = await activeWin();
        debugLog.activeWinResult = win;
        if (win && (win.owner?.name || win.title)) {
          console.debug('[AppMonitor] active-win detected:', win.owner?.name, win.title);
          debugLog.finalResult = { name: win.owner?.name || 'Unknown', title: win.title || '' };
          this._writeDebugLog(debugLog);
          return { name: win.owner?.name || 'Unknown', title: win.title || '' };
        }
        console.debug('[AppMonitor] active-win returned no useful data');
      } catch (error) {
        debugLog.activeWinError = error && error.stack ? error.stack : String(error);
        console.warn('[AppMonitor] active-win failed, falling back to AppleScript:', error.message);
        // fall through to fallback
      }
    }

    // Fallback: macOS-only AppleScript via `osascript`. This avoids loading
    // native node modules in the packaged app and works without rebuilding.
    if (process.platform === 'darwin') {
      try {
        const getAppName = 'tell application "System Events" to get name of first application process whose frontmost is true';

        const appName = await new Promise((resolve) => {
          execFile('osascript', ['-e', getAppName], (err, stdout, stderr) => {
            debugLog.osascriptAppNameStdout = stdout.toString();
            if (err) {
              console.debug('[AppMonitor] osascript app name failed:', err.message);
              return resolve(null);
            }
            resolve(stdout.toString().trim());
          });
        });

        if (!appName) {
          console.debug('[AppMonitor] osascript returned no app name');
          this._writeDebugLog(debugLog);
          return null;
        }

        // Get window title using the app name we just retrieved
        const getWindowTitle = `
try
  tell application "${appName.replace(/"/g, '\\"')}"
    get name of front window
  end tell
on error
  return ""
end try`;

        const windowTitle = await new Promise((resolve) => {
          execFile('osascript', ['-e', getWindowTitle], (err, stdout, stderr) => {
            debugLog.osascriptWindowTitleStdout = stdout.toString();
            if (err) {
              // Window title detection might fail due to Accessibility permission
              // This is expected and acceptable; the app name is the important part
              console.debug('[AppMonitor] osascript window title failed (Accessibility permission may be needed):', err.message);
              return resolve('');
            }
            resolve(stdout.toString().trim());
          });
        });

        console.debug('[AppMonitor] osascript detected:', appName, windowTitle);
        debugLog.finalResult = { name: appName, title: windowTitle || '' };
        this._writeDebugLog(debugLog);
        return { name: appName, title: windowTitle || '' };
      } catch (error) {
        console.error('[AppMonitor] macOS fallback failed:', error.message);
        this._writeDebugLog(debugLog);
        return null;
      }
    }

    this._writeDebugLog(debugLog);
    return null;
  }

  /**
   * Write debug log for app detection (timestamps JSON to Recall data dir)
   */
  _writeDebugLog(debugLog) {
    try {
      const debugDir = path.join(this.recallDataDir, 'debug-logs');
      fs.mkdirSync(debugDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const debugPath = path.join(debugDir, `app-detection-${timestamp}.json`);
      fs.writeFileSync(debugPath, JSON.stringify(debugLog, null, 2), 'utf8');
      console.log('[AppMonitor] Debug log written to:', debugPath);
    } catch (e) {
      console.warn('[AppMonitor] Failed to write debug log:', e && e.message ? e.message : e);
    }
  }

  /**
   * Write an open-apps snapshot JSON to the debug-logs folder
   */
  _writeOpenAppsLog(openApps) {
    try {
      const debugDir = path.join(this.recallDataDir, 'debug-logs');
      fs.mkdirSync(debugDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const debugPath = path.join(debugDir, `app-list-${timestamp}.json`);
      const payload = {
        timestamp: new Date().toISOString(),
        count: Array.isArray(openApps) ? openApps.length : 0,
        apps: openApps,
      };
      fs.writeFileSync(debugPath, JSON.stringify(payload, null, 2), 'utf8');
      console.log('[AppMonitor] Open-apps snapshot written to:', debugPath);
    } catch (e) {
      console.warn('[AppMonitor] Failed to write open-apps snapshot:', e && e.message ? e.message : e);
    }
  }

  /**
   * Log app activity to SQLite database
   */
  async logAppActivity(appName, windowTitle) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        app_name: appName,
        window_title: windowTitle,
        title: windowTitle || appName,
        source: 'app-monitor',
        occurred_at: new Date().toISOString(),
      });

      const pythonPath = process.env.RECALL_PYTHON || this.recallExecutable || 'python3';
      const args = this.recallExecutable ? ['capture', 'app'] : ['-m', 'recall_ai.cli', 'capture', 'app'];

      const python = spawn(pythonPath, args, {
        cwd: this.projectRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let output = '';
      let errorOutput = '';

      python.stdout.on('data', (data) => {
        output += data.toString();
      });

      python.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      python.on('close', (code) => {
        if (code === 0) {
          resolve(output.trim());
        } else {
          reject(new Error(`App logging failed: ${errorOutput}`));
        }
      });

      python.stdin.write(payload);
      python.stdin.end();
    });
  }

  /**
   * List all open applications (cross-platform).
   * Returns an array of { name: string, windows: string[] }
   */
  async listOpenApps() {
    if (process.platform === 'darwin') {
      // macOS: use System Events via osascript
      // Get app names; window capture requires Accessibility permissions and may fail silently.
      const appleScript = `
        set outStr to ""
        tell application "System Events"
          set procs to every application process whose background only is false
          repeat with p in procs
            set appName to name of p
            set wline to appName & "::"
            try
              set wnames to name of every window of p
              if (count of wnames) > 0 then
                repeat with i from 1 to count of wnames
                  set wline to wline & (item i of wnames)
                  if i < count of wnames then set wline to wline & "||"
                end repeat
              end if
            on error errMsg
              -- Window capture failed; just use app name (no windows)
              set wline to appName & "::"
            end try
            set outStr to outStr & wline & "\n"
          end repeat
        end tell
        return outStr
      `;

      try {
        const appsRaw = await new Promise((resolve) => {
          execFile('osascript', ['-e', appleScript], (err, stdout, stderr) => {
            if (err) {
              console.warn('[AppMonitor] osascript error:', err.message);
              if (stderr) console.warn('[AppMonitor] osascript stderr:', stderr);
              return resolve('');
            }
            resolve(stdout.toString().trim());
          });
        });

        if (!appsRaw) return [];
        const lines = appsRaw.split('\n').filter(Boolean);
        const result = [];
        for (const line of lines) {
          const parts = line.split('::');
          const name = parts[0] || 'Unknown';
          const windows = parts[1] ? parts[1].split('||').filter(Boolean) : [];
          result.push({ name: name, windows: windows });
        }
        // If windows arrays are empty for some apps, try querying the app directly
        // for a front window title (less privileged, may still fail). Do this
        // sequentially to avoid spawning too many osascript processes at once.
        for (const entry of result) {
          if ((!entry.windows || entry.windows.length === 0) && entry.name) {
            try {
              const singleTitle = await new Promise((resolve) => {
                const script = `tell application "${entry.name}" to try\n set t to name of front window\n on error\n set t to ""\nend try\nreturn t`;
                execFile('osascript', ['-e', script], { timeout: 1500 }, (err, stdout, stderr) => {
                  if (err) return resolve('');
                  resolve(stdout ? stdout.toString().trim() : '');
                });
              });
              if (singleTitle) entry.windows = [singleTitle];
            } catch (e) {
              // ignore failures; leave windows empty
            }
          }
        }

        return result;
      } catch (e) {
        console.error('macOS app-list AppleScript failed:', e);
        return [];
      }
    }

    if (process.platform === 'win32') {
      // Windows: use PowerShell to list processes with MainWindowTitle
      try {
        const out = await new Promise((resolve) => {
          const ps = spawn('powershell', ['-NoProfile', '-Command', "Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object ProcessName,MainWindowTitle | ConvertTo-Json"], { timeout: 5000 });
          let stdout = '';
          ps.stdout.on('data', (d) => (stdout += d.toString()));
          ps.on('close', () => resolve(stdout));
        });
        const parsed = out ? JSON.parse(out) : [];
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        return rows.map((r) => ({ name: r.ProcessName || r.processName, windows: [r.MainWindowTitle || ''] }));
      } catch (e) {
        return [];
      }
    }

    // Linux/X11: use `wmctrl -l` if available
    if (process.platform === 'linux') {
      try {
        const out = await new Promise((resolve) => {
          const p = spawn('wmctrl', ['-l'], { timeout: 3000 });
          let stdout = '';
          p.stdout.on('data', (d) => (stdout += d.toString()));
          p.on('close', () => resolve(stdout));
        });
        const lines = out.trim().split('\n').filter(Boolean);
        const apps = {};
        for (const l of lines) {
          const parts = l.split(/\s+/).slice(3);
          const title = parts.join(' ');
          const app = title.split(' - ')[0] || title;
          apps[app] = apps[app] || new Set();
          apps[app].add(title);
        }
        return Object.keys(apps).map((k) => ({ name: k, windows: Array.from(apps[k]) }));
      } catch (e) {
        return [];
      }
    }

    return [];
  }

  /**
   * Log a snapshot of open apps to the DB via Python CLI
   */
  async logAppList() {
    try {
      const apps = await this.listOpenApps();
      const payload = JSON.stringify({
        source: 'app-monitor',
        occurred_at: new Date().toISOString(),
        apps,
      });

      const command = this.recallExecutable || 'python3';
      const args = this.recallExecutable ? ['capture', 'app-list'] : ['-m', 'recall_ai.cli', 'capture', 'app-list'];

      return await new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: this.projectRoot, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => (out += d.toString()));
        child.stderr.on('data', (d) => (err += d.toString()));
        child.on('close', (code) => {
          if (code === 0) resolve(out.trim()); else reject(new Error(err));
        });
        child.stdin.write(payload);
        child.stdin.end();
      });
    } catch (e) {
      console.error('Failed to log app list:', e);
      return null;
    }
  }

  /**
   * Start a timed session for the given app
   */
  async logSessionStart(appName, windowTitle) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        app_name: appName,
        title: windowTitle || appName,
        source: 'app-monitor',
        occurred_at: new Date().toISOString(),
        metadata: { action: 'start' },
      });

      const pythonPath = process.env.RECALL_PYTHON || this.recallExecutable || 'python3';
      const args = this.recallExecutable ? ['capture', 'session'] : ['-m', 'recall_ai.cli', 'capture', 'session'];

      const child = spawn(pythonPath, args, { cwd: this.projectRoot, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      child.stderr.on('data', (d) => (err += d.toString()));
      child.on('close', (code) => {
        if (code === 0) resolve(out.trim()); else reject(new Error(err));
      });
      child.stdin.write(payload);
      child.stdin.end();
    });
  }

  /**
   * End the current session for an app
   */
  async logSessionEnd(appName, windowTitle) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        app_name: appName,
        title: windowTitle || appName,
        source: 'app-monitor',
        occurred_at: new Date().toISOString(),
        metadata: { action: 'end' },
      });

      const pythonPath = process.env.RECALL_PYTHON || this.recallExecutable || 'python3';
      const args = this.recallExecutable ? ['capture', 'session'] : ['-m', 'recall_ai.cli', 'capture', 'session'];

      const child = spawn(pythonPath, args, { cwd: this.projectRoot, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      child.stderr.on('data', (d) => (err += d.toString()));
      child.on('close', (code) => {
        if (code === 0) resolve(out.trim()); else reject(new Error(err));
      });
      child.stdin.write(payload);
      child.stdin.end();
    });
  }

  /**
   * Start monitoring the active app
   * @param {number} intervalMs - Interval in milliseconds between checks
   * @returns {number} Timer ID for cleanup
   */
  startMonitoring(intervalMs = 10000) {
    console.log(`[AppMonitor] Starting monitor (interval: ${intervalMs}ms)`);
    return setInterval(async () => {
      try {
        const app = await this.getActiveApp();

        // Capture a snapshot of all open apps each interval and write to JSON
        try {
          const openApps = await this.listOpenApps();
          this._writeOpenAppsLog(openApps);

          // Optionally log each open app as an activity (default: enabled).
          // Set RECALL_LOG_OPEN_APPS=0 to disable per-app logging.
          const logOpen = process.env.RECALL_LOG_OPEN_APPS === '0' ? false : true;
          if (Array.isArray(openApps) && logOpen) {
            for (const entry of openApps) {
              const appName = entry.name || 'Unknown';
              const windowTitle = Array.isArray(entry.windows) && entry.windows.length ? entry.windows[0] : '';
              try {
                await this.logAppActivity(appName, windowTitle);
              } catch (e) {
                console.debug('[AppMonitor] Failed to log open-app activity:', e && e.message ? e.message : e);
              }
            }
          }
        } catch (e) {
          console.debug('[AppMonitor] Open-app snapshot failed:', e && e.message ? e.message : e);
        }
        if (!app) {
          console.debug('[AppMonitor] No active app detected');
          return;
        }

        // Only log if the app changed
        const appKey = `${app.name}::${app.title}`;
        if (this.currentAppKey === appKey) {
          return;
        }

        console.log(`[AppMonitor] App changed: ${app.name} - "${app.title}"`);

        // End previous session if any
        if (this.currentAppKey) {
          const [prevName, prevTitle] = this.currentAppKey.split('::');
          try {
            await this.logSessionEnd(prevName, prevTitle);
            console.log(`[AppMonitor] Ended session for: ${prevName} - "${prevTitle}"`);
          } catch (e) {
            console.error('[AppMonitor] Failed to end session:', e.message);
          }
        }

        // Start new session
        this.currentAppKey = appKey;
        try {
          await this.logSessionStart(app.name, app.title);
          console.log(`[AppMonitor] Started session for: ${app.name} - "${app.title}"`);
        } catch (e) {
          console.error('[AppMonitor] Failed to start session:', e.message);
        }

        // Also log a regular activity event
        try {
          const eventId = await this.logAppActivity(app.name, app.title);
          console.log(`[AppMonitor] Logged app activity: ${eventId}`);
        } catch (error) {
          console.error('[AppMonitor] Failed to log activity:', error.message);
        }
      } catch (error) {
        console.error('[AppMonitor] Monitor error:', error.message);
      }
    }, intervalMs);
  }

  /**
   * Start macOS event watcher (fast, zero-polling) by spawning the Python
   * `app_watcher.py` script. It emits a JSON line on each app activation.
   */
  startEventWatcher() {
    if (this.eventWatcher && !this.eventWatcher.killed) return;
    const scriptPath = path.join(__dirname, 'app_watcher.py');
    if (!fs.existsSync(scriptPath)) {
      console.warn('[AppMonitor] app_watcher.py not found; falling back to polling');
      return null;
    }

    // Use RECALL_PYTHON env var if set; otherwise use the bundled or system python3.
    // This ensures the watcher uses the same Python environment (e.g., with PyObjC installed).
    const pythonPath = process.env.RECALL_PYTHON || this.recallExecutable || 'python3';
    const child = spawn(pythonPath, [scriptPath], { cwd: this.projectRoot });
    this.eventWatcher = child;

    child.stdout.on('data', async (chunk) => {
      const s = chunk.toString();
      for (const line of s.split(/\n/).map((l) => l.trim()).filter(Boolean)) {
        try {
          const obj = JSON.parse(line);
          if (obj && obj.event === 'app_switch') {
            // Extract app name and window title from the watcher payload
            const appName = obj.name || 'Unknown';
            const windowTitle = obj.title || ''; // App_watcher now populates this via AppleScript
            try {
              // Use existing session logic
              await this._handleDetectedApp(appName, windowTitle, { source: 'event' });
            } catch (e) {
              console.debug('[AppMonitor] event handler failed:', e && e.message ? e.message : e);
            }
          }
        } catch (e) {
          console.debug('[AppMonitor] malformed watcher output:', line);
        }
      }
    });

    child.stderr.on('data', (d) => console.debug('[AppMonitor watcher stderr]', d.toString()));
    child.on('close', (code) => console.log('[AppMonitor] watcher exited', code));
    child.on('error', (err) => console.error('[AppMonitor] watcher error', err && err.message ? err.message : err));

    console.log('[AppMonitor] Started event watcher (pid:', child.pid, ', python:', pythonPath, ')');
    return child;
  }

  stopEventWatcher() {
    if (this.eventWatcher && !this.eventWatcher.killed) {
      try {
        this.eventWatcher.kill();
      } catch (e) {
        console.debug('[AppMonitor] failed to kill watcher:', e && e.message ? e.message : e);
      }
      this.eventWatcher = null;
    }
  }

  /**
   * Unified handler used by both the polling loop and the event watcher.
   */
  async _handleDetectedApp(name, title, meta = {}) {
    try {
      const app = { name: name || 'Unknown', title: title || '' };
      const appKey = `${app.name}::${app.title}`;
      if (appKey !== this.currentAppKey) {
        // End previous
        if (this.currentAppKey) {
          const [prevName, prevTitle] = this.currentAppKey.split('::');
          try {
            await this.logSessionEnd(prevName, prevTitle);
            console.log(`[AppMonitor] Ended session for: ${prevName} - "${prevTitle}"`);
          } catch (e) {
            console.error('[AppMonitor] Failed to end session:', e.message);
          }
        }

        // Start new
        this.currentAppKey = appKey;
        try {
          await this.logSessionStart(app.name, app.title);
          console.log(`[AppMonitor] Started session for: ${app.name} - "${app.title}"`);
        } catch (e) {
          console.error('[AppMonitor] Failed to start session:', e.message);
        }
      }

      // Write a debug log for the detection
      const payload = { timestamp: new Date().toISOString(), activeApp: app, detected: true, note: 'Detected via event', meta };
      this._writeDebugLog(payload);

      // Emit a detection event for listeners (main process UI) so live viewers
      // can update immediately with the real current timestamp instead of
      // reading older files.
      try {
        this.emit('detection', payload);
      } catch (e) {
        console.debug('[AppMonitor] emit detection failed:', e && e.message ? e.message : e);
      }

      try {
        const eventId = await this.logAppActivity(app.name, app.title);
        console.log(`[AppMonitor] Logged app activity: ${eventId}`);
      } catch (error) {
        console.error('[AppMonitor] Failed to log activity:', error.message);
      }
    } catch (error) {
      console.error('[AppMonitor] _handleDetectedApp error:', error && error.message ? error.message : error);
    }
  }

  /**
   * Stop monitoring
   */
  stopMonitoring(timerId) {
    if (timerId) {
      clearInterval(timerId);
    }
  }
}

module.exports = { AppMonitor };

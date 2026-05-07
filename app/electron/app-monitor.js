let activeWin = null;
try {
  // Try to require the native module; if it fails (packaged binary ABI mismatch),
  // we'll fall back to a macOS-only AppleScript approach below.
  activeWin = require('active-win');
} catch (e) {
  activeWin = null;
}
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Monitor the active application and log to SQLite
 */
class AppMonitor {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
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
   * Get the currently focused app
   */
  async getActiveApp() {
    // If the native `active-win` module loaded successfully, prefer it.
    if (activeWin) {
      try {
        const app = await activeWin({ screenRecordingPermission: false });
        if (!app) {
          console.debug('[AppMonitor] active-win returned null (no active app)');
          return null;
        }
        console.debug('[AppMonitor] active-win detected:', app.owner?.name, app.title);
        return {
          name: app.owner?.name || 'Unknown',
          title: app.title || '',
        };
      } catch (error) {
        console.warn('[AppMonitor] active-win failed, falling back to AppleScript:', error.message);
        // fall through to fallback
      }
    }

    // Fallback: macOS-only AppleScript via `osascript`. This avoids loading
    // native node modules in the packaged app and works without rebuilding.
    if (process.platform === 'darwin') {
      try {
        const getAppName = 'tell application "System Events" to get name of first application process whose frontmost is true';
        const getWindowTitle = `try
  tell application (tell application "System Events" to get name of first application process whose frontmost is true)
    get name of front window
  end tell
on error
  return ""
end try`;

        const appName = await new Promise((resolve) => {
          execFile('osascript', ['-e', getAppName], (err, stdout) => {
            if (err) {
              console.debug('[AppMonitor] osascript app name failed:', err.message);
              return resolve(null);
            }
            resolve(stdout.toString().trim());
          });
        });

        if (!appName) {
          console.debug('[AppMonitor] osascript returned no app name');
          return null;
        }

        const windowTitle = await new Promise((resolve) => {
          execFile('osascript', ['-e', getWindowTitle], (err, stdout) => {
            if (err) {
              console.debug('[AppMonitor] osascript window title failed:', err.message);
              return resolve('');
            }
            resolve(stdout.toString().trim());
          });
        });

        console.debug('[AppMonitor] osascript detected:', appName, windowTitle);
        return { name: appName, title: windowTitle || '' };
      } catch (error) {
        console.error('[AppMonitor] macOS fallback failed:', error.message);
        return null;
      }
    }

    return null;
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

      const command = this.recallExecutable || 'python3';
      const args = this.recallExecutable ? ['capture', 'app'] : ['-m', 'recall_ai.cli', 'capture', 'app'];

      const python = spawn(command, args, {
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

      const command = this.recallExecutable || 'python3';
      const args = this.recallExecutable ? ['capture', 'session'] : ['-m', 'recall_ai.cli', 'capture', 'session'];

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

      const command = this.recallExecutable || 'python3';
      const args = this.recallExecutable ? ['capture', 'session'] : ['-m', 'recall_ai.cli', 'capture', 'session'];

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
   * Stop monitoring
   */
  stopMonitoring(timerId) {
    if (timerId) {
      clearInterval(timerId);
    }
  }
}

module.exports = { AppMonitor };

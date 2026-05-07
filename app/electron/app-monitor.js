const activeWin = require('active-win');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Monitor the active application and log to SQLite
 */
class AppMonitor {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.lastApp = null;
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
    try {
      const app = await activeWin({ screenRecordingPermission: false });
      if (!app) {
        return null;
      }
      return {
        name: app.owner?.name || 'Unknown',
        title: app.title || '',
      };
    } catch (error) {
      console.error('Error detecting active app:', error);
      return null;
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
   * Start monitoring the active app
   * @param {number} intervalMs - Interval in milliseconds between checks
   * @returns {number} Timer ID for cleanup
   */
  startMonitoring(intervalMs = 10000) {
    return setInterval(async () => {
      try {
        const app = await this.getActiveApp();
        if (!app) {
          return;
        }

        // Only log if the app changed
        const appKey = `${app.name}::${app.title}`;
        if (this.lastApp === appKey) {
          return;
        }

        this.lastApp = appKey;
        console.log(`[AppMonitor] Active app: ${app.name} - "${app.title}"`);

        try {
          const eventId = await this.logAppActivity(app.name, app.title);
          console.log(`[AppMonitor] Logged event: ${eventId}`);
        } catch (error) {
          console.error('[AppMonitor] Failed to log activity:', error);
        }
      } catch (error) {
        console.error('[AppMonitor] Monitor error:', error);
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

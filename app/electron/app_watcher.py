#!/usr/bin/env python3
"""
Lightweight macOS app switch watcher using PyObjC.
Writes one JSON object per line to stdout on app-activation events.

Requires: pyobjc (install with `pip install pyobjc`)
"""
import sys
import json
import subprocess

try:
    from Foundation import NSObject
    from AppKit import NSWorkspace
    from PyObjCTools import AppHelper
except Exception as e:
    sys.stderr.write('PyObjC import failed: ' + str(e) + '\n')
    sys.stderr.flush()
    sys.exit(1)


def get_window_title(app_name):
    """Attempt to fetch the front window title for the given app using AppleScript."""
    try:
        script = f'''
try
  tell application "{app_name}" to get name of front window
on error
  return ""
end try
'''
        result = subprocess.run(
            ['osascript', '-e', script],
            capture_output=True,
            text=True,
            timeout=2
        )
        return result.stdout.strip() if result.returncode == 0 else ""
    except Exception:
        return ""


class AppObserver(NSObject):
    def appSwitched_(self, notification):
        try:
            app = notification.userInfo().get('NSWorkspaceApplicationKey')
            app_name = app.localizedName() if app is not None else None
            
            # Attempt to fetch window title via AppleScript (may fail if Accessibility permission not granted)
            window_title = ""
            if app_name:
                window_title = get_window_title(app_name)
            
            payload = {
                'event': 'app_switch',
                'name': app_name,
                'title': window_title,
                'bundle': str(app.bundleIdentifier()) if app is not None else None,
            }
            sys.stdout.write(json.dumps(payload) + '\n')
            sys.stdout.flush()
        except Exception as exc:
            sys.stderr.write('appSwitched error: ' + str(exc) + '\n')
            sys.stderr.flush()


if __name__ == '__main__':
    obs = AppObserver.alloc().init()
    nc = NSWorkspace.sharedWorkspace().notificationCenter()
    nc.addObserver_selector_name_object_(obs, 'appSwitched:', 'NSWorkspaceDidActivateApplicationNotification', None)
    try:
        AppHelper.runConsoleEventLoop()
    except KeyboardInterrupt:
        pass

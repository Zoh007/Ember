#!/usr/bin/env python3
"""
Lightweight macOS app switch watcher using PyObjC.
Writes one JSON object per line to stdout on app-activation events.

Requires: pyobjc (install with `pip install pyobjc`)
"""
import sys
import json

try:
    from Foundation import NSObject
    from AppKit import NSWorkspace
    from PyObjCTools import AppHelper
except Exception as e:
    sys.stderr.write('PyObjC import failed: ' + str(e) + '\n')
    sys.stderr.flush()
    sys.exit(1)


class AppObserver(NSObject):
    def appSwitched_(self, notification):
        try:
            app = notification.userInfo().get('NSWorkspaceApplicationKey')
            payload = {
                'event': 'app_switch',
                'name': app.localizedName() if app is not None else None,
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

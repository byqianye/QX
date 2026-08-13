# Windows RC Clean Install

Installer: C:\Users\qiany\Documents\ChatGPT\QX影视\release\rc\QX影视-RC-Setup-0.9.0-rc.1-x64.exe

The per-user NSIS installer was installed into a temporary directory, launched through the packaged E2E, verified shortcuts, then silently uninstalled.

```text
{
  "probe": "nsis-installer-e2e",
  "status": "passed",
  "installedExecutable": "C:\\Users\\qiany\\AppData\\Local\\Temp\\qx-installer-e2e-TDoXgB\\安装目录\\QX影视.exe",
  "uninstaller": "Uninstall QX影视.exe",
  "shortcuts": {
    "desktop": true,
    "startMenu": true
  },
  "install": {
    "code": 0,
    "signal": null
  },
  "packagedE2e": {
    "code": 0,
    "signal": null
  },
  "uninstall": {
    "code": 0,
    "signal": null
  },
  "removed": true,
  "userDataRetained": true
}
```

CLEAN_INSTALL = PASS

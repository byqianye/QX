# External Machine Preflight

Machine: `CESHI`  
User: `WORKGROUP\qiany`  
Timestamp: `2026-08-11T01:54:21.8879575+08:00`

| Check | Result |
| --- | --- |
| Windows | Windows 11, build 26100, AMD64 |
| CPU | AMD Ryzen 9 8940HX, 4 logical processors |
| RAM | 8 GB |
| Free disk | 6.65 GB |
| QX preinstalled | NO |
| QX Runtime preinstalled | NO |
| Project checkout | NO |
| `node_modules` | NO |
| Android SDK/ADB | NO |
| Android Studio | NO |
| `%USERPROFILE%\.android` | NO |
| `ANDROID_HOME` | unset |
| `ANDROID_SDK_ROOT` | unset |
| Firmware hypervisor present | YES |
| WHPX before provisioning | Disabled |
| `cleanQxInstall` | `true` |
| `cleanAndroidEnvironment` | `true` |

After this preflight, WHPX was enabled through the official Windows feature path and the Guest was rebooted. The post-reboot feature state was verified as `HypervisorPlatform = Enabled`.

`EXTERNAL_MACHINE_PREFLIGHT = PASS`

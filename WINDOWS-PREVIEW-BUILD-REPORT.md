# QX影视 Windows Preview Build Report

日期：2026-08-09

## 结果

- Android Host APK build：PASS
- TypeScript typecheck：PASS
- `prepack-check`：PASS
- Preview unpacked directory：PASS
- NSIS installer：PASS
- Portable executable：PASS
- Windows code signing：`SIGNED=false`（PowerShell `Get-AuthenticodeSignature` 为 `NotSigned`）

## 产物

| 产物 | 大小 | SHA-256 |
| --- | ---: | --- |
| `release/preview/QX影视-Preview-Setup-0.1.0-x64.exe` | 185637720 | `891015CCBA92B09E7AE2EB672DF7CFBF8463ABE539780DDD7D7A33EC8EDFAB94` |
| `release/preview/QX影视-Preview-Portable-0.1.0-x64.exe` | 167901565 | `EDC764CC13E1E8653E762935A4A9C6E19F0E0599103DDAC4CD51EE4E5AE4760D` |
| `release/preview/win-unpacked/QX影视.exe` | 225441792 | `A13D008DDC68E807E25B2363B466AE99AA39F78BB4EACB9506E1EAA86725027B` |
| `release/preview/win-unpacked/resources/app.asar` | 51090989 | `DCE08C27F79B78360B3B5F5E69725C1DA5EE68A3BE488FB2ED3679E57B47A920` |
| `release/preview/win-unpacked/resources/android-host/android-spider-host.apk` | 3834223 | `CC7C833101E4D340691C8F165F2BDD2897CB226F4225302FD3C447E12BFA2049` |

## 构建命令

```text
npm run preview:dir
npm run preview:installer
npm run preview:portable
```

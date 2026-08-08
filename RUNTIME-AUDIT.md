# QX Spider Runtime Audit

Audit date: 2026-08-08

Configuration source: `http://xn--z7x900a.net/`

The configuration was fetched and decoded with the project decoder. Spider artifacts were downloaded into a temporary cache, hashed, and inspected as ZIP/JAR metadata only. No JAR, DEX, emulator, class loader, or third-party converter was executed.

## Summary

| Metric | Result |
| --- | ---: |
| Configured sites | 39 |
| Searchable sites | 33 |
| Searchable sites supported by the current desktop runtime | 0 |
| Native | 1 |
| Android DEX | 37 |
| JavaScript | 1 |
| Python | 0 |
| CMS | 0 |

The 33 searchable sites all depend on the Android DEX artifact. The one Native site (`csp_Douban`) and the one JavaScript site are both non-searchable in this configuration. Therefore “0 searchable runtime support” is an accurate configuration/runtime boundary result, not a test failure.

The shared artifact declaration resolves to:

- URL: `https://img2.gelonghui.com/library/f7c90-40d96eab-56f3-4c13-a248-8d80bcb9b83a.png`
- Declared MD5: `f7c90ebd0a6632f3347eeeb8d9bd555e`
- Size: `864852` bytes
- SHA-256: `04f73a0bb4c79fd2547e6c7b488b82afcc20b42572f5ff3030b0c430cd0419ab`
- Format: JAR/ZIP container
- `classes.dex`: yes
- JVM `.class`: no
- Runtime requirement: `android-dex`
- Assets: `assets/push.html`

## Per-site result

| # | Key | API | Searchable | Runtime | Supported | Reason |
| ---: | --- | --- | :---: | --- | :---: | --- |
| 0 | 豆瓣 | csp_Douban | no | native | yes | native_supported |
| 1 | 豆瓣预告 | csp_YGP | no | android-dex | no | android_dex_runtime_not_available |
| 2 | config | csp_Config | yes | android-dex | no | android_dex_runtime_not_available |
| 3 | csp_FeiMaoUC | csp_Duopan | yes | android-dex | no | android_dex_runtime_not_available |
| 4 | csp_Duopan | csp_Duopan | yes | android-dex | no | android_dex_runtime_not_available |
| 5 | csp_Netfixtv | csp_Duopan | yes | android-dex | no | android_dex_runtime_not_available |
| 6 | 潮流 | csp_AppRJ | yes | android-dex | no | android_dex_runtime_not_available |
| 7 | 肥猫 | csp_AppGet | yes | android-dex | no | android_dex_runtime_not_available |
| 8 | 干饭 | csp_AppGet | yes | android-dex | no | android_dex_runtime_not_available |
| 9 | 光盘 | csp_AppQi | yes | android-dex | no | android_dex_runtime_not_available |
| 10 | 行动 | csp_AppQi | yes | android-dex | no | android_dex_runtime_not_available |
| 11 | 再来 | csp_AppGet | yes | android-dex | no | android_dex_runtime_not_available |
| 12 | 一碗 | csp_AppGet | yes | android-dex | no | android_dex_runtime_not_available |
| 13 | 蔬菜 | csp_AppGet | yes | android-dex | no | android_dex_runtime_not_available |
| 14 | 永永 | csp_AppGet | yes | android-dex | no | android_dex_runtime_not_available |
| 15 | csp_Jpys | csp_Jpys | yes | android-dex | no | android_dex_runtime_not_available |
| 16 | csp_Wwys | csp_Wwys | yes | android-dex | no | android_dex_runtime_not_available |
| 17 | 荐片 | csp_Jianpian | yes | android-dex | no | android_dex_runtime_not_available |
| 18 | csp_SaoHuo | csp_SaoHuo | yes | android-dex | no | android_dex_runtime_not_available |
| 19 | csp_Gz360 | csp_Gz360 | yes | android-dex | no | android_dex_runtime_not_available |
| 20 | 厂长 | csp_Czsapp | yes | android-dex | no | android_dex_runtime_not_available |
| 21 | csp_SP360 | csp_SP360 | yes | android-dex | no | android_dex_runtime_not_available |
| 22 | csp_Bili | csp_Bili | yes | android-dex | no | android_dex_runtime_not_available |
| 23 | csp_Dm84 | csp_Dm84 | yes | android-dex | no | android_dex_runtime_not_available |
| 24 | 方舟 | csp_AppGet | yes | android-dex | no | android_dex_runtime_not_available |
| 25 | 番薯 | csp_AppGet | yes | android-dex | no | android_dex_runtime_not_available |
| 26 | csp_FirstAid | csp_FirstAid | no | android-dex | no | android_dex_runtime_not_available |
| 27 | 酷狗 | csp_Kugou | yes | android-dex | no | android_dex_runtime_not_available |
| 28 | MTV | csp_Bili | yes | android-dex | no | android_dex_runtime_not_available |
| 29 | 看球 | csp_Kanqiu | yes | android-dex | no | android_dex_runtime_not_available |
| 30 | 瓜子 | csp_GuaziTY | no | android-dex | no | android_dex_runtime_not_available |
| 31 | 米搜 | csp_MiSou | yes | android-dex | no | android_dex_runtime_not_available |
| 32 | csp_PanSearch | csp_PanSearch | yes | android-dex | no | android_dex_runtime_not_available |
| 33 | 儿童 | `https://gh-proxy.net/https://raw.githubusercontent.com/fantaiying7/EXT/refs/heads/main/drpy2.min.js` | no | javascript | yes | js_supported |
| 34 | csp_少儿 | csp_Bili | yes | android-dex | no | android_dex_runtime_not_available |
| 35 | csp_小学 | csp_Bili | yes | android-dex | no | android_dex_runtime_not_available |
| 36 | csp_初中 | csp_Bili | yes | android-dex | no | android_dex_runtime_not_available |
| 37 | csp_高中 | csp_Bili | yes | android-dex | no | android_dex_runtime_not_available |
| 38 | push_agent | csp_Push | no | android-dex | no | android_dex_runtime_not_available |

## Next step

To make the 33 searchable sites available, add an explicit Android DEX execution adapter/runtime. This Goal deliberately does not add an emulator, WSA dependency, DEX converter, or unsafe executable path.

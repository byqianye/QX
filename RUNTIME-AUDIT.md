# QX Spider Runtime Audit

Audit date: 2026-08-12T11:10:48.724Z
Configuration source: `http://xn--z7x900a.net/`

The audit resolves configuration sites, downloads declared Spider artifacts when available, and performs static ZIP/JAR inspection only. No JAR, DEX, emulator, class loader, or third-party converter is executed.

## Summary

| Metric | Result |
| --- | ---: |
| Configured sites | 39 |
| Searchable sites | 33 |
| Supported sites | 39 |
| Searchable sites supported by QX | 33 |

| Runtime | Count |
| --- | ---: |
| cms-json | 0 |
| cms-xml | 0 |
| native | 1 |
| javascript | 1 |
| android-dex | 37 |
| jvm-jar | 0 |
| python | 0 |
| unknown | 0 |

## Artifact evidence

- URL: `https://img2.gelonghui.com/library/f7c90-40d96eab-56f3-4c13-a248-8d80bcb9b83a.png`
- Declared MD5: `f7c90ebd0a6632f3347eeeb8d9bd555e`
- Size: 864852 bytes
- SHA-256: `04f73a0bb4c79fd2547e6c7b488b82afcc20b42572f5ff3030b0c430cd0419ab`
- Format: JAR
- classes.dex: yes
- JVM .class: no
- Runtime requirement: android-dex
- Native libraries: 0
- Assets: `assets/push.html`

## Per-site result

| # | Key | Name | Type | API | Searchable | Runtime | Supported | Reason | Capabilities |
| ---: | --- | --- | ---: | --- | :---: | --- | :---: | --- | --- |
| 0 | 豆瓣 | 🐼┃公众号：我不是肥猫┃ | 3 | csp_Douban | no | native | yes | native_supported | home, category, search, detail, player |
| 1 | 豆瓣预告 | 🐼┃豆瓣┃预告 | 3 | csp_YGP | no | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 2 | config | 🐼┃配置┃中心 | 3 | csp_Config | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 3 | csp_FeiMaoUC | ⚡┃闪电┃优汐 | 3 | csp_Duopan | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 4 | csp_Duopan | 🖍︎┃蜡笔┃影视 | 3 | csp_Duopan | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 5 | csp_Netfixtv | 💌┃️至臻┃影视 | 3 | csp_Duopan | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 6 | 潮流 | 🏜┃潮流┃APP | 3 | csp_AppRJ | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 7 | 肥猫 | 🐼┃肥猫┃APP | 3 | csp_AppGet | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 8 | 干饭 | 🍚┃干饭┃APP | 3 | csp_AppGet | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 9 | 光盘 | 📀┃光盘┃APP | 3 | csp_AppQi | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 10 | 行动 | 😌┃行动┃APP | 3 | csp_AppQi | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 11 | 再来 | ✌️┃再来┃APP | 3 | csp_AppGet | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 12 | 一碗 | 🥣┃一碗┃APP | 3 | csp_AppGet | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 13 | 蔬菜 | 🫛┃蔬菜┃APP | 3 | csp_AppGet | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 14 | 永永 | ♾️┃永永┃APP | 3 | csp_AppGet | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 15 | csp_Jpys | 🥇️┃金牌┃影视 | 3 | csp_Jpys | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 16 | csp_Wwys | 🌾️┃农民┃影视 | 3 | csp_Wwys | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 17 | 荐片 | 🎬┃荐片┃影视 | 3 | csp_Jianpian | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 18 | csp_SaoHuo | 🔥┃火火┃影视 | 3 | csp_SaoHuo | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 19 | csp_Gz360 | 🍉┃瓜子┃影视 | 3 | csp_Gz360 | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 20 | 厂长 | 🏭┃厂长┃影视 | 3 | csp_Czsapp | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 21 | csp_SP360 | 📺┃360┃官源 | 3 | csp_SP360 | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 22 | csp_Bili | 🅱┃️哔哩┃合集 | 3 | csp_Bili | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 23 | csp_Dm84 | 🤣┃动漫┃巴士 | 3 | csp_Dm84 | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 24 | 方舟 | 🐷┃方舟┃动漫 | 3 | csp_AppGet | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 25 | 番薯 | 🍠┃番薯┃动漫 | 3 | csp_AppGet | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 26 | csp_FirstAid | 🚑┃急救┃教学 | 3 | csp_FirstAid | no | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 27 | 酷狗 | 🐾┃酷狗┃音乐 | 3 | csp_Kugou | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 28 | MTV | 🎧┃明星┃MV | 3 | csp_Bili | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 29 | 看球 | ⚾┃看球┃直播 | 3 | csp_Kanqiu | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 30 | 瓜子 | 🏀┃瓜子┃体育 | 3 | csp_GuaziTY | no | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 31 | 米搜 | 🌖┃米搜┃网盘 | 3 | csp_MiSou | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 32 | csp_PanSearch | 🚃┃盘搜┃网盘 | 3 | csp_PanSearch | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 33 | 儿童 | 📚┃儿童┃启蒙 | 3 | https://gh-proxy.net/https://raw.githubusercontent.com/fantaiying7/EXT/refs/heads/main/drpy2.min.js | no | javascript | yes | js_supported | home, category, search, detail, player |
| 34 | csp_少儿 | 📚┃少儿┃教育 | 3 | csp_Bili | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 35 | csp_小学 | 📚┃小学┃课堂 | 3 | csp_Bili | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 36 | csp_初中 | 📚┃初中┃课堂 | 3 | csp_Bili | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 37 | csp_高中 | 📚┃高中┃课堂 | 3 | csp_Bili | yes | android-dex | yes | android_dex_artifact_ready | search, detail, player |
| 38 | push_agent | 关注公众号：肥猫宝贝 | 3 | csp_Push | no | android-dex | yes | android_dex_artifact_ready | search, detail, player |

## Gate decision

Android DEX accounts for 37/39 sites (94.87%). Proceed to G83 Android DEX PoC.

# G105 Source Compatibility V2

Generated: 2026-08-12T12:49:10.872Z
Config: http://xn--z7x900a.net/
Keywords: 庆余年, movie, tv

| Metric | Result |
| --- | ---: |
| Configured sources | 39 |
| Searchable | 33 |
| Search PASS | 3 |
| Detail PASS | 3 |
| Player PASS | 1 |
| P50/P90/P95 total ms | 2711/44091/61817 |

| Site | API | Runtime | Class | Init | Search | Detail | Player | Status | Reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 🐼┃公众号：我不是肥猫┃ (豆瓣) | csp_Douban | native | com.github.catvod.spider.Douban | FAIL | FAIL/0 | SKIPPED | SKIPPED | INIT_FAILED | Android DEX Spider runtime is unavailable |
| 🐼┃豆瓣┃预告 (豆瓣预告) | csp_YGP | android-dex | com.github.catvod.spider.YGP | PASS | EMPTY/0 | SKIPPED | SKIPPED | SEARCH_ONLY |  |
| 🐼┃配置┃中心 (config) | csp_Config | android-dex | com.github.catvod.spider.Config | PASS | EMPTY/0 | SKIPPED | SKIPPED | SEARCH_ONLY |  |
| ⚡┃闪电┃优汐 (csp_FeiMaoUC) | csp_Duopan | android-dex | com.github.catvod.spider.Duopan | PASS | EMPTY/0 | SKIPPED | SKIPPED | AUTH_REQUIRED | no_results |
| 🖍︎┃蜡笔┃影视 (csp_Duopan) | csp_Duopan | android-dex | com.github.catvod.spider.Duopan | PASS | PASS/24 | PASS | FAIL | TIMEOUT | SOURCE_PLAYER_TIMEOUT |
| 💌┃️至臻┃影视 (csp_Netfixtv) | csp_Duopan | android-dex | com.github.catvod.spider.Duopan | PASS | PASS/21 | PASS | FAIL | TIMEOUT | SOURCE_PLAYER_TIMEOUT |
| 🏜┃潮流┃APP (潮流) | csp_AppRJ | android-dex | com.github.catvod.spider.AppRJ | PASS | EMPTY/0 | SKIPPED | SKIPPED | SEARCH_ONLY |  |
| 🐼┃肥猫┃APP (肥猫) | csp_AppGet | android-dex | com.github.catvod.spider.AppGet | PASS | FAIL/0 | SKIPPED | SKIPPED | TIMEOUT | no_results |
| 🍚┃干饭┃APP (干饭) | csp_AppGet | android-dex | com.github.catvod.spider.AppGet | PASS | EMPTY/0 | SKIPPED | SKIPPED | SEARCH_ONLY |  |
| 📀┃光盘┃APP (光盘) | csp_AppQi | android-dex | com.github.catvod.spider.AppQi | PASS | EMPTY/0 | SKIPPED | SKIPPED | SEARCH_ONLY |  |
| 😌┃行动┃APP (行动) | csp_AppQi | android-dex | com.github.catvod.spider.AppQi | PASS | FAIL/0 | SKIPPED | SKIPPED | TIMEOUT | no_results |
| ✌️┃再来┃APP (再来) | csp_AppGet | android-dex | com.github.catvod.spider.AppGet | PASS | EMPTY/0 | SKIPPED | SKIPPED | SEARCH_ONLY |  |
| 🥣┃一碗┃APP (一碗) | csp_AppGet | android-dex | com.github.catvod.spider.AppGet | PASS | EMPTY/0 | SKIPPED | SKIPPED | SEARCH_ONLY |  |
| 🫛┃蔬菜┃APP (蔬菜) | csp_AppGet | android-dex | com.github.catvod.spider.AppGet | PASS | EMPTY/0 | SKIPPED | SKIPPED | SEARCH_ONLY |  |
| ♾️┃永永┃APP (永永) | csp_AppGet | android-dex | com.github.catvod.spider.AppGet | PASS | FAIL/0 | SKIPPED | SKIPPED | TIMEOUT | no_results |
| 🥇️┃金牌┃影视 (csp_Jpys) | csp_Jpys | android-dex | com.github.catvod.spider.Jpys | PASS | EMPTY/0 | SKIPPED | SKIPPED | SEARCH_ONLY |  |
| 🌾️┃农民┃影视 (csp_Wwys) | csp_Wwys | android-dex | com.github.catvod.spider.Wwys | PASS | EMPTY/0 | SKIPPED | SKIPPED | SEARCH_ONLY |  |
| 🎬┃荐片┃影视 (荐片) | csp_Jianpian | android-dex | com.github.catvod.spider.Jianpian | PASS | PASS/60 | PASS | PASS | FULLY_PLAYABLE |  |
| 🔥┃火火┃影视 (csp_SaoHuo) | csp_SaoHuo | android-dex | com.github.catvod.spider.SaoHuo | PASS | EMPTY/0 | SKIPPED | SKIPPED | SEARCH_ONLY |  |
| 🍉┃瓜子┃影视 (csp_Gz360) | csp_Gz360 | android-dex | com.github.catvod.spider.Gz360 | PASS | EMPTY/0 | SKIPPED | SKIPPED | SEARCH_ONLY |  |
| 🏭┃厂长┃影视 (厂长) | csp_Czsapp | android-dex | com.github.catvod.spider.Czsapp | PASS | EMPTY/0 | SKIPPED | SKIPPED | SEARCH_ONLY |  |
| 📺┃360┃官源 (csp_SP360) | csp_SP360 | android-dex | com.github.catvod.spider.SP360 | PASS | EMPTY/0 | SKIPPED | SKIPPED | SEARCH_ONLY |  |
| 🅱┃️哔哩┃合集 (csp_Bili) | csp_Bili | android-dex | com.github.catvod.spider.Bili | PASS | FAIL/0 | SKIPPED | SKIPPED | SEARCH_FAILED | java.lang.IllegalStateException: Expected BEGIN_OBJECT but was STRING at line 1 column 1 path $ |
| 🤣┃动漫┃巴士 (csp_Dm84) | csp_Dm84 | android-dex | com.github.catvod.spider.Dm84 | PASS | EMPTY/0 | SKIPPED | SKIPPED | SEARCH_ONLY |  |
| 🐷┃方舟┃动漫 (方舟) | csp_AppGet | android-dex | com.github.catvod.spider.AppGet | PASS | EMPTY/0 | SKIPPED | SKIPPED | SEARCH_ONLY |  |
| 🍠┃番薯┃动漫 (番薯) | csp_AppGet | android-dex | com.github.catvod.spider.AppGet | PASS | EMPTY/0 | SKIPPED | SKIPPED | SEARCH_ONLY |  |
| 🚑┃急救┃教学 (csp_FirstAid) | csp_FirstAid | android-dex | com.github.catvod.spider.FirstAid | PASS | EMPTY/0 | SKIPPED | SKIPPED | SEARCH_ONLY |  |
| 🐾┃酷狗┃音乐 (酷狗) | csp_Kugou | android-dex | com.github.catvod.spider.Kugou | PASS | EMPTY/0 | SKIPPED | SKIPPED | MUSIC_ONLY | no_results |
| 🎧┃明星┃MV (MTV) | csp_Bili | android-dex | com.github.catvod.spider.Bili | PASS | FAIL/0 | SKIPPED | SKIPPED | MUSIC_ONLY | no_results |
| ⚾┃看球┃直播 (看球) | csp_Kanqiu | android-dex | com.github.catvod.spider.Kanqiu | PASS | EMPTY/0 | SKIPPED | SKIPPED | LIVE_ONLY | no_results |
| 🏀┃瓜子┃体育 (瓜子) | csp_GuaziTY | android-dex | com.github.catvod.spider.GuaziTY | PASS | EMPTY/0 | SKIPPED | SKIPPED | SEARCH_ONLY |  |
| 🌖┃米搜┃网盘 (米搜) | csp_MiSou | android-dex | com.github.catvod.spider.MiSou | PASS | FAIL/0 | SKIPPED | SKIPPED | NETDISK_ONLY | no_results |
| 🚃┃盘搜┃网盘 (csp_PanSearch) | csp_PanSearch | android-dex | com.github.catvod.spider.PanSearch | PASS | EMPTY/0 | SKIPPED | SKIPPED | NETDISK_ONLY | no_results |
| 📚┃儿童┃启蒙 (儿童) | https://gh-proxy.net/https://raw.githubusercontent.com/fantaiying7/EXT/refs/heads/main/drpy2.min.js | javascript | - | FAIL | FAIL/0 | SKIPPED | SKIPPED | INIT_FAILED | Unable to load QuickJS script: [redacted-url] |
| 📚┃少儿┃教育 (csp_少儿) | csp_Bili | android-dex | com.github.catvod.spider.Bili | PASS | FAIL/0 | SKIPPED | SKIPPED | EDUCATION_ONLY | no_results |
| 📚┃小学┃课堂 (csp_小学) | csp_Bili | android-dex | com.github.catvod.spider.Bili | PASS | FAIL/0 | SKIPPED | SKIPPED | EDUCATION_ONLY | no_results |
| 📚┃初中┃课堂 (csp_初中) | csp_Bili | android-dex | com.github.catvod.spider.Bili | PASS | FAIL/0 | SKIPPED | SKIPPED | EDUCATION_ONLY | no_results |
| 📚┃高中┃课堂 (csp_高中) | csp_Bili | android-dex | com.github.catvod.spider.Bili | PASS | FAIL/0 | SKIPPED | SKIPPED | EDUCATION_ONLY | no_results |
| 关注公众号：肥猫宝贝 (push_agent) | csp_Push | android-dex | com.github.catvod.spider.Push | PASS | EMPTY/0 | SKIPPED | SKIPPED | SEARCH_ONLY |  |

Artifact URLs and sensitive query material are redacted in this report. Raw cookies, tokens and media URLs are not written.


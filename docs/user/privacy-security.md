# 隐私与安全

正常模式的数据默认保存在 `%APPDATA%\QX影视`，包括 SQLite 数据库、缓存、日志、临时文件、设置和备份。Portable 模式使用可执行文件旁的 `data` 目录。

会联网的功能取决于你的操作：导入配置、访问媒体和直播源、刷新 EPG、连接 Jellyfin、DLNA 局域网控制和 LAN Web 控制。应用不自带影视源、测试账号、私人服务器地址或凭据。

把配置、Cookie、Authorization、Token、PIN 和临时媒体 URL 视为敏感信息，不要放进公开 issue、截图或日志。使用第三方 Spider、来源和服务前先确认其代码与访问权限边界。

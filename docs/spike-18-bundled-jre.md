# Spike 18：精简 JRE 随包交付

## 范围

本 Spike 只处理 Windows 10 22H2 及以上、x64 的 JVM Spider 运行时交付，不实现 `playerContent`。

## 固定构建规格

- 发行版：Eclipse Temurin
- 版本：21.0.7+6
- 平台：Windows x64 HotSpot
- 官方压缩包：`OpenJDK21U-jdk_x64_windows_hotspot_21.0.7_6.zip`
- SHA-256：`38f4b9fa0b36def9812f6576fd45f6224630477db8c4e669ee78eaa35abb9195`
- 官方发布页：[adoptium/temurin21-binaries `jdk-21.0.7+6`](https://github.com/adoptium/temurin21-binaries/releases/tag/jdk-21.0.7%2B6)

正式构建通过 `QX_TEMURIN_JDK` 指向解压后的 JDK 根目录。打包脚本会校验厂商包含 `Eclipse` 且版本以 `21.0.7+6` 开头；未设置该变量时允许本机 Spike 使用外部 JDK，但会明确打印 `development-fallback` 警告。

## 生成内容

`npm run electron:build-runtime` 现在会生成：

```text
dist/electron-runtime/
  jre/
    bin/java.exe
  jvm-spider-host.jar
  jvm-spiders.jar
  runtime-manifest.json
```

JRE 由 `jlink` 生成，模块固定为：

```text
java.base,java.net.http
```

运行时解析顺序为：

1. `resources/electron-runtime/jre/bin/java.exe`
2. 开发环境的外部 Java（`QX_JAVA`、`JAVA_HOME` 或 PATH）
3. 两者都不存在时返回 `JAVA_RUNTIME_NOT_FOUND`，UI 在创建 server 前显示明确错误

## 验收结果

使用 pinned Temurin 重打包后：

- `runtime-manifest.json`：`toolchainSource=pinned-temurin`、`toolchainVendor=Eclipse Adoptium`、`toolchainVersion=21.0.7+6-LTS`、`toolchainDataModel=64`
- 包内精简 JRE：`32,199,101` bytes
- Windows x64 包：`438,391,111` bytes
- `npm run electron:e2e:package`：通过；两次启动均完成 URL/文件/JSON 导入、首次信任、重启信任、真实 Douban 搜索→详情、窗口关闭和 sidecar PID 清理
- 真实搜索结果：`msearch:36246195`；详情使用同一 `vod_id`
- `npm run electron:verify:no-jdk`：通过；禁用外部 Java 后仍使用包内 JRE 完成真实搜索→详情；禁用包内 JRE 后返回 `JAVA_RUNTIME_NOT_FOUND`
- `npm run electron:verify:network-timeout`：通过，错误码为 `IMPORT_FETCH_ERROR`

结论：正式 Windows 包采用随包携带的精简 Temurin JRE；外部 Java 只保留为开发环境 fallback。后续若进入发布阶段，还需要单独处理 Temurin 的许可证/NOTICE、JRE 安全更新和安装包签名；本 Spike 不进入 `playerContent`。

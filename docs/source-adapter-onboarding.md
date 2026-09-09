# 新源接入最短路径

普通 JSON HTTP 源优先使用 `qxAdapterVersion: 1` 声明式转换器。接入前只需要确认五个阶段：`home`、`category`、`search`、`detail`、`player/playback`。每个阶段都必须填写真实 HTTP 方法、相对路径、参数和 JSON Pointer 映射；缺失参数会明确失败，不会猜测。

推荐流程：

1. 复制 `docs/source-adapter-converter.md` 中的最小配置，先只填写 `search` 和 `detail`。
2. 运行 `npm run test:source-contract`，确认 TypeScript 合同与 Rust 转换器/会话边界通过。
3. 用真实源分别记录读取、搜索、详情、媒体解析和实际播放结果。`parse=0` 只代表源返回了明确 HTTP(S) 媒体地址，不代表首帧或持续播放已验证。
4. 需要签名、加密、HTML 解析、登录或动态脚本时，停止扩展声明式转换器，新增隔离专用适配器，并补充对应合同文档。

验证产物写入 `artifacts/source-contract-check.json`，包含每个阶段测试命令、耗时、状态和截断后的输出，方便逐源登记，不把“配置能导入”误报为“源已可用”。

肥猫配置的常见失败模式、协议分层和真实播放验收要求见 [`source-contract-feimao-generic.md`](source-contract-feimao-generic.md)。

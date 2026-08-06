# CODEX GOALS

## 项目阶段

- Stage 0：Spike 0–19 ✅ 已完成
- Stage 1：G20–G78 🚧 进行中

---

## G20（进行中）

### 目标
建立 Codex 目标模式工程治理体系

### 状态
进行中

### 依赖
无

### 范围
- AGENTS.md
- CODEX_GOALS.md
- 基线测试识别
- 文档对齐

### 验收标准
- AGENTS.md 完整
- CODEX_GOALS.md 完整
- Spike 0–19 状态正确记录
- 不修改业务逻辑

### 验证命令
```bash
npm run typecheck
npm test
npm run electron:e2e
```

## G21（已完成）

### 目标
将 Spike 19 的 `playerContent` 结果交给 Electron 内嵌 MP4/HLS 播放器。

### 状态
已完成。播放器与 JVM 结果边界已建立；带 headers 的结果由 G22 受控 LocalProxy 接管，`csp_Douban` 保持 `PLAYBACK_UNAVAILABLE`。

### 验证
- `npm run typecheck`
- `npm test`
- `npm run electron:e2e:package`

### 文档
- `docs/spike-20-embedded-player.md`

## G22（已完成）

### 目标
为需要受保护请求头的 MP4/HLS 播放源增加受控 LocalProxy，并在 Electron 内嵌播放器中完成 protected HLS 播放。

### 状态
已完成。代理仅监听 `127.0.0.1` 随机端口；会话令牌绑定 origin、请求头和生命周期；playlist 子资源全部重写；SSRF、请求头、大小、超时、并发和生命周期边界均已验证。

### 依赖
- G21 / Spike 20 内嵌 MP4/HLS 播放器
- Spike 19 `playerContent` headers 结果

### 验收标准
- 无 headers 的 MP4/HLS 继续直连内嵌播放
- 带 `Referer`/`User-Agent` 的 protected HLS 只能通过随机本地代理播放
- renderer 不能通过任意 query 指定上游 URL
- 代理拒绝不安全协议、私网地址、跨 origin redirect 和禁用请求头
- 切换、关闭、过期和 Electron 退出会撤销代理会话、终止上游请求并释放资源

### 验证命令
```powershell
npm run typecheck
npm test
npm run electron:e2e:package
```

### 文档
- `docs/spike-21-local-proxy.md`

## G23（已完成）

### 目标
将详情页的 CatVod 线路与选集协议接入同一个 Spider Session、`playerContent`、G22 LocalProxy 和 Electron 内嵌播放器，完成受控点播闭环。

### 状态
已完成。JVM-native fixture 已覆盖导入后的首页、分类、搜索、详情、线路、选集和播放路径；线路/选集解析、顺序切换、失败恢复和播放资源生命周期均有测试，未接入第三方影视源。

### 依赖
- G21 / Spike 20 内嵌 MP4/HLS 播放器
- G22 / Spike 21 受控 LocalProxy

### 验收标准
- `vod_play_from` 与 `vod_play_url` 按 `$$$`、`#`、第一个未编码 `$` 解析
- 支持多线路、多集、空线路、缺失集名、重复集名和 Unicode/编码 URL
- 无法区分未编码保留字符时返回 `PLAYBACK_FORMAT_INVALID`
- UI 正确传递 `flag`、真实播放 `id` 和 `vipFlags`
- 切集/切线路停止旧播放器并释放旧 LocalProxy，不重启 Spider Session
- 播放失败保留详情、线路、选集并支持重试/切线路
- 开发版和打包版受控点播闭环通过验证，sidecar、fixture、端口和播放 token 无泄漏

### 验证命令
```powershell
npm run typecheck
npm test
npm run electron:e2e:package
```

### 文档
- `docs/spike-22-vod-playback-e2e.md`

G24–G78（未开始）

（略，按主路线图执行）

DEX-1 ~ DEX-5（实验支线）

- DEX-1：Android Emulator 探针
- DEX-2：DEX Spider 加载验证
- DEX-3：Electron RPC 通信
- DEX-4：资源评估
- DEX-5：是否产品化决策

---

## 基线命令（Baseline Commands）

项目当前识别的标准验证命令：

```bash
npm run typecheck
npm test
npm run electron:e2e
```

说明：

- `electron:e2e` 可能在 `package.json` 中名称略有差异；
- 当前 `package.json` 中对应的实际打包 E2E 命令为 `npm run electron:e2e:package`；
- 以实际 `scripts` 为准。

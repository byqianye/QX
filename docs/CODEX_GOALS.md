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

G21–G78（未开始）

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

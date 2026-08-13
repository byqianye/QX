# G106 Product Design Alternative Audit

日期：2026-08-13

## 结论

本次使用本地 `product-design:audit` 替代 OpenDesign，对 Preview 安装包执行了真实页面审查。审查证据来自当前运行的：

`release/preview/win-unpacked/QX影视.exe`

| 门禁 | 状态 |
| --- | --- |
| Product Design Alternative Audit | PASS |
| Local UI Implementation | PASS（沿用现有验证） |
| Open Design Cloud Final Review | 未执行，不伪造 PASS |
| 原 G106 Cloud 专属门禁 | BLOCKED |

本地替代审查证明 UI 的页面结构、状态表达和主要交互可以被真实检查；它不等价于 OpenDesign Cloud 生成 artifact，也不改变原 Goal 对 Cloud 门禁的定义。

## 审查范围与用户任务

任务：导入已授权来源，搜索“庆余年”，打开详情，检查播放入口、来源状态、运行环境和设置。

页面覆盖：App Shell / Home / Search / Detail / Source Panel / Player / Runtime / Settings。

截图尺寸：当前 Preview 窗口约 1270×905 客户区。

## 当前证据

- [Home](tmp/g106-product-design-audit-20260813-local/01-home.png)
- [Search](tmp/g106-product-design-audit-20260813-local/02-search.png)
- [Source Panel](tmp/g106-product-design-audit-20260813-local/03-source-panel.png)
- [Runtime 未安装状态](tmp/g106-product-design-audit-20260813-local/04-runtime-not-started.png)
- [Settings / Runtime](tmp/g106-product-design-audit-20260813-local/05-settings-runtime.png)
- [Detail Drawer](tmp/g106-product-design-audit-20260813-local/06-detail-drawer.png)
- [Player / 无正片播放源](tmp/g106-product-design-audit-20260813-local/07-player-no-source.png)

## 流程审查

1. **App Shell / Home — PASS**

   左侧导航、当前来源摘要、顶部搜索、推荐卡片和底部播放占位区均可见。来源名称使用用户可读名称，没有暴露内部 API key。

2. **Search — PASS**

   搜索词被保留，真实返回了 7 条“庆余年”结果，卡片包含标题、年份和评分状态。结果卡片在图片不可用时提供了可识别的占位内容。

3. **Detail — PASS（结构）**

   右侧抽屉保留列表上下文，依次展示封面、标题、简介、元数据、线路状态、来源和收藏/追更动作。当前真实线路状态为 `Douban：无正片播放源`，播放按钮正确禁用。

4. **Source Panel — PASS**

   导入页面展示配置摘要、站点数量和 Spider 是否存在；确认对话框先说明执行引擎、允许域名和 LocalProxy 可能参与，再让用户确认。

5. **Player — BLOCKED BY REAL SOURCE STATE**

   当前真实来源没有正片播放线路，因此没有可验证的播放画面、线路选择或播放控制。页面没有伪造播放成功，保留了“查找播放源”动作和禁用的“播放”按钮。

6. **Runtime — PASS（状态表达）/ BLOCKED（未安装）**

   设置页真实显示 Android 兼容运行环境尚未安装、Host RPC 未安装、安装位置和安装动作。当前状态仍显示 `检查中`，与“尚未安装”并列时会造成轻微理解冲突。

7. **Settings — PASS（结构）**

   Runtime、来源管理、主题、LocalProxy、播放偏好、弹幕、Push、诊断、隐私、缓存、数据目录和备份恢复均按区块组织；页面明确说明敏感信息不会在 renderer 回显。

## 主要问题

### P1：Runtime 状态文案可能同时表达“未安装”和“检查中”

设置页同时出现“Android 兼容运行环境尚未安装”和“Runtime / Android / Host / WHPX … 检查中”。用户难以判断当前应该等待还是点击安装。

建议：未安装时将检查状态改为“未安装，等待安装”，并把“安装并启用”作为唯一主动作；安装后再进入“检查中”。

### P1：当前真实来源没有正片播放线路

Detail 和 Player 证据都显示无正片源。这是来源能力/运行环境状态，不应通过 UI 伪造解决。本地设计审查只记录事实，不把它升级为 Cloud 或播放 PASS。

### P2：无海报占位内容需要更明确

搜索结果的图片缺失状态使用单字占位。建议补充“暂无海报”语义或使用已有的可访问名称，避免用户把占位字误认为海报内容。

## 可访问性与验证边界

- 主要按钮、输入框和卡片的最小触控高度符合当前 44px 设计约束。
- 搜索输入可见 focus ring；截图能证明视觉焦点样式存在。
- 截图不能证明完整 Tab 顺序、Escape 关闭抽屉后的焦点恢复、屏幕阅读器朗读顺序或 WCAG 对比度的全部数值，不能据此宣称完整无障碍合规。

## 状态边界

```text
PRODUCT_DESIGN_ALTERNATIVE_AUDIT = PASS
OPEN_DESIGN_CLOUD_CALL = NOT_EXECUTED
OPEN_DESIGN_FINAL_REVIEW = NOT_EXECUTED
OPEN_DESIGN_ARTIFACT = NOT_EXECUTED
QX_FINAL_UI_V1 = BLOCKED_BY_ORIGINAL_CLOUD_GATE
```

本文件是本地 Product Design 审查结果，不是 OpenDesign Cloud 结果替身。

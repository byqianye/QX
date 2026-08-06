# Spike 26：主题、窗口和页面状态持久化

## 状态

G27 已完成。本 Spike 固定了持久化边界和降级策略，并已接入 Electron 窗口与 Vue renderer。

## 持久化边界

文件位置遵循 Electron `app.getPath("userData")`：

```text
<userData>/desktop-state.json
```

只保存以下非敏感元数据：

- 主题模式：`light`、`dark`、`system`；默认 `light`；
- 窗口宽、高、x、y 和最大化状态；
- 最近导航、站点 key、分类分页、搜索词/分页、列表滚动位置和最近详情 ID。

不保存来源 URL、播放 URL、Proxy token、Authorization、Cookie、Jellyfin token 或其他带凭据的 URL/标识符。站点只保存配置内的 key，导入配置仍需用户重新提供并经过既有信任流程。

## 写入与损坏处理

`src/desktop/state-persistence.ts` 使用同目录临时文件写入后 `rename` 替换目标文件。写入失败只返回脱敏诊断并保留当前内存状态，不阻塞本次启动，也不进行无限重试。

读取 JSON 失败或版本不支持时：

1. 尝试把原文件改名为带时间戳的 `.corrupt-*.bak`；
2. 使用浅色、默认窗口和空页面上下文启动；
3. 暴露 `STATE_PERSISTENCE_CORRUPT` 脱敏诊断；
4. 不把原始异常、用户目录或文件内容写入界面。

## 窗口坐标

Electron main 在创建窗口前读取当前显示器工作区，使用 `restoreWindowBounds`：

- 限制最小尺寸为 960×640；
- 把超出工作区的尺寸压回可用范围；
- 没有至少 64×64 可见交集时回到主显示器居中；
- 保存正常 bounds，并单独恢复最大化状态。

窗口移动、调整大小、最大化/还原使用短 debounce 写入；关闭前同步保存一次。

## 页面恢复

UI server 通过 `/api/state` 返回脱敏持久化视图，通过 `/api/view-state` 接收主题、导航和滚动位置更新。导入后的站点 key 选择优先复用上次 key；只有当前配置包含相同 key 时，renderer 才自动恢复首页、分类、搜索或最近详情，避免把旧配置状态应用到新来源。

## 验证

```powershell
npx vitest run tests/desktop-state.test.ts tests/spider-import.test.ts tests/vue-renderer.test.ts
npm run typecheck
npm test
npm run electron:e2e:package
```

真实 Jellyfin 凭据、完整配置内容和播放 token 不参与本地状态验证。

专项结果：23 个 G27 相关测试通过；全量 19 个测试文件/109 个测试通过；Electron 编译和修复后的 3 次 packaged E2E（每次含首次与重启流程）通过；sidecar、fixture 和项目进程均已清理。

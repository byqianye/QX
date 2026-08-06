# QX 组件规格

所有组件使用 Vue 3 `<script setup lang="ts">`；Props 表达状态，emit 表达用户意图，禁止直接访问 Electron、网络或存储。交互元素必须键盘可达、拥有可见 focus-visible 和至少 44×44px 命中区。状态不能只靠颜色表达。

| 组件 | 责任 | 关键状态 |
| --- | --- | --- |
| `AppSidebar` | 一级导航、来源摘要、设置 | selected / loading / warning / error / disabled |
| `TopSearchBar` | 全局搜索与来源上下文 | idle / focus / loading / disabled / error |
| `SourceSwitcher` | API / Proxy / Spider / Jellyfin 来源切换 | selected / loading / warning / error / disabled |
| `CategoryTabs` | 内容分类 | selected / focus / disabled / loading |
| `FilterPanel` | 筛选与清除 | idle / loading / disabled / focus |
| `MediaCard` | 媒体信息与可用性 | hover / selected / playing / warning / error / disabled |
| `MediaGrid` | 响应式结果编排 | loading / empty / error / success |
| `DetailDrawer` | 保留上下文的详情层 | open / loading / warning / error / focus |
| `PlaybackLineTabs` | 线路、协议和状态 | selected / playing / proxy-required / unavailable / disabled |
| `EpisodeGrid` | 分集选择 | selected / playing / loading / disabled / empty |
| `EmbeddedPlayer` | MP4/HLS 播放承载 | loading / playing / paused / error / unavailable |
| `PlayerControls` | 播放、进度、音量、全屏 | hover / active / focus / disabled / playing |
| `EmptyState` | 无内容/未连接解释与动作 | empty / disabled |
| `LoadingState` | 固定尺寸加载骨架 | loading / reduced-motion |
| `ErrorState` | 用户可读原因与恢复动作 | error / warning / focus |
| `TrustConfirmationDialog` | 首次使用来源/LocalProxy 确认 | open / loading / error / focus |
| `SettingsSection` | 设置页分组 | idle / loading / success / error / disabled |
| `DiagnosticPanel` | 脱敏链路诊断 | success / warning / error / loading |

## 无障碍重点

搜索使用真实 input 和 label；分类与线路使用 tab 语义；信任弹窗支持 Enter/Escape 并恢复焦点；播放器失败文本位于可读 DOM 中；状态都有文字语义。高对比度和 reduced-motion 不得移除信息。

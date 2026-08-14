# NESweep 待办清单

> 生成时间: 2026-08-13
> 分支: `feat/streaming-and-ux-improvements`

## ✅ 已完成

| 项目 | 说明 |
|------|------|
| Clipboard 污染防护 | 新增 `sweep.includeClipboard` 配置（默认 false），剪贴板不再自动注入 prompt |
| 一键启用弹窗完善 | 启动时检测 → 弹窗 Enable/Never/Later → 确认后 UAC 自动完成 → 提示重启 |
| Jump edit 浮框预览增强 | hint 文本显示编辑内容预览（单行 diff / 多行摘要 / 全文截断） |
| 流式响应 (SSE) | `completion-client.ts` 支持 SSE 逐 token 接收，`onPartialResult` 回调，服务器不支持时自动回退 |
| Prompt 缓存复用 | LRU 缓存 (8 条目)，稳定上下文日志 |
| 编辑历史合并窗口 60s→120s | 合并窗口增大，减少 prompt 冗余 |
| closeSuggestWidget 兼容性 | 3 个命令名 fallback 链 |
| enableProposedApi 路径检测增强 | 自动扫描版本子目录，不依赖硬编码 |
| 多行编辑分步接受 | `acceptJumpEditLine()` 逐行接受；`Ctrl+Enter` 快捷键 |
| 错误监控 | `ErrorMonitor` 类，累计 5+ 错误弹警告，`sweep.showErrorLog` 命令 |
| 测试覆盖率提升 | `test/accept-line.test.ts` 验证逐行/全部接受 |
| 流式 usage 解析 | 从 SSE 最后一条消息解析 `prompt_tokens` / `completion_tokens` |

## 🆕 新功能

| 优先级 | 项目 | 说明 |
|--------|------|------|
| 🟡 中 | 多模型切换 | 支持在同一会话中切换不同模型，对比补全效果 |
| 🟡 中 | 补全置信度显示 | 利用模型返回的 `confidence` 字段，在 ghost text 旁显示指示器 |
| 🟡 中 | 代码片段模板 | 用户定义常用代码片段模板，光标在特定上下文中自动匹配 |
| 🟡 中 | 编辑差异对比视图 | 侧边栏显示当前编辑与原始代码的 diff 对比 |
| 🟡 中 | 自定义 Stop Tokens | 允许用户在设置中配置额外的 stop tokens |
| 🟢 低 | 补全历史记录 | 记录最近接受的补全，支持搜索和重用 |
| 🟢 低 | Workspace 级统计面板 | 显示接受率、平均响应时间、节省的击键次数 |
| 🟢 低 | 多光标支持 | 同时在多个光标位置显示补全 |
| 🟢 低 | 远程服务器状态监控 | 状态栏显示服务器连接状态、模型负载、排队请求数 |
| 🟢 低 | 自动模型探测 | 调用服务器 `/v1/models` 自动检测可用模型 |

## 🎯 UX 体验改进

| 优先级 | 项目 | 说明 |
|--------|------|------|
| 🟡 中 | NES 快捷键提示 | 状态栏显示当前可用快捷键（Tab 接受 / Alt+Tab 跳转 / Esc 取消） |
| 🟡 中 | 编辑接受/拒绝动画反馈 | 接受后闪烁绿色高亮，拒绝后淡出 |
| 🟡 中 | 编辑历史回滚 | 在最近几次 NES 建议之间切换（类似 Copilot 的 Alt+[/Alt+]） |
| 🟡 中 | 模型加载状态指示 | 状态栏显示加载动画 + 预计剩余时间 |
| 🟢 低 | 配置设置界面 | WebView 可视化面板，配置模型参数、提示词模板 |
| 🟢 低 | 模型返回垃圾响应容错 | 友好提示"模型返回异常，请检查服务器状态" |

## 🔧 工程化改进

| 优先级 | 项目 | 说明 |
|--------|------|------|
| 🟡 中 | CI/CD 自动打包 | GitHub Actions 自动构建和发布 `.vsix` |
| 🟡 中 | 测试覆盖率提升 | 为 `findProductJson`、`isProposedApiEnabled` 等编写单元测试 |
| 🟢 低 | 错误监控增强 | 关键错误汇总到日志面板，方便排查 |
# Zeta - Edit Prediction 功能列表

> 最后更新: 2026-08-18
> 版本: 1.2.8-build.70

---

## 核心渲染（官方 Copilot 逻辑，build.70）

| 功能 | 渲染方式 | 状态 |
|------|----------|------|
| NES 多行编辑 | `isInlineEdit=true` + `showInlineEditMenu` + `correlationId` + `action` → gutter 箭头 + hover 菜单 | ✅ 按官方实现 |
| INLINE 单行编辑 | `toInlineSuggestion` 返回有效 → ghost text（`isInlineEdit=false`） | ✅ 正常 |
| 渲染决策 | 官方 4 步算法：同行验证 → rebase 光标编辑 → 下一行插入 → NES | ✅ 已实现 |
| 跨文件编辑 | `uri` + `displayLocation(kind: Label)` | ⏳ 未实现（Zeta 暂无跨文件建议） |
| JUMP 装饰器回退 | `jumpEditManager.setPendingJumpEdit()` → SVG 装饰器框 | ⚠️ 备选，SVG 渲染异常 |

## 加载指示器

| 功能 | 说明 |
|------|------|
| 位置 | 光标行行尾（已修复 column 0 → 行尾） |
| 动画 | `◐◓◑◒` 四象限饼图旋转，250ms 帧间隔 |
| 标签 | ` ◐ Zeta` 灰色文本（`editorGhostText.foreground` 主题色） |
| 触发 | API 请求开始 → 显示，请求结束 → 隐藏 |
| 切换编辑器 | 自动在激活编辑器上显示 |

## P0-P3 功能

| 等级 | 功能 | 文件 | 说明 |
|------|------|------|------|
| P0 | 建议缓存 | `suggestion-cache.ts` | 光标移回编辑范围时直接重显缓存，不发请求 |
| P1 | 动态防抖 | `dynamic-debounce.ts` | 根据打字节奏动态调整防抖延迟 |
| P2 | 语法感知窗口扩展 | `syntax-window.ts` | 自动扩展编辑窗口到语法边界（括号深度） |
| P3 | 可配置缓存 | `config.ts` | 缓存阈值、编辑范围匹配、跳过防抖等配置项 |

## 请求与配置

| 设置 | 默认值 | 说明 |
|------|--------|------|
| `zeta.serverUrl` | `http://10.126.126.1:8889` | 模型服务器 URL |
| `zeta.modelName` | `zeta2.1` | 模型名 |
| `zeta.temperature` | `0.2` | 生成温度（0.0-2.0） |
| `zeta.maxTokens` | `2048` | 最大生成 token 数 |
| `zeta.completionTimeoutMs` | `15000` | 请求超时 |
| `zeta.editableTokens` | `2500` | 编辑上下文窗口大小 |
| `zeta.enabled` | `true` | 扩展开关 |
| `zeta.useCopilotStyleNextEditPresentation` | `true` | Copilot 风格 NES 渲染 |

## 提示上下文

| 设置 | 默认值 | 说明 |
|------|--------|------|
| `zeta.maxContextFiles` | `1` | 关联文件数 |
| `zeta.maxEditHistory` | `5` | 编辑历史条数 |
| `zeta.diagRadius` | `6` | 诊断信息范围 |
| `zeta.includeClipboardContext` | `false` | 剪贴板内容 |
| `zeta.maxClipboardLines` | `0` | 剪贴板最大行数 |
| `zeta.maxRecentChangesChars` | `5000` | 最近改动字符数 |
| `zeta.reuseIdenticalPromptResults` | `true` | 复用相同 prompt 结果 |

## 诊断与 UI

| 功能 | 说明 |
|------|------|
| 加载指示器 | 行尾 `◐◓◑◒` 旋转标签 |
| 请求日志 | 完整 trace/info 日志（provider entry、响应时间、分类等） |
| 设置 UI 本地化 | 36 项设置全中文，4 组分类 |
| 设置推荐值 | 关键术语加粗 + 推荐值/范围说明 |

## 其他功能

| 功能 | 说明 |
|------|------|
| 手动触发 | `Ctrl+Shift+Alt+Enter` 强制触发补全 |
| 自动授权引导 | 检测未授权时自动写入 `argv.json` + 弹窗提示重启 |
| Tab 键绑定 | `zeta.acceptInlineEditByTab` 命令 |
| 重触发循环修复 | `retriggerOnContextExit` 防无限循环 |
| 建议队列 | 多个建议排队，按顺序消费 |
| piggyback 链式请求 | 利用 FIM 格式的次请求优化 |
| 排除模式 | `zeta.autocompleteExclusionPatterns` 排除特定文件 |
| 流式输出 | 可选，默认关闭 |

## 已回退（不包含）

| 功能 | 原因 |
|------|------|
| 自定义 JUMP 装饰器 SVG（主方案） | SVG 渲染异常，改用官方 `isInlineEdit` + NES gutter 箭头 |
| `displayLocation` hint 指示器 | 官方仅诊断/跨文件场景使用，普通编辑不需要 |
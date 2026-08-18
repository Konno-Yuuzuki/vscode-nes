# Zeta - Edit Prediction 关键实现记录

> 最后更新: 2026-08-18
> 版本: 1.2.8-build.74

---

## 一、核心架构

### 1.1 渲染路径

```
模型输出 → normalizeInlineResult → classifyInlineResult
  → 分类结果: { decision: "JUMP" | "INLINE", reason: "..." }
  → manageInlineEdit:
    JUMP → useCopilotStyleNextEditPresentation?
      → true:  buildCompletionItem(..., { useProposedInlineEditPresentation: true })
                → toInlineSuggestion 判断能否作为 ghost text
                → isInlineCompletion = !!inlineSuggestion
                → isInlineEdit = !isInlineCompletion（NES）
                → correlationId + action + showInlineEditMenu
                → 双保险：同时 setPendingJumpEdit（装饰器回退）
      → false: jumpEditManager.setPendingJumpEdit()（装饰器）
    INLINE → buildCompletionItem（标准 ghost text）
```

### 1.2 关键决策

| 概念 | 官方 Copilot 做法 | Zeta 实现 |
|------|-------------------|-----------|
| `isInlineEdit` | `!isInlineCompletion` | 同官方 |
| `showInlineEditMenu` | `!(unification && inline)` | NES → true |
| `correlationId` | 总是设 | 同官方 |
| `action` | `learnMoreAction` | `zeta.acceptInlineEdit` |
| `showRange` | 仅跨文件 | 不设 |
| `displayLocation` | 仅诊断/跨文件 | 不设 |
| range/text 调整 | `inlineSuggestion?.range ?? range` | 同官方 |

### 1.3 toInlineSuggestion 4 步算法

```
① 同行编辑 → validateSameLineGhostText → 检查子词前缀
② advanced: tryRebaseAsCursorEdit → 重写为"光标→行尾"
③ tryAdjustNextLineInsertion → 下一行插入拉回光标
④ 都不行 → undefined → NES（isInlineEdit=true）
```

---

## 二、接受后预测触发链

### 2.1 问题

- NES 编辑（`isInlineEdit=true`）接受时，VS Code 的 `editor.action.inlineEdit.accept` 不执行 `item.command`
- 所以 `zeta.acceptInlineEdit` 命令（调 `handleInlineAccept`）不会被调用
- 下一次预测从不发起

### 2.2 解决方案（build.73-74）

**3 条接受路径全部触发 `handleInlineAccept()`：**

```
① 装饰器 Tab（zeta.hasJumpEdit=true）
  → zeta.acceptJumpEdit → jumpEditManager.acceptJumpEdit() + provider.handleInlineAccept()

② 原生 NES Tab（inlineEditVisible）
  → zeta.acceptInlineEditByTab → editor.action.inlineEdit.accept
    → 成功: provider.handleInlineAccept()
    → 失败: provider.acceptCurrentInlineEdit() + provider.handleInlineAccept()

③ item.command 执行
  → zeta.acceptInlineEdit → provider.handleInlineAccept(acceptedSuggestion)
```

**handleInlineAccept 设计：**

```typescript
handleInlineAccept(acceptedSuggestion?: AcceptedInlineSuggestion): void {
    // 从 lastInlineEdit 兜底，不依赖调用方传参
    const suggestion = acceptedSuggestion ?? this.lastInlineEdit?.suggestion;
    // 缓存失效 + 防抖重置 + trigger
}
```

### 2.3 关键设置

| 设置 | 默认值 | 说明 |
|------|--------|------|
| `zeta.maxRecentChangesChars` | 12000 | 编辑历史字符数（设为 0 则完全省略，导致下一次预测为空） |
| `zeta.skipDebounceOnAccept` | true | 接受后跳过防抖，立即触发下一次预测 |
| `zeta.useCopilotStyleNextEditPresentation` | true | 使用 proposed inline edit 渲染 |

---

## 三、编辑历史

### 3.1 数据流

```
用户编辑 → onDidChangeTextDocument
  → tracker.trackChange(event) → 记录 diff
  → buildInput → tracker.getEditDiffHistory()
  → prompt 中的 edit_history 部分
  → 模型看到编辑历史 → 推断下一步编辑意图
```

### 3.2 控制设置

| 设置 | 默认值 | 说明 |
|------|--------|------|
| `zeta.maxEditHistory` | 15 | 最多保留的 diff 记录数 |
| `zeta.maxRecentChangesChars` | 12000 | 编辑历史最大字符数，0=省略 |
| `zeta.reuseIdenticalPromptResults` | false | 复用相同 prompt 的缓存结果 |

---

## 四、防抖机制

### 4.1 动态防抖

```
DynamicDebounceTracker:
  - 记录最近 8 次 provider 调用间隔
  - 快速打字（中位 ≤ 100ms）→ 1.7× 防抖（更久）
  - 慢速/暂停（中位 ≥ 600ms）→ 0.5× 防抖（更快）
  - 钳位范围 [100, 600]ms
```

### 4.2 接受后防抖跳过

```typescript
if (config.skipDebounceOnAccept) {
    this.lastRequestTimestamp = 0;  // 防抖间隔 = 0，跳过
}
```

---

## 五、光标跳转（pendingProposedJump）

### 5.1 触发条件

```typescript
// buildCompletionItem 中设
if (useProposedInlineEditPresentation && startPosition.line !== position.line) {
    this.pendingProposedJump = { uri, version, targetLine, ... };
}
```

### 5.2 触发时机

```typescript
// handleCursorMove 中检查
private maybeRetriggerAfterProposedJump(document, position): boolean {
    if (!this.pendingProposedJump) return false;
    if (position.line 在 targetLine 附近) {
        // 触发下一次预测
        this.pendingProposedJump = null;
        // 延迟 100ms 后触发
    }
}
```

---

## 六、诊断信息

### 6.1 控制

| 设置 | 默认值 | 说明 |
|------|--------|------|
| `zeta.includeDiagnostics` | false | 是否在 prompt 中包含诊断信息 |
| `zeta.diagRadius` | 12 | 光标附近多少行内的诊断才包含 |
| `zeta.injectInlineDiagnostics` | false | 是否以内联注释形式注入诊断 |

### 6.2 修复历史

- build.71: 修复 `renderDiagnosticsAsComments` 参数错位（`lines` 数组被当作 `marker` 字符串，产生巨大输出）
- build.71: 添加 `zeta.includeDiagnostics` 开关，默认 false

---

## 七、已探索但放弃的方案

| 方案 | 尝试版本 | 放弃原因 |
|------|---------|---------|
| 自定义 JUMP 装饰器 SVG | build.54-65 | SVG 渲染异常，依赖 `setDecorations` |
| `displayLocation` + `kind: Label` | build.59-60 | 显示绿色空框，非官方行为 |
| `showRange` 在 NES 中 | build.60-61 | 官方普通 NES 不设此字段 |
| `toInlineSuggestion` 自行实现 | build.62 | 缺少 `tryRebaseAsCursorEdit` |
| `jumpEditManager` 主方案 | build.67 | 用户要求使用原生 `isInlineEdit` |

---

## 八、参考资料

| 资料 | 路径 |
|------|------|
| 官方 Copilot 源码 | `docs/research/copilot-src/` |
| 官方 vs Zeta 对照 | `docs/research/implementation-comparison.md` |
| 核心资料笔记 | `docs/research/copilot-inline-suggestions-notes.md` |
| Zed 调研 | `docs/zed-zeta-research.md` |
| 功能列表 | `docs/feature-list.md` |
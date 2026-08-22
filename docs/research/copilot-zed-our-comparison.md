# Copilot NES vs Zed vs 我们 — 完整对比报告

> 2026-08-22 | 版本: 1.2.8-build.83
> 对比范围: 请求编排、Prompt 格式、分类、渲染、接受、接受后触发

---

## 一、架构总览

![architecture-overview]

| 维度 | Copilot NES | Zed | 我们（build.83） |
|------|-------------|-----|-----------------|
| **模型** | 自研（GitHub Copilot 模型） | Zeta 2.1（Seed-Coder-8B） | Zeta 2.1（Seed-Coder-8B） |
| **Prompt 格式** | 同完成模型（无专用格式） | FIM + `### User Edits:...` + `### User Excerpt:...` | FIM + `<filename>edit_history` + marker 边界 |
| **VS Code 集成** | 内置扩展，无门控问题 | 独立编辑器（非 VS Code） | 第三方扩展，受 `_isAdditionsProposedApiEnabled` 门控 |
| **请求编排** | `_pendingStatelessNextEditRequest` 缓存 + 覆盖 | 300ms 固定防抖，每 buffer 独立 | 动态防抖 + piggyback 等待合并 |

---

## 二、请求编排（Request Scheduling）

### Copilot NES

```
文档变化 → 构建/更新 StatelessNextEditRequest
  → 已有 pending 请求？
    → 是 → 取消旧的，重新构建
  → 返回结果后缓存（CachedOrRebasedEdit）
  → 下次变化时，先检查缓存是否适用
    → 适用 → 直接返回（不请求模型）
    → 不适用 → rebase 调整位置 或 重新请求
```

**关键**：不依赖防抖，靠**缓存 + 结果复用**。连续输入时，每次变化取消旧请求、发新请求，但服务器侧有 `CachedOrRebasedEdit` 快速命中。

### Zed

```
打字暂停 ≥ 300ms（每 buffer 独立计时）
  → compute_cursor_excerpt（8192 tokens 预算）
  → 构建 FIM prompt
  → 请求模型 → 返回结果
  → 接受后立即刷新（300ms 节流，不跳过）
```

**关键**：固定 300ms 防抖，每 buffer 独立。接受后也经过 300ms 节流（不跳过）。无缓存机制（光标移出就 discard）。

### 我们（build.83）

```
打字暂停 ≥ 动态防抖（100-600ms，全局）
  → 通过 debounce → tryPiggyback
    → 有在途请求且未超时 → 等它完成（最多 8s）
    → 无在途或超时 → 取消旧的，发新请求
  → 结果返回 → 展示
  → 接受后 → handleInlineAccept → trigger（立即）
```

**关键**：动态防抖 + piggyback 合并。piggyback 在等待期间如果旧请求被取消，会重新检查 abort 信号（build.83 修复）。

### 对比

| 特性 | Copilot NES | Zed | 我们 |
|------|-------------|-----|------|
| 防抖方式 | 无（靠缓存覆盖） | 固定 300ms | 动态 100-600ms |
| 每 buffer 独立 | 是 | 是 | 否（全局） |
| 请求合并 | 缓存命中 | 无 | piggyback 等待 |
| 取消旧请求 | 每次变化都取消 | 每次变化都取消 | piggyback 成功时不取消 |
| 缓存 | 请求结果缓存（CachedOrRebasedEdit） | 无 | suggestionCache（光标移回重显） |
| 接受后触发 | 0 延迟（item.command） | 300ms 节流 | 0 延迟（handleInlineAccept） |

**我们的 piggyback 是三者中最激进的请求合并策略**——Copilot 和 Zed 都在每次变化时取消旧请求，我们则尽量等待。

---

## 三、Prompt 格式

### Copilot NES

与完成模型使用相同的 prompt 格式，没有独立的 NES prompt。模型输出通过 `toInlineSuggestion` 算法分类为 inline 或 NES。

### Zed (Zeta 2.1)

```
### User Edits:
File: path/file.rs:
@@ -80,5 +80,5 @@
...

### User Excerpt:
```path/file.rs
<|editable_region_start|>
...当前代码...
<|user_cursor_is_here|>
...更多代码...
<|editable_region_end|>
```
```

- 编辑历史（User Edits）是 diff 格式的最近编辑列表
- 可编辑区域（User Excerpt）包含 `<|editable_region_start|>` 和 `<|editable_region_end|>` 标记
- 光标位置用 `<|user_cursor_is_here|>` 标记

### 我们

```
<[fim-suffix]>...后缀内容...
<[fim-prefix]><filename>src/file.rs
...前缀内容...
<filename>edit_history
File: path/file.rs:
@@ -80,5 +80,5 @@
...

<filename>src/file.rs
<|marker_1|>
...代码...
<|marker_2|>
...代码...
<|user_cursor|>
...代码...
<|marker_N|>
<[fim-middle]>
```

- FIM 格式（`<[fim-suffix]><[fim-prefix]><[fim-middle]>`）
- 编辑历史作为单独 `<filename>edit_history` 段
- 代码区域用 `<|marker_N|>` 编号边界标记
- 光标位置用 `<|user_cursor|>` 标记

### 对比

| 特性 | Copilot NES | Zed | 我们 |
|------|-------------|-----|------|
| 格式 | 与完成模型相同 | `### User Edits + ### User Excerpt` | FIM + edit_history |
| 可编辑区域标记 | 无 | `<|editable_region_start/end|>` | `<|marker_N|>` 边界 |
| 光标标记 | 无 | `<|user_cursor_is_here|>` | `<|user_cursor|>` |
| 编辑历史 | 无显式段 | `### User Edits`（diff 格式） | `<filename>edit_history`（diff 格式） |
| 语法窗口 | 模型计算 | `compute_cursor_excerpt` + 语法扩展 | `selectZetaCursorWindow`（纯行向） |

**核心差异**：Zed 和我们都有显式的编辑历史。Copilot 没有——它的 NES 和完成模型是同一个，不需要额外上下文。

---

## 四、分类（Inline vs NES）

### Copilot NES

```
模型输出 → toInlineSuggestion():
  ① validateSameLineGhostText: 同行 + 子词前缀匹配 → 通过 → ghost text
  ② tryRebaseAsCursorEdit: 重写为"光标→行尾" → 通过 → ghost text
  ③ tryAdjustNextLineInsertion: 下一行纯插入 → 通过 → ghost text
  ④ 都不行 → undefined → NES（isInlineEdit=true）
```

规则：**ghost text 永远单行**（`validateSameLineGhostText` 拒含 `\n`）。

### Zed

```
模型输出 → 比较 edit 与 cursor 位置
  → 光标在编辑行范围内 → Edit（预览）
  → 光标不在编辑行范围内 → MoveWithin（跳转提示）
```

规则：**编辑行范围与光标位置的关系**决定。

### 我们

```
模型输出 → classifyInlineResult():
  → 编辑在光标前 + 多行 → JUMP (before-cursor-multiline)
  → 编辑在光标前 + 单行 → JUMP (before-cursor-single-line)
  → 编辑在光标处 + 多行 → JUMP (multiline-replacement-at-cursor)
  → 编辑在光标处 + 单行 → INLINE (same-line-replacement-at-cursor)
  → 编辑在同一行 → INLINE (same-line-replacement-at-cursor)
  → 编辑远离光标 → JUMP (far-from-cursor)
```

规则：**编辑位置 + 是否多行**决定。

### 对比

| 特性 | Copilot NES | Zed | 我们 |
|------|-------------|-----|------|
| 分类算法 | `toInlineSuggestion` 4 步 | `invalidation_range` 行范围 | `classifyInlineResult` 多条件 |
| 多行 ghost text | 从不（拒含 \n） | 不适用 | 可能（门控阻断时） |
| 编辑在光标前 | NES | Edit（预览） | JUMP（but 可能 ghost text） |
| 编辑远离光标 | NES | MoveWithin（跳转提示） | JUMP |
| 实现位置 | `isInlineSuggestion.ts` | `editor_edit_prediction.rs` | `edit-display-classifier.ts` |
| 与 prompt 格式关系 | 无（只分析输出） | 无（只分析输出位置） | 无（只分析输出位置） |

**我们的 `toInlineSuggestion` 算法已完整移植 Copilot 的 4 步**（`inline-suggestion.ts`）。但 `classifyInlineResult` 是独立实现的，与 Copilot 走不同的判定路径。

---

## 五、渲染

### Copilot NES

```
isInlineEdit=true → VS Code 原生 NES 渲染（gutter 箭头 + 悬停菜单）
showInlineEditMenu=true → 显示 gutter 菜单
action → gutter 菜单按钮（"Learn More" 打开文档）
correlationId → 遥测关联
```

**无装饰器回退，无双保险。**

### Zed

```
Edit → 在编辑行范围内显示预览（diff 标记高亮）
MoveWithin → 在光标位置显示"跳转"提示
```

**无 gutter 箭头**——Zed 不是 VS Code，没有 inlineEdit API。

### 我们

```
!isInlineCompletion → isInlineEdit=true → NES gutter 箭头（如果门控通过）
                   → setPendingJumpEdit → 装饰器框（双保险回退，build.83 保留）
```

**双保险**：既尝试 proposed API 渲染，又设置装饰器。

### 对比

| 特性 | Copilot NES | Zed | 我们 |
|------|-------------|-----|------|
| 原生 NES 渲染 | ✅ 原生 VS Code | N/A | ✅ 如果门控通过 |
| 装饰器回退 | 无 | N/A | ✅ setPendingJumpEdit |
| 多行 ghost text | 从不 | N/A | ⚠️ 门控阻断时 |
| gutter 箭头 | ✅ | N/A | ✅ 如果门控通过 |
| 悬停菜单 | ✅ showInlineEditMenu | N/A | ✅ |
| 依赖门控 | 无（内置扩展） | N/A | ⚠️ 是（第三方扩展） |

---

## 六、接受（Tab 处理）

### Copilot NES

**无 Tab 键绑定。** Tab 完全由 VS Code 原生处理：
- `isInlineEdit=true` → `editor.action.inlineEdit.accept` → 一次全部接受
- `isInlineEdit=false` → `editor.action.inlineSuggest.accept` → 一次全部接受

### Zed

Zed 不是 VS Code，Tab 处理在编辑器内部：
- Edit → 应用编辑替换
- MoveWithin → 光标跳转到目标行

### 我们

```
Tab → zeta.acceptInlineEditByTab（when: zeta.hasInlineSuggestion）
  → ① editor.action.inlineEdit.accept（原生 NES）
  → ② editor.action.inlineSuggest.accept（原生 inline）
  → ③ acceptCurrentInlineEdit()（手动应用）
  → handleInlineAccept() → 触发下一次预测
```

**三级兜底**：原生 NES → 原生 inline → 手动应用。

### 对比

| 特性 | Copilot NES | 我们 |
|------|-------------|------|
| Tab 键绑定 | 无 | `zeta.acceptInlineEditByTab` + `zeta.acceptJumpEdit` |
| 原生 NES 接受 | ✅ | ✅ 三级兜底 |
| 手动回退 | 无 | ✅ acceptCurrentInlineEdit |
| 接受后触发 | item.command → telemetry | item.command → handleInlineAccept → trigger |

---

## 七、当前关键问题（build.83）

| # | 问题 | 严重程度 | 影响 |
|---|------|---------|------|
| 1 | **`isInlineEdit` 门控阻断** | 高 | gutter 箭头不显示，多行退化为 ghost text |
| 2 | **`inlineSuggestionVisible` 不识别** | 高 | Tab 键绑定不触发（已用自定义 context key 修复） |
| 3 | **piggyback 等待时旧请求被取消** | 中 | 浪费 8s 等待时间（build.83 已修复 abort 检测） |
| 4 | **模型输出空响应（重复标记）** | 低 | 模型认为无需编辑，正常行为 |
| 5 | **全局 debounce vs 每 buffer 独立** | 低 | 切文件时可能触发不必要等待 |
| 6 | **纯行向窗口扩展 vs 语法扩展** | 低 | 上下文质量不如 Zed |

---

## 八、建议优先级

### 立即（P0）

1. **确认门控状态**：检查 `isInlineEdit` 是否真的传到了 workbench（VS Code 开发者工具看 item 属性）
2. **如果门控不通**：放弃 NES gutter 箭头，退化为**纯装饰器方案**（稳定可靠，Tab → acceptJumpEdit 一次全部接受）

### 短期（P1）

3. **每 buffer 独立 debounce**：参考 Zed，避免切文件时全局节流干扰
4. **语法感知窗口扩展**：参考 Zed 的 `expand_context_syntactically_then_linewise`，优先扩展到函数/类边界

### 长期（P2）

5. **增大窗口预算**：从 `2000+150` 到 `4000+300`，给模型更多上下文
6. **多文件编辑历史**：跨文件编辑时记录其他文件的 diff，作为上下文提供

---

## 九、参考资料

- Copilot 官方源码：`F:\下载\vscode-1.133.0\extensions\copilot\src\extension\inlineEdits\`
- Zed 研究笔记：`docs/zed-zeta-research.md`
- Copilot vs Zeta 对照：`docs/research/implementation-comparison.md`
- 核心资料笔记：`docs/research/copilot-inline-suggestions-notes.md`
- 关键实现记录：`docs/implementation-notes.md`
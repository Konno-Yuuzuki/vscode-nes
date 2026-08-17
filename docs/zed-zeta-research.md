# Zed 编辑器 Next-Edit 补全调研报告

> 调研日期：2026-08-17
> 源码版本：`zed-industries/zed` main branch
> 关键 crate：`crates/edit_prediction/`、`crates/editor/src/edit_prediction.rs`、`crates/zeta_prompt/`

## 调研来源

| 文件 | 行数 | 说明 |
|------|------|------|
| `crates/edit_prediction/src/edit_prediction.rs` | 3555 | 核心：事件追踪、节流、预测请求、接受/拒绝 |
| `crates/editor/src/edit_prediction.rs` | 2598 | 编辑器集成：显示/隐藏、接受、invalidation_range |
| `crates/edit_prediction/src/cursor_excerpt.rs` | 609 | 光标摘录计算、语法树扩展、行向扩展 |
| `crates/edit_prediction/src/prediction.rs` | 337 | 预测结果类型（Edit vs MoveWithin） |
| `crates/edit_prediction/src/fim.rs` | 244 | FIM（Fill-in-Middle）提示构建 |
| `crates/edit_prediction/src/zeta.rs` | 983 | Zeta 模型请求适配 |
| `crates/zeta_prompt/src/zeta_prompt.rs` | 7141 | Zeta 提示构建（巨大） |
| `crates/zeta_prompt/src/multi_region.rs` | 1833 | V0318 多区域标记 |
| `crates/zeta_prompt/src/excerpt_ranges.rs` | 443 | 摘录范围计算 |
| `crates/edit_prediction/src/zed_edit_prediction_delegate.rs` | 280 | 编辑预测委托实现 |
| `crates/edit_prediction/src/sweep_prompt.rs` | - | Sweep 提示格式 |

## 一、触发防抖（Debounce）

### Zed 的实现

**常量**（`edit_prediction.rs:2342`）：
```rust
pub const THROTTLE_TIMEOUT: Duration = Duration::from_millis(300);
```

**机制**（`queue_prediction_refresh`, `edit_prediction.rs:2508-2582`）：
- 每个 buffer 有一个 `last_edit_prediction_refresh: Option<(EntityId, Instant)>` 记录上次刷新时间
- 新请求到达时，检查同 buffer 是否在 300ms 内已刷新过：
  - 同一 buffer + 300ms 内 → 等待剩余时间（timer）
  - 不同 buffer → 不等待（立即刷新）
  - 300ms 已过 → 立即刷新
- 参数 `debounce: bool` 控制是否经过节流（`refresh_edit_prediction` 的 `debounce` 参数）：
  - `debounce=true`：经过 300ms 节流（打字触发、编辑暂停后触发）
  - `debounce=false`：跳过节流（初始化、全局设置变更、Vim 模式切换）

**触发时机**（`refresh_edit_prediction` 调用方）：
- `debounce=false`：初始化时（line 170）、显式请求（`show_edit_prediction`, line 333）
- `debounce=true`：Vim 模式切换（line 184）、接受后自动刷新（`PredictionAccepted`, line 485）、设置变更（line 221）

**编辑分组**（`edit_prediction.rs:1747-1764`）：
- `CHANGE_GROUPING_LINE_SPAN = 8` 行：连续编辑如果跨行 ≤ 8 行，合并为同一事件
- `LAST_CHANGE_GROUPING_TIME = 1s`：编辑暂停超过 1 秒，标记 `snapshot_after_last_editing_pause`（用于数据收集中的"暂停后快照"）

### 跟我们的对比

| 维度 | Zed | 我们（P0 + P1） |
|------|-----|-----------------|
| 基础值 | 300ms 固定 | 300ms 基准 + 动态调整 |
| 范围 | 每 buffer 节流 | 全局节流（`lastRequestTimestamp`） |
| 动态调整 | 无 | 有（基于打字中位间隔，100-600ms） |
| 接受后 | 经过 300ms 节流 | 经过 300ms 节流 |
| 暂停检测 | 1s 编辑分组标记 | 无（但动态防抖在慢速时降到 150ms） |

**结论**：Zed 用固定 300ms，我们已经在 P1 中实现了更先进的动态调整。Zed 的"每 buffer 独立节流"比我们"全局节流"更精确——如果用户在 A 文件打字时切换到 B 文件，Zed 不会等待 A 的节流时间。

## 二、Editable/Context 窗口划分（V0318）

### Zed 的实现

**Cursor Excerpt 计算**（`cursor_excerpt.rs:1-98`）：
- `CURSOR_EXCERPT_TOKEN_BUDGET = 8192` tokens —— 整个光标摘录的预算（比我们大得多）
- `compute_cursor_excerpt()`: 从光标行开始，对称扩展（先下一行、再上一行、交替），直到预算用完
- 每行 token 估算：`bytes / 3`（`BYTES_PER_TOKEN_GUESS = 3`），与我们的 `ESTIMATED_BYTES_PER_TOKEN = 3` 一致

**上下文扩展**（`cursor_excerpt.rs:136-187`）：
- `expand_context_syntactically_then_linewise()`: **两阶段扩展**
  1. **语法扩展**：尝试扩展到包含光标的最外层语法节点（函数、类、块），如果预算允许
  2. **行向扩展**：只有语法扩展无法进行（或预算不够）时，才退化为行向扩展
- 使用时：editable_range 参数传入，context_token_limit 传入，扩展可编辑区域外的上下文

**V0318 参数**（`zeta_prompt` crates，与我们的注释一致）：
- `MIN_BLOCK_LINES = 6` — 最少块行数
- `MAX_BLOCK_LINES = 16` — 最大块行数
- `MAX_NUDGE_LINES = 5` — 最大偏移行数（避免从结构尾部开始）

**FIM 模式**（`fim.rs:1-100`）：
- `FIM_CONTEXT_TOKENS = 512` — FIM 上下文预算（比 zeta 的 8192 小得多）
- 直接使用 `compute_cursor_excerpt` + `compute_editable_and_context_ranges` 计算
- 使用 `format_fim_prompt` 构建 FIM 格式提示

### 跟我们的对比

| 维度 | Zed | 我们 |
|------|-----|------|
| 总预算 | 8192 tokens | `editableTokens(2000) + zetaContextTokens(150)` |
| 扩展方式 | 对称（先下后上交替） | 对称（先上后下交替，`selectZetaCursorWindow`） |
| 语法扩展 | 有（两阶段：语法→行向） | 无（纯行向） |
| 上下文预算 | 由 `expand_context_syntactically_then_linewise` 动态决定 | 固定 150 tokens |
| V0318 参数 | 6/16/5（相同） | 6/16/5（相同） |
| 行估算 | bytes/3 | bytes/3 |

**结论**：Zed 的 `CURSOR_EXCERPT_TOKEN_BUDGET=8192` 远大于我们的 `2000+150`。这意味着 Zed 给模型提供更多上下文，但响应也更慢。Zed 的**语法感知扩展**是值得 P2 借鉴的——先按函数/类边界扩展，再退化到行向扩展，可以提高上下文质量。

## 三、光标移动时的隐藏/重显（Suggestion Cache）

### Zed 的实现

**invalidation_range 机制**（`editor_edit_prediction.rs:828-843`）：
```rust
// 光标不在 invalidation_range 内 → discard
if !invalidation_range.contains(&offset_selection.head()) {
    self.discard_edit_prediction(EditPredictionDiscardReason::Ignored, cx);
    return None;
}
```

**invalidation_range 计算**（`editor_edit_prediction.rs:945-966`）：
- `move_invalidation_row_range`：
  - 光标在编辑区上方（`cursor_row < edit_start_row`）：`cursor_row..edit_end_row`
  - 光标在编辑区下方（`cursor_row > edit_end_row`）：`edit_start_row..cursor_row`
  - 光标在编辑区内：`None`（不触发 move）
- 最终 `invalidation_row_range` = `edit_start_row..edit_end_row`（编辑行范围）

**Jump 类型**（`editor_edit_prediction.rs:959-973`）：
- 当光标在编辑区外且 provider 支持 jump → `EditPrediction::MoveWithin { target }` — 不显示编辑，只显示"移动光标到编辑处"
- 当光标在编辑区内 → `EditPrediction::Edit` — 显示编辑预览

**没有缓存重显机制**：Zed 使用 `discard_edit_prediction`（丢弃）而不是"隐藏+缓存"。光标移回编辑范围后，需要重新触发 `refresh_edit_prediction` 发出新请求。

### 跟我们的对比

| 维度 | Zed | Copilot NES | 我们（P0） |
|------|-----|-------------|-----------|
| 隐藏条件 | 光标移出编辑行范围 | 光标移出 ±3 行 | 光标移出 ±3 行 |
| 重显方式 | 无（丢弃后重新请求） | 缓存重显（不重新请求） | 缓存重显（不重新请求） |
| 缓存 | 无 | 有 | 有（15s TTL, 5 条目） |
| Jump 处理 | 显示为 MoveWithin | 显示为 Tab 跳转 | 显示为 proposed inline edit |

**结论**：我们 P0 的 suggestion cache 借鉴了 Copilot 的做法，不是 Zed 的。Zed 的 `invalidation_range` 使用**编辑行范围**而不是固定 ±3，这在编辑范围很大时更合理（大编辑不会因为光标移出 4 行就丢弃）。建议 P0 后续将阈值从固定 ±3 改为**编辑行范围**（在 `suggestionCache.store()` 时记录 `editStartLine` 和 `editEndLine`，在 `get()` 时用 `cursorLine ∈ [editStart - margin, editEnd + margin]` 判断）。

## 四、光标位置预测（P3）

### Zed 的实现

**模型输出中的光标标记**（`PredictedCursorPosition`）：
```rust
// edit_prediction_types/src/edit_prediction_types.rs
pub struct PredictedCursorPosition(pub Anchor, pub usize);
// Anchor 跟踪编辑位置，usize 是偏移量
```

- 光标位置来自于模型输出中的 `<|user_cursor|>` 标记（存在于 zeta_prompt 的解析逻辑中）
- 接受时：`Anchor` 跟踪编辑（biased right），然后加 `offset` 得到最终光标位置
- 没有独立的"光标预测模型"（如 Copilot 的 `himalia-001`）
- 没有"预测光标在编辑窗口内就跳过请求"的逻辑

**Fallback 行为**（`editor_edit_prediction.rs:440-447`）：
- 如果模型没有输出光标标记，使用 `last_edit_range.end`（编辑范围末尾）作为 fallback

### 跟我们的对比

| 维度 | Zed | Copilot NES | 我们 |
|------|-----|-------------|------|
| 光标来源 | 模型 `<\|user_cursor\|>` 标记 | 独立模型 himalia-001 | 模型 `<\|user_cursor\|>` 标记 |
| 独立预测模型 | 无 | 有（`max_tokens=40`） | 无 |
| 跳请求逻辑 | 无 | 预测光标在编辑窗口内→跳过请求 | 无 |

**结论**：Zed 和我们的做法一致——光标位置来自模型输出标记。Copilot 的独立光标预测模型（P3 方案 B）是 GitHub 独有的，Zed 没有做。**P3 方案 A（统计预测）**和**方案 C（接受后预取）**仍然是开放选项，但 Zed 的实践表明这不是必须的。

## 五、接受后扩窗（P2）

### Zed 的实现

**`accept_current_prediction`**（`edit_prediction.rs:1839-1882`）：
- 获取当前预测 → 取消所有 pending 预测 → 发送 accept 通知到服务器
- 没有显式的"shouldExpandEditWindow"标志

**预测后的刷新**（`editor_edit_prediction.rs:483-492`）：
```rust
self.update_visible_edit_prediction(window, cx);
if self.active_edit_prediction.is_none() {
    self.refresh_edit_prediction(true, true, PredictionAccepted, window, cx);
}
```
- 接受后立即刷新预测（debounce=true，经过 300ms 节流）
- 没有"扩窗"逻辑——接受后直接用相同的预算刷新

**编辑窗口由 excerpt 计算决定**：
- `compute_cursor_excerpt` 使用 `CURSOR_EXCERPT_TOKEN_BUDGET=8192` 固定预算
- 接受不会改变预算——每次请求都是相同的窗口大小

### 跟我们的对比

| 维度 | Zed | Copilot NES | 我们 |
|------|-----|-------------|------|
| 接受后扩窗 | 无 | 有（`shouldExpandEditWindow=true`） | 无（P2 待实现） |
| 接受后动作 | 立即刷新下一预测（300ms 节流） | 立即刷新下一预测 | 立即刷新下一预测（`trigger inlineSuggest`） |
| 窗口大小 | 固定 8192 tokens | 动态扩展 | 固定 2000+150 tokens |

**结论**：Zed 没有扩窗机制。`shouldExpandEditWindow` 是 Copilot NES 独有的。我们的 P2 设计（扩窗）是抄 Copilot 的，不是 Zed 的。Zed 使用固定预算（8192 tokens）比我们（2000）大得多，所以扩窗的需求可能没那么迫切。

## 六、综合对比总结

| 特性 | Zed | 我们的实现 | 建议 |
|------|-----|-----------|------|
| 防抖 | 300ms 固定，每 buffer | 300ms 动态[100-600]，全局 | 我们的 P1 更先进，但可借鉴"每 buffer 独立节流" |
| 窗口预算 | 8192 tokens | 2000+150 tokens | 适当增大（如 4000+300），语法扩展更好 |
| 语法扩展 | 有（两阶段） | 无（纯行向） | **P2 可借鉴：先语法边界→再行向** |
| 隐藏/重显 | invalidation_range（编辑范围） | ±3 行缓存 | 改为编辑范围+margin，保留缓存 |
| 光标预测 | 模型输出标记 | 模型输出标记 | 不做独立预测模型（P3 方案 B 不推荐） |
| 接受后扩窗 | 无 | 无（P2 待实现） | Copilot 特有，非必需 |
| Jump 类型 | MoveWithin/MoveOutside | INLINE/JUMP | 两者概念一致 |
| 屏跳 | 有 | 无 | 光标移出编辑范围→显示"跳转到编辑处" |

## 七、可借鉴建议（按优先级）

### P0（已实现）：Suggestion Cache
- 已实现：±3 行缓存重显
- **可优化**：阈值从固定 ±3 改为编辑行范围 + margin（如 `max(3, editRangeLines * 0.5)`）

### P1（已实现）：动态防抖
- 已实现：基于打字中位间隔动态调整 [100-600]ms
- **可优化**：改为每 buffer 独立节流（当前是全局节流）

### P2（待实现）：语法感知窗口扩展
- 参考 Zed 的 `expand_context_syntactically_then_linewise`
- 当光标在函数/类/块内时，优先扩展到语法边界
- 语法扩展失败时退化为行向扩展
- 不需要"扩窗"——Zed 用固定预算，效果已经很好

### P3（不建议独立实现）：光标预测
- Zed 没有独立预测模型，只用模型输出标记
- 我们的 `cursor_target_offset` 已覆盖
- 如果要改进，P3 方案 A（统计预测）最轻量

### 额外发现：Zed 的 FIM 模式
- `FIM_CONTEXT_TOKENS = 512`，比正常 zeta 模式小得多
- 适合本地轻量模型（Ollama）
- 我们也可以考虑提供"FIM 模式"作为轻量选项
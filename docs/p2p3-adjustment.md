# P2/P3 调整方向（基于 Zed 调研）

> 关键前提（来自用户服务器日志）：
> - Sakura：2×TITAN X (Pascal) 12GB，zeta-2.1 Q8_0
> - `n_ctx_slot = 8192`，模型原生 `n_ctx_train = 32768`
> - **实际可用上下文 = 8192 tokens/请求**（含生成）
> - 现在：`editableTokens 2000 + zetaContextTokens 150` ≈ 2500 tokens prompt，剩 ~5600 给生成

## 一、预算压力测算

**如果照抄 Zed 的 `CURSOR_EXCERPT_TOKEN_BUDGET = 8192`**：

```
editable(8192) + context(150) + related files(~500) + edit history(~500) + rules(~300)
≈ 9642 tokens prompt  ← 已超 8192
+ max_tokens(2048)
≈ 11690 tokens/请求   ← 放不进 slot，请求直接失败
```

**结论：完全不可行。** 用户服务器只有 8192 slot，Zed 跑在超大数据中心集群上（`predict_edits_v3/v4` 云 API），预算不一样。

**可用预算上限估算**（服务器侧约束）：

```
8192 slot
- 2048 max_tokens（生成要有空间）
- ~800 related files + edit history + rules + diagnostics
= ~5344 tokens 给当前文件
```

→ **当前文件预算理论上限约 5000 tokens，但建议留缓冲到 3500-4000**。

## 二、P2 调整：语法感知窗口扩展（借鉴 Zed，不抄预算）

**Zed 的做法**（`cursor_excerpt.rs:136-187`）：`expand_context_syntactically_then_linewise()`

```
阶段 1: 从光标所在语法节点（函数/类/块）向外尝试扩展
         - 每次取更大的包含节点，若预算够就采纳
         - 从最小的包含节点到最外层
阶段 2: 只有阶段 1 没有产生任何扩展时，才退化到逐行扩展
```

**我们的现状**：`selectZetaCursorWindow` 纯行向对称扩展（先上后下交替），无语法感知。

**P2 方案**：

1. **移植语法感知扩展算法**（不改预算，先保持 2000+150）
   - 在 `zeta2-prompt.ts` 的 `selectZetaCursorWindow` 前增加语法边界探测
   - 用树 sitter？**我们扩展环境没有 tree-sitter**。可以退而求其次：用缩进+括号深度近似（不引入原生依赖）
   - 或者：用 LSP 的 `documentSymbol`/`foldingRange`（已有 `outlineSymbols` 选项，可选开启）
2. **预算适度提升**（配置项，默认 2500~3000，上限受服务器 slot 限制）
   - 新增 `zeta.maxPromptTokens`（或复用 editableTokens）：默认 2500，最大 5000
   - 直接在设置 UI 里说明"不要超过服务器 ctx 的一半"
3. **不做 Copilot 的 shouldExpandEditWindow**（Zed 不做，且我们的预算本来就不大）

## 三、P3 调整：光标相关优化

**Zed 的实际行为**：
- 光标移出编辑行范围 → 丢弃建议，光标移回 → 重新请求（无缓存）
- 光标预测仅来自模型 `<|user_cursor|>` 标记
- **没有独立预测模型**

**我们的实际行为**（P0 已做）：
- 光标移出 ±3 行 → 隐藏；移回 → 缓存重显（比 Zed 强）

**P3 建议**（不引入独立模型，不引入统计预测）：

| 方案 | 内容 | 价值 | 成本 |
|------|------|------|------|
| A. 阈值改进 | P0 阈值从固定 ±3 改为 `max(3, 编辑行数×0.5)` | 大编辑更合理 | 低（改动小） |
| B. 光标跟踪链 | 接受建议后，若模型给了 `cursor_target_offset`，预取下一编辑（不重复请求同区域） | 连续编辑体验 | 中 |
| C. invalidation_range | 仿 Zed：缓存条目记录编辑行范围，光标在范围内保留、范围外丢弃 | 对齐 Zed 语义 | 低 |
| D. 独立预测模型 | Copilot himalia-001 式 | **不推荐**（Zed 不做，成本高） | 高 |

**推荐**：P3 = A + C（都是对 P0 缓存的小幅增强，低风险）。

## 四、最终推荐路线

| 优先级 | 内容 | 来源 | 风险 |
|--------|------|------|------|
| P2 | 语法感知窗口扩展 + 预算可配（默认 2500~3000） | Zed | 中（需要处理无 tree-sitter 的近似方案） |
| P3 | A：阈值 = max(3, 编辑行数×0.5)；C：invalidation_range 编辑行范围 | Zed + Copilot | 低 |
| ~~P3-B~~ | ~~独立预测模型~~ | ~~不推荐~~ | — |
| ~~P2 扩窗~~ | ~~shouldExpandEditWindow~~ | ~~Copilot 特有，预算不允许~~ | — |

## 五、预算对照表

| 配置 | 当前 | P2 建议 | Zed | 说明 |
|------|------|---------|-----|------|
| editableTokens | 2000 | 2500~3000（可配） | 8192 | 受服务器 slot 上限约束 |
| zetaContextTokens | 150 | 150~300 | 512 (FIM) | 保持 |
| 服务器可用 prompt | ~5000 | ~5000 | 超大(云端) | — |

## 需要你确认的点

1. **P2 预算默认值取多少？** 2500 保守 / 3000 激进 / 保持 2000（只做语法感知不动预算）
2. **语法边界探测用什么？** 纯启发式（缩进+括号深度，零依赖）/ LSP foldingRange（需语言服务器支持）/ 两者结合
3. **P3 只做 A+C，对吗？** 还是把 B（接受后预取）也加上？
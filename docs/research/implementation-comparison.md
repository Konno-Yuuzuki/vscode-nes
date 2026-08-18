# 官方 Copilot vs Zeta 实现对照（build.70）

> 2026-08-18 | 版本: 1.2.8-build.70
> 官方源码: `F:\下载\vscode-1.133.0\extensions\copilot\src\extension\inlineEdits\`
> Zeta 实现: `src/editor/inline-edit-provider.ts` (buildCompletionItem) + `src/editor/inline-suggestion.ts`

---

## 1. 逐项对照表

| # | 概念 | 官方 Copilot 实现 | Zeta 当前实现 | 移植方式 | 一致性 |
|---|------|-------------------|---------------|----------|--------|
| 1 | `toInlineSuggestion` 算法 | `isInlineSuggestion.ts` 独立文件，4 步：同行 → rebase → 下一行插入 → undefined | `inline-suggestion.ts` 独立文件 | **完整移植**（逐行复制，仅改 import） | ✅ 完全一致 |
| 2 | `isInlineCompletion` | **item 字段**（`NesCompletionItem.isInlineCompletion`）+ 局部变量，驱动渲染/telemetry/缓存标记 6 处 | **buildCompletionItem 局部变量**，仅驱动渲染分支 3 处 | 适配实现 | ⚠️ 值一致，载体不同 |
| 3 | `isInlineEdit` | `!isInlineCompletion`，NES → true | `!isInlineCompletion`，NES 时设 `true`，ghost text 保持 false | 适配实现 | ✅ 一致 |
| 4 | `showInlineEditMenu` | `!(unification && isInlineCompletion)` — 有 unification 实验开关 | NES → true，ghost text → undefined（默认 false） | 适配实现 | ⚠️ 逻辑等价，无 unification 开关 |
| 5 | `correlationId` | 总是设置（遥测） | 总是设置 | 适配实现 | ✅ 一致 |
| 6 | `action`（gutter 菜单按钮） | `learnMoreAction` = `{title: "Learn More", command: learnMoreCommandId}`（打开文档，不编辑） | `{title: "Zeta", command: "zeta.acceptInlineEdit"}`（接受编辑） | 适配实现 | ⚠️ 机制一致，命令语义不同，**待验证** |
| 7 | `displayLocation` | 仅诊断（kind: Code）和跨文件导航（kind: Label）时设；普通 NES 不设 | 不设 | 适配实现 | ✅ 一致 |
| 8 | `showRange` | 仅跨文件编辑时设；普通 NES 不设 | 不设 | 适配实现 | ✅ 一致 |
| 9 | range/text 调整 | `createCompletionItem(doc, doc, inlineSuggestion?.range ?? range, result, inlineSuggestion?.newText)` | `ghostRange = inlineSuggestion?.range ?? editRange`; `ghostText = inlineSuggestion?.newText ?? completion` | 适配实现 | ✅ 一致 |

---

## 2. 三个真正有差异的概念

### 2.1 `isInlineCompletion` — 官方是"贯穿全局的标记"，Zeta 是"局部变量"

官方代码同一请求里 `isInlineCompletion` 驱动 **6 处**：

```typescript
// 官方 L449-517
isInlineCompletion = !!inlineSuggestion;                          // ① 计算
completionItem = ... createCompletionItem(...);                   // ② 渲染分支
item.isInlineEdit = !isInlineCompletion;                          // ③ 传给 VS Code
item.showInlineEditMenu = !(unification && isInlineCompletion);   // ④ 菜单
item.isInlineCompletion = isInlineCompletion;                     // ⑤ 存到 item 上
// ⑥ handleDidShowCompletionItem 回调读它 → cacheEntry.wasRenderedAsInlineSuggestion
```

它被存在 `NesCompletionItem` 上（第 ⑤ 处），因为 `handleDidShowCompletionItem` 要读它判断"这条建议是否以 ghost text 形式显示过"，从而设置缓存标记（`wasRenderedAsInlineSuggestion`），配合 `nesMimicGhostTextBehavior` 门控阻止同一条建议以非 inline 形式重复出现。

**Zeta 只在 buildCompletionItem 局部用 3 次**（②渲染分支、③isInlineEdit、④showInlineEditMenu）。没有 telemetry、没有缓存标记需求 → 局部变量足够。**不是复制不了，是 Zeta 没有那么多消费方。**

### 2.2 `showInlineEditMenu` — 官方有 unification 开关

```typescript
// 官方
showInlineEditMenu: !(unification && isInlineCompletion),
```

- `unification` = Copilot 实验性的"模型统一"开关（多模型建议合并体验）
- **开启且是 ghost text** → 不显示菜单（ghost text 有自己的接受条）
- **其他情况** → true

Zeta 无 unification 实验，等价简化为：NES → true，ghost text → undefined（默认 false）。**在 Zeta 场景下逻辑完全相同**。

### 2.3 `action` — 机制一致，语义不同 ⚠️ 待验证

官方 action 是 **"Learn More"** 链接（点击打开 Copilot 文档），是 gutter 菜单里的辅助按钮，**不改变建议本身**。

Zeta 设为 **`zeta.acceptInlineEdit`**（接受编辑）。**待验证点**：VS Code 对 `action` 的点击处理是"执行 Command + 传 arguments"，但官方从未在 action 里放过接受命令（官方有独立 accept 机制）。若不好用，改为与官方一致放无副作用展示命令。

---

## 3. 为什么不能逐行复制（结构差异）

官方的 item 创建是**两层结构**：

```
nextEditProvider 产出 NextEditResult（edit/displayLocation/action/jumpToPosition）
  → createCompletionItem(doc, range, result, insertTextOverride?)
       → 返回基础 item { range, insertText, displayLocation?, command? }
  → 组装 NesCompletionItem { ...基础, isInlineEdit, showInlineEditMenu, correlationId, telemetryBuilder, info, wasShown, supportsRename }
```

Zeta 是**单层单方法**：`buildCompletionItem(document, position, result)`，输入 `AutocompleteResult`（id/startIndex/endIndex/completion/cursorTargetOffset）。

- 没有 `NextEditResult` 中间结构
- 没有 telemetryBuilder / suggestionInfo / cacheEntry / unification
- 有 Zeta 自己的 `pendingProposedJump`（光标移回重触发）、`jumpEditManager`（装饰器回退）、`suggestionCache`

所以：
- **完整移植**只对独立算法文件（第 1 项 `inline-suggestion.ts`）成立
- 第 2-9 项是把官方的字段规则**翻译到 Zeta 的单方法结构**里——结果一致，载体不同

---

## 4. build.70 实现记录

改动文件：
- `src/editor/inline-suggestion.ts` — 官方 4 步算法完整移植（含 `tryRebaseAsCursorEdit`）
- `src/editor/inline-edit-provider.ts` — `buildCompletionItem` 按官方逻辑重写：

```typescript
// 1. 计算 isInlineCompletion（官方 L451-452）
const inlineSuggestion = useProposedInlineEditPresentation
    ? toInlineSuggestion(position, document, editRange, result.completion)
    : undefined;
const isInlineCompletion = inlineSuggestion !== undefined;

// 2. 用调整后的 range/text 创建 item（官方 L455）
const ghostRange = inlineSuggestion?.range ?? editRange;
const ghostText = inlineSuggestion?.newText ?? result.completion;
const item = new vscode.InlineCompletionItem(insertText, ghostRange);

// 3. proposed 分支（官方 L507-518）
if (useProposedInlineEditPresentation) {
    proposed.correlationId = result.id;              // 总是设
    proposed.action = { title: "Zeta", command: "zeta.acceptInlineEdit", ... };  // gutter 菜单
    if (!isInlineCompletion) {                       // 仅 NES
        proposed.isInlineEdit = true;                // 官方: !isInlineCompletion
        proposed.showInlineEditMenu = true;          // 官方: !(unification && inline)
    }
}
```

验证：构建通过（207 modules），153 pass / 13 fail（无回归）。

---

## 5. 待验证点 / 待办

| # | 项目 | 说明 | 状态 |
|---|------|------|------|
| 1 | **`_isAdditionsProposedApiEnabled` 门控** | Zeta 的 proposed API 字段是否能通过自定义 VS Code 构建的门控 | 待用户实测 build.70 |
| 2 | **`action` 触发接受** | VS Code 点击 gutter 菜单 action 时是否执行 `zeta.acceptInlineEdit` 并传对 arguments | 待实测 |
| 3 | **跨文件 NES** | `uri` + `displayLocation(kind: Label)` + `jumpToPosition` 支持 | 未实现 |
| 4 | **诊断建议** | `displayLocation(kind: Code)` 诊断覆盖层 | 未实现（Zeta 有 diagnostics 上下文但未做 NES 诊断建议） |
| 5 | **`supportsRename`** | TS/TSX 重命名建议 | 未实现 |
| 6 | **缓存标记** | `wasRenderedAsInlineSuggestion` + mimic ghost text 门控 | 未实现（Zeta 缓存仅有 cursor-move-back 重显） |
| 7 | **unification 菜单条件** | ghost text 时菜单不显示（官方 `!(unification && inline)`） | Zeta 无条件，等价简化 |
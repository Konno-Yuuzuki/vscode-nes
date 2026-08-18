# 核心资料笔记 — Copilot Inline Suggestions / NES 渲染研究

> 2026-08-18

## 1. VS Code Proposed API 定义（vscode.proposed.d.ts）✅ 已获取

来源: https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.inlineCompletionsAdditions.d.ts

### InlineCompletionItem 扩展字段

```typescript
interface InlineCompletionItem {
    /** 设为 true → 该 item 被当作 inline edit 处理（产生 gutter 箭头/hover 菜单） */
    isInlineEdit?: boolean;

    /** 指定光标在哪个范围内时编辑可以显示 */
    showRange?: Range;

    /** 显示 inline edit 菜单 */
    showInlineEditMenu?: boolean;

    /** 跨文件编辑时指定目标文件 */
    uri?: Uri;

    /** gutter 菜单链接 action（注释 TODO: rename to gutterMenuLinkAction） */
    action?: Command;

    /** 显示位置（hint 锚点） */
    displayLocation?: InlineCompletionDisplayLocation;

    /** 遥测用 */
    correlationId?: string;

    /** 自动补/去括号 */
    completeBracketPairs?: boolean;

    /** 警告信息 */
    warning?: InlineCompletionWarning;

    /** 重命名支持 */
    supportsRename?: boolean;

    /** 纯光标跳转（无编辑文本时） */
    jumpToPosition?: Position;
}
```

### InlineCompletionDisplayLocation

```typescript
interface InlineCompletionDisplayLocation {
    range: Range;
    kind: InlineCompletionDisplayLocationKind;  // Code=1 | Label=2
    label: string;
}
```

**关键结论**：
- `isInlineEdit=true` + `showInlineEditMenu=true` + `correlationId` = NES gutter 箭头
- `showRange` / `displayLocation` 是**可选**的，只用于 notebook 导航、诊断等特殊场景
- Copilot 的 `nes-item.ts` 对普通编辑**只设** `isInlineEdit`、`showInlineEditMenu`、`correlationId`、`uri`，**不设** `showRange`/`displayLocation`

### InlineCompletionDisplayLocationKind

```
Code = 1   → 代码预览式 hint（diagnostics 覆盖层用）
Label = 2  → 标签式 hint（notebook 导航用）
```

## 2. VS Code 1.96 Release Notes（vscode-1.96.html）✅ 已获取

来源: https://github.com/microsoft/vscode-docs/blob/main/release-notes/v1_96.md

包含章节：
- GitHub Copilot（Free plan、Copilot Edits、Debugging with Copilot）
- Inline Chat
- Reworked inline failure messages

未找到 "inline suggestions open source" 专门公告——可能在其他 release 版本。

## 3. vscode-copilot-chat 扩展源码 ✅ 已获取仓库页

来源: https://github.com/microsoft/vscode-copilot-chat

- Copilot Chat 扩展已开源
- 仓库登录页未显示子目录内 inline 相关文件（GitHub API 限流，无法递归列出）
- 需要后续在本地 clone 或通过 raw URL 获取 `nes-item.ts`、`nes-provider.ts` 等关键文件

## 4. enhanced-working-diffs 扩展 ✅ 已获取市场页

来源: https://marketplace.visualstudio.com/items?itemName=enhanced-working-diffs

- 用 Decoration API 实现 diff 预览的参考实现
- 需在 marketplace 页面或源码仓库中查看具体实现

## 5. Pochi NES 渲染策略系列 ❌ 链接失效

来源: https://dev.to/pochi/how-do-you-build-serious-features-using-only-vs-codes-public-apis-4d3j

- 404，文章可能已删除或 URL 变更
- dev.to 用户 'pochi' 的文章 API 返回空数组
- 需用其他方式检索（web archive 等）

## 6. WinBuzzer 报道 ❌ 链接失效

来源: https://www.winbuzzer.com/2026/03/29/microsoft-open-sources-github-copilot-inline-code-suggestions-in-vs-code/

- 404，文章可能已删除或 URL 变更
- 日期 2026-03-29 为未来日期，可能是拼写错误

---

## 7. smallmain/vscode-unify-chat-provider NES 实现 ✅ 已获取

来源: https://github.com/smallmain/vscode-unify-chat-provider
本地: `docs/research/smallmain-ref/nes-item.ts`, `isInlineSuggestion.ts`, `proposed.d.ts`

### nes-item.ts 关键逻辑（Copilot NES item 渲染）

```typescript
// 决定 isInlineEdit 的核心：
// inline = toInlineSuggestion(...) 的结果（undefined = 不能作为 ghost text）
item.isInlineEdit = !inline;                  // NES 编辑 → true
item.showInlineEditMenu = inline ? !modelUnification : true;  // NES → true
item.correlationId = suggestion.requestId;    // 遥测
// 注意：普通 NES 编辑不设 showRange、不设 displayLocation！

// 特殊场景才设这些字段：
// - notebook 导航: displayLocation = { range, label, kind: Label }
// - diagnostics:   displayLocation = { range, label, kind: Code }
// - 光标跳转:      item.uri + item.jumpToPosition（无编辑内容时）
```

**关键发现**：普通 NES 编辑只设 3 个字段（`isInlineEdit`、`showInlineEditMenu`、`correlationId`），`showRange` 和 `displayLocation` 仅用于特殊场景。

### isInlineSuggestion.ts（判断能否作为 ghost text）

算法流程：
1. `tryAdjustNextLineInsertion` — 如果编辑是"下一行纯插入"（range 为空 + 多行新文本），调整 range 到下一行
2. `tryStripCommonLinePrefix` — 去掉公共行前缀
3. `range.start.line !== range.end.line` → 多行 → **返回 undefined**（不能作为 ghost text）
4. `range.start.line !== cursorPos.line` → 不在光标行 → **返回 undefined**
5. `validateSameLineGhostText` — 验证替换文本与光标位置的子词关系 + `isSubword` 检查
6. 全部通过 → 返回 `{ range, newText }`（作为 ghost text 渲染）

**关键结论**：多行编辑 → `toInlineSuggestion` 返回 undefined → `isInlineEdit = !inline = true` → NES 模式。

---

## 对当前 Zeta 扩展的启示

1. **`isInlineEdit=true` 是 NES 渲染的核心开关**——需要确认自定义 VS Code 构建的 `_isAdditionsProposedApiEnabled` 门控是否通过
2. **`showRange`/`displayLocation` 对普通 NES 编辑是可选**——Copilot 只设 `correlationId`
3. **`action` 字段可自定义 gutter 菜单**——TODO 注释确认它将被重命名为 `gutterMenuLinkAction`
4. **`uri` 支持跨文件编辑建议**
5. **`jumpToPosition` 支持纯光标跳转**（无编辑内容时），适合"建议下一个编辑位置"场景

---

## 8. 官方 Copilot 源码（vscode-1.133.0）✅ 已获取 — 最权威

来源: `F:\下载\vscode-1.133.0\extensions\copilot\src\extension\inlineEdits\`

### 8.1 inlineCompletionProvider.ts — item 创建（核心结论）

```typescript
// NesCompletionItem 字段设置（L507-518）——普通 NES 编辑：
const nesCompletionItem: NesCompletionItem = {
    ...completionItem,                    // range + insertText + displayLocation?
    info: suggestionInfo,
    telemetryBuilder,
    action: learnMoreAction,              // ← gutter 菜单的 Command
    isInlineEdit: !isInlineCompletion,    // ← NES → true（核心开关）
    isInlineCompletion,                   // ← 内部标记（非 API 字段）
    showInlineEditMenu: !(unification && isInlineCompletion),  // NES → true
    wasShown: false,
    supportsRename,                       // TS/TSX 才有
    correlationId,
};
```

**关键规则**：
- `isInlineEdit = !isInlineCompletion` — 能做 ghost text（`isInlineCompletion=true`）→ `false`；不能（NES）→ `true`
- `showInlineEditMenu = !(unification && isInlineCompletion)` — NES 场景总是 `true`
- `action` 字段**总是设置**（learnMoreAction）— 这是 gutter 菜单链接按钮
- `displayLocation` 来自 `result.displayLocation`（`createCompletionItem` L581-586），**普通 NES 编辑没有** → `undefined`

### 8.2 displayLocation 只在 2 种场景出现

| 场景 | 位置 | kind | 作用 |
|------|------|------|------|
| **诊断建议** | `features/diagnosticsBasedCompletions/diagnosticsCompletions.ts` L60-64 | `Code` | 诊断上方的代码覆盖层 |
| **跨文件 next-edit 导航** | `createNextEditorEditCompletionItem` L544-548 | `Label` | "Go To Next Edit" 标签 + 跳转命令 |

普通同文件 NES 编辑：**不设 displayLocation、不设 showRange**。

### 8.3 isInlineSuggestion.ts — 官方判定算法（比 smallmain 版更完整）

```typescript
export function toInlineSuggestion(cursorPos, doc, range, newText, advanced = true):
       InlineSuggestionEdit | undefined {
    // ① 同行编辑 → validateSameLineGhostText
    if (range.start.line === range.end.line && range.start.line === cursorPos.line) {
        const sameLineEdit = validateSameLineGhostText(cursorPos, doc, range, newText);
        if (sameLineEdit) return sameLineEdit;
    }
    // ② advanced: tryRebaseAsCursorEdit（把编辑重写为"光标→行尾"形式）
    if (advanced) {
        const cursorEdit = tryRebaseAsCursorEdit(cursorPos, doc, range, newText);
        if (cursorEdit) return cursorEdit;
    }
    // ③ tryAdjustNextLineInsertion（下一行纯插入 → 光标处插入）
    const nextLineInsertion = tryAdjustNextLineInsertion(cursorPos, doc, range, newText);
    if (nextLineInsertion) return nextLineInsertion;
    // ④ 都不行 → undefined → NES 模式（isInlineEdit=true）
    return undefined;
}
```

- `validateSameLineGhostText` — 光标在 range 内 + 替换文本前缀匹配 + `isSubword` 检查
- `tryRebaseAsCursorEdit` — 关键优化：把任意编辑重写为"从光标到行尾"的等价编辑（`advanced=true` 默认开）
- `tryAdjustNextLineInsertion` — 光标行尾 + 下一行 column 0 纯插入 → 拉回光标处

### 8.4 nextEditResult.ts — 结果类型

```typescript
interface INextEditDisplayLocation {
    range: Range;
    label: string;     // 无 kind（kind 在 provider 层补 Code/Label）
}

interface INextEditResult {
    result: {
        edit?: StringReplacement;           // 编辑本身
        displayLocation?: INextEditDisplayLocation;  // 可选
        targetDocumentId?: DocumentId;      // 跨文件
        action?: Command;                   // gutter action
        jumpToPosition?: Position;          // 纯光标跳转
        isSubsequentEdit: boolean;
    }
}
```

### 8.5 官方代码路径总结

```
nextEditProvider 产出 NextEditResult（edit + 可选 displayLocation/action/jumpToPosition）
  → inlineCompletionProvider:
      createCompletionItem → { range, insertText: edit.newText, displayLocation?, command: action? }
      → isInlineEdit: !isInlineCompletion（= false，此时 item 是纯 ghost text 候选）
      → 若 toInlineSuggestion 返回 undefined：
            isInlineCompletion = false → isInlineEdit = true → NES 渲染
      → 若 toInlineSuggestion 返回有效：
            isInlineCompletion = true → isInlineEdit = false → ghost text 渲染
```

**这就是 Zeta 需要的完整渲染决策链。**
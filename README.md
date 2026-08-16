## Zeta — Next Edit autocompletion for VSCode

<img width="563" height="327" alt="image" src="https://github.com/user-attachments/assets/9a06ed4a-bf9b-41e0-a21b-2178cb2c67b9" />

Zeta is a fork of [Sweep Next Edit](https://github.com/sweepai/vscode-nes)
that retargets the extension at a local OpenAI-compatible
`/v1/completions` server (e.g. llama.cpp's `llama-server`) running an
edit-prediction model. The upstream `uvx zeta-autocomplete` Python
child process — which falls back to CPU and is unusable for next-edit
latency — is removed.

## Features

- **Local OpenAI-compatible backend.** Posts to `/v1/completions` on
  any server you bring up (llama.cpp, vLLM, sglang, Ollama with the
  OpenAI shim).
- **SweepAI + Zed Zeta-2 / Zeta-2.1 models.** Format auto-detected
  from `zeta.modelName`. Zeta-2.1 uses Zed V0318-style numbered
  boundaries across one contiguous cursor-centered editable excerpt.
- **Targeted related-code context.** LSP definitions/usages are preferred,
  including distant definitions in the active file; visible and recent
  buffers fill the remaining related-context slots. A compact Document
  Symbols outline identifies the active class/function and nearby callables.
- **LSP-diagnostics aware.** Cursor-radius filter, cascading-error
  suppression below a root-cause line, and user-configurable regex
  rewrites on the messages (clang / clang-tidy presets included).
- **Per-language workspace rules.** `.vscode/nes-<languageId>.md`
  is editable from the Zeta status-bar menu with a configurable
  soft-cap warning when the file grows large enough to bloat latency.
- **Cache-friendly + persistent.** Stable content emitted first /
  volatile last for maximum prefix-cache hits; recent files, edits,
  and cursor positions survive window reload via `workspaceState`,
  so the model has context immediately after restart.
- **Status-bar menu + trace logging.** Toggle, snooze, ping server,
  edit instructions. Set the Zeta output channel to `Trace`
  (`Developer: Set Log Level… → Zeta`) for full request/response
  visibility.

## Edit Display Classification

The extension classifies every completion into one of three display modes
based on the cursor position relative to the edit range:

| Mode | Visual | Accept | Best for |
|------|--------|--------|----------|
| **INLINE** | Ghost text at the edit range start | ++tab++ (accept all) | Edits visible at the cursor position |
| **JUMP** | Decoration `→ Edit at line N` at the cursor | ++tab++ (accept all), ++ctrl+enter++ (single line) | Edits on a different line that the user must navigate to |
| **SUPPRESS** | Nothing shown | — | Transient boundary states (previously used for newline boundaries) |

### Classification rules

The decision is made by `classifyEditDisplay()` in
`src/editor/edit-display-classifier.ts`. The rules are evaluated in order:

```
┌─ Received completion ─────────────────────────────┐
│                                                    │
│ ① Far from cursor (3+ lines away)  ───→ JUMP       │
│ ② Edit starts before cursor offset  ───→ JUMP       │
│ ③ Cursor line not in edit lines     ───→ JUMP       │
│ ④ Cursor at edit start, multiline,                 │
│   on newline boundary ────────────────→ INLINE      │
│ ⑤ Cursor at edit start, multiline                  │
│   replacement ────────────────────────→ JUMP        │
│ ⑥ Cursor at edit start, same-line                  │
│   non-extending replacement ──────────→ JUMP        │
│ ⑦ Everything else (safe inline) ─────→ INLINE      │
└────────────────────────────────────────────────────┘
```

### Scenario reference

| # | Cursor vs edit range | Example | Mode | Reason |
|---|---------------------|---------|------|--------|
| 1 | **Far from cursor** (`cursorLine < editStartLine - 2` or `cursorLine > editEndLine + 2`) | Cursor on line 20, edit on lines 5–6 | JUMP | `far-from-cursor` |
| 2 | **Edit starts before cursor, multiline** (`startIndex < cursorOffset` + `\n` in completion) | Edit range 132–140, cursor at 137 | JUMP | `before-cursor-multiline` |
| 3 | **Edit starts before cursor, single-line** (`startIndex < cursorOffset`) | Cursor at col 25, edit replaces cols 5–20 on same line | JUMP | `before-cursor-single-line` |
| 4 | **Cursor line not in edit lines** (`cursorLine ∉ [editStartLine, editEndLine]`) | Cursor on line 5, edit on line 6 | JUMP | `not-on-cursor-line` |
| 5 | **At cursor, multiline, newline boundary** (`startIndex === cursorOffset` + `\n` + cursor after `\n`) | Pressed Enter at end of line, model suggests function body | INLINE | `single-newline-boundary` |
| 6 | **At cursor, multiline replacement** (`startIndex === cursorOffset` + `endIndex > startIndex` + `editEndLine > editStartLine`) | Cursor at start of a function, model replaces entire body | JUMP | `multiline-replacement-at-cursor` |
| 7 | **At cursor, same-line non-extending replacement** (`startIndex === cursorOffset` + replacement doesn't extend existing text) | Cursor after `"broken"`, completion replaces with `"*"` | JUMP | `same-line-replacement-at-cursor` |
| 8 | **At cursor, safe same-line extension** (fallthrough) | Cursor at end of `high`, completion extends to `highWatermark` | INLINE | `inline-safe` |

### Why JUMP for off-line edits?

VS Code's `InlineCompletionItem` (non-proposed API) renders ghost text at the
**start of the edit range**. If the start is on a different line than the cursor,
the ghost text is not visible to the user. The JUMP mode falls back to a
decoration at the cursor position (`→ Edit at line N`) so the user always knows
a suggestion exists, and can press ++tab++ to accept or ++ctrl+enter++ to accept
a single line.

When the `zeta.useCopilotStyleNextEditPresentation` setting is enabled (default: `true`),
JUMP completions render as a **proposed inline edit** with a
clickable jump affordance — the user sees the actual content at the edit
location and can navigate to it.

## Settings

| Key | Default | Purpose |
| --- | --- | --- |
| `zeta.serverUrl` | `http://localhost:8080` | `/v1/completions` base URL |
| `zeta.modelName` | `sweepai/zeta-next-edit` | `model` field in the request body; substring-matched to pick the prompt format |
| `zeta.completionTimeoutMs` | `10000` | Per-request timeout (ms) |
| `zeta.retriggerOnContextExit` | `false` | Opt in to requesting a completion after the cursor moves at least half the last model editable window, even with no text edit |
| `zeta.contextExitRetriggerDebounceMs` | `1500` | Debounce for context-exit cursor retriggers, allowing navigation to settle; `0` uses the next event-loop turn |
| `zeta.maxContextFiles` | `5` | Related excerpt cap; Zeta prioritizes LSP retrieval, then visible/recent buffers |
| `zeta.outlineSymbols` | `0` | Optional nearby LSP symbols plus the active symbol path for every model. Includes methods, fields, enum members, and globals when provided; asynchronous and separate from `maxContextFiles`, a positive value opts in |
| `zeta.maxRecentChangesChars` | `12000` | Character budget for formatted recent-edit history; `0` disables history |
| `zeta.maxClipboardLines` | `20` | Max lines of clipboard text included as retrieval context; `0` disables clipboard context |
| `zeta.stableRetrievalOrdering` | `false` | Sort retrieval chunks deterministically to improve prefix-cache reuse |
| `zeta.reuseIdenticalPromptResults` | `false` | Reuse recent temperature-0 results for byte-identical prompts |
| `zeta.identicalPromptCacheTtlMs` | `5000` | TTL for identical-prompt result reuse |
| `zeta.diagRadius` | `12` | ±N lines around cursor; `0` disables |
| `zeta.editableTokens` | `2000` | Shared approximate active-file budget, estimated as UTF-8 bytes / 3 and snapped to whole lines. Sweep allocates 2/3 before and 1/3 after the cursor; Zeta uses it for its editable excerpt. |
| `zeta.zetaContextTokens` | `150` | Approximate additional Zeta-2.1 current-file context budget, using the same tokenizer-free estimate |
| `zeta.rulesMaxChars` | `3000` | Soft cap on per-language workspace-rules file size; overflow surfaces as a diagnostic + red background in the editor |
| `zeta.injectInlineDiagnostics` | `false` | Inline `BUG:` comments next to diagnosed lines in the prompt — recommended for 0.5B / 1.5B sweep checkpoints |
| `zeta.inlineDiagnosticsMarker` | `BUG: LSP error here` | Marker phrase used by the inline injection + response-side strip anchor |
| `zeta.diagnosticsMessageTransforms` | clang preset | `{regex: replacement}` rewrites applied to every diagnostic message after the built-in normalisations |

Zeta always uses the suffix-first FIM layout and chronological context order
from its Zed training template. This prioritises edit quality over llama.cpp
prefix-cache reuse: moving the cursor can change the leading suffix and
invalidate the server cache.

## Setup

Run any supported edit-prediction GGUF behind an OpenAI-compatible
`/v1/completions` server. Examples with llama.cpp:

```sh
# Sweep Next Edit V2 7B
llama-server -hf henrik3/zeta-next-edit-v2-7B-GGUF --ctx-size 32768

# Sweep 1.5B (smaller, faster — turn on zeta.injectInlineDiagnostics)
llama-server -hf zeta-edit-prediction --ctx-size 32768

# Zeta-2 (Zed's SeedCoder-8B, single-region)
llama-server -hf bartowski/zed-industries_zeta-2-GGUF --ctx-size 16384

# Zeta-2.1 (Zed's SeedCoder-8B, multi-region)
llama-server -hf mradermacher/zeta-2.1-GGUF --ctx-size 16384
```

Then point `zeta.modelName` at the right name. Detection rules:

- `zeta-2.1` / `zeta2.1` / `zeta-2-1` / `zeta_2_1` → Zeta-2.1 multi-region
- `zeta2` / `zeta-2` / `seedcoder` → Zeta-2 single-region
- everything else → Sweep layout (default)

Sweep's GGUF advertises 32k natively; the full prompt routinely runs
15–20k tokens for non-trivial files, so a smaller `--ctx-size`
truncates real prompts. Zeta-2.1 follows the provider profile of roughly
350 editable and 150 surrounding-context tokens. Zeta estimates those
budgets as one token per three UTF-8 bytes and expands to whole lines around
the cursor, avoiding a real tokenizer in the extension-host hot path.

Build & install the extension:

```sh
bun install
bun run build
bunx @vscode/vsce package --no-dependencies --skip-license
code --install-extension zeta-edit-prediction-*.vsix --force
```

## Credits

- Original [Sweep Next Edit](https://github.com/sweepai/vscode-nes)
  by [SweepAI](https://github.com/sweepai).
- Sweep prompt format ported from
  [cursortab.nvim](https://github.com/cursortab/cursortab.nvim).
- Zeta-2 / Zeta-2.1 model card: [zed-industries on Hugging Face](https://huggingface.co/zed-industries).

## License

GNU Affero General Public License v3.0 or later — see [LICENSE](LICENSE).

The upstream repository [`sweepai/vscode-nes`](https://github.com/sweepai/vscode-nes)
does not ship a LICENSE file, but its initial commit
([`fcdfb50`](https://github.com/sweepai/vscode-nes/commit/fcdfb50) —
`init: Base vscode foundation based on zed impl`) is a line-for-line
TypeScript translation of
[`zed-industries/zed/crates/zeta/src/sweep_ai.rs`](https://github.com/zed-industries/zed/blob/76167109db7b/crates/zeta/src/sweep_ai.rs)
— the wire-protocol structs, the `ActionType` enum with its
`SCREAMING_SNAKE_CASE` serde rename, the brotli `(quality=11,
lgwin=22)` params, the hardcoded `https://autocomplete.zeta.dev/...`
endpoint, even the `// TODO`-fenced `privacy_mode_enabled: false`
were carried over verbatim. The Rust file was removed from Zed in
commit
[`42583c1`](https://github.com/zed-industries/zed/commit/42583c1)
on 2025-12-04, but at the time of the initial commit it was AGPL-3.0
as part of the Zed editor. Translating an AGPL work into another
language produces a derivative work covered by the same license, so
AGPL-3.0 attaches to the entire combined codebase regardless of
whether the upstream author shipped a LICENSE file. This fork makes
that licensing explicit.

Copyright attribution:

- Zed Industries, Inc. — original `sweep_ai.rs` (AGPL-3.0), ported in
  `src/api/schemas.ts`, `src/core/constants.ts`, and parts of
  `src/api/client.ts`.
- SweepAI and the upstream `sweepai/vscode-nes` contributors —
  VS Code-side glue (extension activation, inline-edit provider,
  document tracker, telemetry plumbing), itself a combined work
  covered by the same AGPL terms.
- This fork's authors — all subsequent commits.

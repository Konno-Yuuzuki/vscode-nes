	private buildCompletionItem(
		document: vscode.TextDocument,
		position: vscode.Position,
		result: AutocompleteResult,
		options: CompletionItemBuildOptions = {},
	): vscode.InlineCompletionList | undefined {
		// Fire-and-forget close of the suggest widget: if it's visible it
		// would block the ghost text. Do NOT await — that delays the
		// completion and can cause the request to be cancelled by a
		// subsequent keystroke.
		if (config.useCopilotStyleNextEditPresentation) {
			void hideSuggestWidget();
		}

		const cursorOffset = document.offsetAt(position);
		const startPosition = document.positionAt(result.startIndex);
		const endPosition = document.positionAt(result.endIndex);
		const editRange = new vscode.Range(startPosition, endPosition);

		logger.info("Creating inline edit:", {
			id: result.id,
			startPosition: `${startPosition.line}:${startPosition.character}`,
			endPosition: `${endPosition.line}:${endPosition.character}`,
			cursorPosition: `${position.line}:${position.character}`,
			cursorOffset,
			startIndex: result.startIndex,
			endIndex: result.endIndex,
			completionPreview: result.completion.slice(0, 100),
		});
		logger.trace("Creating inline edit completion:", result.completion);

		const useProposedInlineEditPresentation =
			options.useProposedInlineEditPresentation &&
			config.useCopilotStyleNextEditPresentation;

		if (
			result.startIndex < cursorOffset &&
			!useProposedInlineEditPresentation
		) {
			logger.debug(
				"Edit before cursor cannot be shown as ghost text; falling back to jump edit",
				{
					id: result.id,
				},
			);
			this.jumpEditManager.setPendingJumpEdit(document, result);
			return undefined;
		}

		if (this.lastInlineEdit?.suggestion.id !== result.id) {
			this.clearInlineEdit("replaced by new inline edit", {
				hideSuggestion: false,
			});
		}

		const acceptedSuggestion: AcceptedInlineSuggestion = {
			id: result.id,
			uri: document.uri.toString(),
			startIndex: result.startIndex,
			endIndex: result.endIndex,
			completion: result.completion,
			...(useProposedInlineEditPresentation &&
			result.cursorTargetOffset !== undefined
				? { cursorTargetOffset: result.cursorTargetOffset }
				: {}),
		};
		const insertText =
			result.cursorTargetOffset !== undefined &&
			!useProposedInlineEditPresentation
				? toSnippetWithCursor(result.completion, result.cursorTargetOffset)
				: result.completion;
		const item = new vscode.InlineCompletionItem(insertText, editRange);
		if (
			useProposedInlineEditPresentation &&
			startPosition.line !== position.line
		) {
			this.pendingProposedJump = {
				uri: document.uri.toString(),
				version: document.version,
				targetLine: startPosition.line,
			};
			logger.debug("Watching proposed jump target", {
				targetLine: startPosition.line,
				originLine: position.line,
			});
		} else {
			this.pendingProposedJump = null;
		}
		const replacedText = document.getText(editRange);
		if (replacedText && !result.completion.startsWith(replacedText)) {
			item.filterText = replacedText;
		}
		item.command = {
			title: "Accept Sweep Inline Edit",
			command: "zeta.acceptInlineEdit",
			arguments: [acceptedSuggestion],
		};
		if (useProposedInlineEditPresentation) {
			const proposedOptions: Parameters<typeof markAsProposedInlineEdit>[1] = {
				correlationId: result.id,
			};
			if (options.displayLocation) {
				proposedOptions.displayLocation = options.displayLocation;
			}
			markAsProposedInlineEdit(item, proposedOptions);
		}

		this.lastInlineEdit = {
			uri: document.uri.toString(),
			line: position.line,
			character: position.character,
			version: document.version,
			suggestion: acceptedSuggestion,
		};
		return enableForwardStability({ items: [item] });
	}
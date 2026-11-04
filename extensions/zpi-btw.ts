/**
 * zpi-btw — /btw: ask a one-off side question.
 *
 * The question inherits the full main-session context (system prompt and
 * the current branch's conversation) but is answered by a separate model
 * call, so nothing enters the main conversation. The Q&A block appears in
 * the live transcript immediately and the answer streams into it, delta by
 * delta. While the side call runs, a `working` line sits under the answer —
 * the working row above the editor belongs to the session's own agent run and
 * never appears for a side question. The block is visually identical to a
 * session entry but held in process memory only:
 * nothing is ever written to the session file or disk, and
 * the command handler returns while the side call runs, so the editor
 * stays free. The side thread replays into follow-up questions;
 * everything is gone when pi exits.
 *
 * The request is the session's own request: the transcript is replayed
 * exactly as pi projects it for the model — the leading system message brings
 * the prompt and the tool declarations — so nothing about the context, the
 * prompt, or the tools is added or cropped, and the model cannot tell the side
 * question apart from a real turn. The only difference is that no tool runs:
 * every call, whatever the tool, gets one and the same notice as its result
 * and the model answers from what it already knows. The block renders text
 * blocks only, so thinking and tool calls never appear in it.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { convertToLlm, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";

interface BtwBlock {
	question: string;
	// null while the side call is still running, and stays null when it
	// was interrupted — only completed answers replay into follow-ups.
	answer: string | null;
	box: Box;
	// Bottom line: `working` while the call runs, then the failure or
	// interruption text; gone once the answer settles.
	status: Text;
	md: Markdown | undefined;
}

// Process-wide state keyed on globalThis so /reload keeps blocks, the
// transcript hook, and the side threads alive.
const shared: {
	threads: Map<string, BtwBlock[]>;
	tui: any;
	chat: any;
	sessionId: string;
} = ((globalThis as any)[Symbol.for("zpi-btw-state")] ??= {
	threads: new Map<string, BtwBlock[]>(),
	tui: undefined,
	chat: undefined,
	sessionId: "",
});

const FALLBACK_PROMPT = "You are a helpful assistant answering a side question about the current coding session. Be concise.";

// The one thing the side call adds: no tool runs, so every call — whatever
// the tool — gets this same text as its result and the model answers from what
// it already knows. It is told nothing else, because changing the leading
// prompt or the tool declarations would break the cached prefix the request
// shares with the session and re-bill the whole conversation.
const TOOL_NOTICE =
	"This is a by-the-way side question: the conversation runs outside the agent loop, so no tool is available and no tool call can be executed. Answer the question directly from the information already present in the conversation.";

// The chat container is the third child (header, loaded-resources, chat)
// of the first child (document container) of the interactive renderer.
function findChatContainer(tui: any): any {
	const doc = tui?.children?.[0];
	const chat = doc?.children?.[2];
	if (!chat || typeof chat.addChild !== "function" || typeof chat.clear !== "function") return undefined;
	return chat;
}

// rebuildChatFromMessages / compaction clear the chat container and
// re-render from session entries; re-append this session's blocks after
// every clear so they survive branch switches and compaction.
function installClearHook(chat: any): void {
	if (chat.__btwClearPatched) return;
	chat.__btwClearPatched = true;
	const orig = chat.clear.bind(chat);
	chat.clear = () => {
		orig();
		for (const block of shared.threads.get(shared.sessionId) ?? []) {
			chat.addChild(block.box);
		}
	};
}

// The status line always follows the answer, so it is kept last.
function statusToEnd(block: BtwBlock): void {
	block.box.removeChild(block.status);
	block.box.addChild(block.status);
}

// The block shows `btw <question>` with the status line under it; the answer
// streams into a Markdown child between the two.
function buildBlock(question: string, theme: Theme): BtwBlock {
	const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(theme.fg("accent", theme.bold("btw")) + theme.fg("dim", ` ${question}`), 0, 0));
	const status = new Text(theme.fg("dim", "working"), 0, 0);
	box.addChild(status);
	return { question, answer: null, box, status, md: undefined };
}

// Start (or reuse) the streaming Markdown child between the two lines.
function startStreaming(block: BtwBlock): Markdown {
	if (!block.md) {
		block.md = new Markdown("", 0, 0, getMarkdownTheme());
		block.box.addChild(block.md);
		statusToEnd(block);
		block.box.invalidate();
	}
	return block.md;
}

function resolveBlock(block: BtwBlock, answer: string): void {
	block.answer = answer;
	startStreaming(block).setText(answer);
	// Done: the status line disappears.
	block.box.removeChild(block.status);
	block.box.invalidate();
}

// A failed call keeps whatever streamed and puts the failure on the status
// line, verbatim and without decoration.
function failBlock(block: BtwBlock, message: string, theme: Theme): void {
	block.answer = null;
	block.status.setText(theme.fg("error", `failed: ${message}`));
	statusToEnd(block);
	block.box.invalidate();
}

// Interrupted side calls stop where they are: the block keeps whatever
// streamed so far and shows an "interrupted" marker instead of vanishing.
// A block with nothing streamed yet is empty — it is removed entirely,
// from the transcript and the thread. Remaining answers stay null, so
// they are skipped in later thread replay.
function stopBlock(block: BtwBlock, streamed: string, theme: Theme, session: string): void {
	if (streamed) {
		startStreaming(block).setText(streamed);
		block.status.setText(theme.fg("warning", "interrupted"));
		statusToEnd(block);
		block.box.invalidate();
		return;
	}
	const list = shared.threads.get(session);
	if (list) {
		const index = list.indexOf(block);
		if (index !== -1) list.splice(index, 1);
	}
	if (shared.sessionId === session && shared.chat) shared.chat.removeChild(block.box);
}

// The session's conversation, projected by pi itself (compaction checkpoints,
// context edits, custom messages, branch summaries included) and converted with
// the same function the agent loop uses. The projection starts with the system
// message that carries the prompt and the tool declarations, so it is replayed
// as it is — nothing is filtered out and nothing is added. Only the completed
// side thread is appended on top.
// A replayed side answer is a full assistant message with zero usage. Without
// a usage object, sizing the request to the context window throws: that
// estimate reads `usage.totalTokens` off whichever assistant message looks
// newest, and the replayed one is the newest by construction.
function noUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function contextMessages(ctx: any): Message[] {
	const messages = convertToLlm(ctx.sessionManager.buildSessionProjection().messages);
	const model = ctx.model;
	for (const block of shared.threads.get(sessionIdOf(ctx)) ?? []) {
		if (block.answer === null) continue;
		messages.push({ role: "user", content: [{ type: "text", text: block.question }], timestamp: Date.now() } as Message);
		messages.push({
			role: "assistant",
			content: [{ type: "text", text: block.answer }],
			api: model?.api ?? "unknown",
			provider: model?.provider ?? "unknown",
			model: model?.id ?? "unknown",
			usage: noUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		} as Message);
	}
	return messages;
}

// The tools the session declares to the model, in the order it declares them.
// Only used for a transcript that does not carry a leading system message yet,
// i.e. before the first turn has persisted the prompt and the declarations.
function declaredTools(pi: ExtensionAPI): any[] {
	const byName = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
	return pi.getActiveTools().flatMap((name) => {
		const tool = byName.get(name);
		return tool ? [{ name: tool.name, description: tool.description, parameters: tool.parameters }] : [];
	});
}

function sessionIdOf(ctx: any): string {
	return ctx.sessionManager?.getSessionId?.() ?? "";
}

function answerText(response: any): string {
	return (response?.content ?? [])
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("\n");
}

// Text from separate rounds is one answer, so rounds are separated by a blank
// line; an empty side contributes nothing.
function joinText(a: string, b: string): string {
	if (!a) return b;
	if (!b) return a;
	return `${a}\n\n${b}`;
}

// One zero-flicker ui.custom round-trip to capture the live TUI: the
// factory resolves done() synchronously, so custom() returns before the
// component swap can paint (same pattern as the interactive-shell
// example). Reload and TUI-mode switches recreate the renderer, so the
// transcript container is re-found from the cached TUI on every call and
// the clear hook is re-installed on the fresh container.
async function ensureChatContainer(ctx: any): Promise<any> {
	if (!shared.tui) {
		const tui = await ctx.ui.custom((live: any, _theme: any, _kb: any, done: (v: any) => void) => {
			done(live);
			return { render: () => [], invalidate: () => {}, focused: false, handleInput: () => {} };
		});
		if (!tui) return undefined;
		shared.tui = tui;
	}
	shared.chat = findChatContainer(shared.tui);
	if (shared.chat) installClearHook(shared.chat);
	return shared.chat;
}

function themeOf(ctx: any): Theme {
	return (ctx.ui as any).theme;
}

// Streams one side call and keeps answering tool calls with the notice. The
// model sees an ordinary conversation: its assistant message and one tool
// result per call go back exactly as they came (no block dropped, nothing
// rewritten), only with every tool result saying the tool cannot run here.
// Filtering is display-only — the block shows text blocks and nothing else.
async function runSideCall(params: {
	ctx: any;
	model: any;
	systemPrompt: string;
	tools: any[];
	messages: Message[];
	controller: AbortController;
	block: BtwBlock;
	theme: Theme;
	session: string;
}): Promise<void> {
	const { ctx, model, systemPrompt, tools, messages, controller, block, theme, session } = params;
	// The agent loop hands the provider nothing but the transcript: the leading
	// system message carries the prompt and the tool declarations, so replaying
	// the projection untouched is the session's own request. Only when the
	// transcript has no leading system message yet (no turn persisted one) do
	// prompt and declarations have to be passed alongside, exactly as
	// normalizeContext would fold them in.
	const base = messages[0]?.role === "system" ? { messages } : { systemPrompt, tools, messages };
	// Every text block written so far, rounds joined; roundText is the round
	// currently streaming and is what the remaining display is built from.
	let answer = "";
	let roundText = "";
	try {
		for (;;) {
			roundText = "";
			let finalMessage: any;
			const stream = ctx.modelRegistry.streamSimple(model, base, { signal: controller.signal });
			for await (const event of stream) {
				// Only text blocks are the answer's body: thinking and tool
				// calls (start/delta/end) are deliberately not rendered.
				if (event.type === "text_delta") {
					roundText += event.delta;
					startStreaming(block).setText(joinText(answer, roundText));
					shared.tui?.requestRender?.();
				} else if (event.type === "done") {
					finalMessage = event.message;
				} else if (event.type === "error") {
					finalMessage = event.error;
				}
			}
			if (finalMessage?.stopReason === "aborted" || controller.signal.aborted) {
				stopBlock(block, joinText(answer, roundText), theme, session);
				shared.tui?.requestRender?.();
				return;
			}
			if (finalMessage?.stopReason === "error") {
				// Keep whatever streamed and report the failure on its line.
				const partial = joinText(answer, roundText);
				if (partial) startStreaming(block).setText(partial);
				failBlock(block, finalMessage.errorMessage || "model error", theme);
				shared.tui?.requestRender?.();
				return;
			}
			const text = answerText(finalMessage) || roundText;
			const toolCalls: any[] = (Array.isArray(finalMessage?.content) ? finalMessage.content : []).filter(
				(c: any) => c?.type === "toolCall",
			);
			if (toolCalls.length === 0) {
				// Resolve into the block even when the session changed
				// mid-flight; the clear hook re-appends it when that session
				// becomes active again.
				resolveBlock(block, joinText(answer, text) || "(no answer)");
				shared.tui?.requestRender?.();
				return;
			}
			answer = joinText(answer, text);
			messages.push(finalMessage as Message);
			for (const call of toolCalls) {
				messages.push({
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: TOOL_NOTICE }],
					isError: false,
					timestamp: Date.now(),
				} as unknown as Message);
			}
		}
	} catch (err: unknown) {
		if (controller.signal.aborted) {
			stopBlock(block, joinText(answer, roundText), theme, session);
		} else {
			failBlock(block, err instanceof Error ? err.message : String(err), theme);
		}
		shared.tui?.requestRender?.();
	}
}

export default function zpiBtwExtension(pi: ExtensionAPI) {
	pi.registerCommand("btw", {
		description: "Ask a side question; the answer lands in the transcript (in-memory only)",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (!question) {
				ctx.ui.notify("Usage: /btw <question>", "error");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/btw requires interactive mode", "error");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const chat = await ensureChatContainer(ctx);
			if (!chat) {
				ctx.ui.notify("btw: transcript container unavailable", "error");
				return;
			}

			const messages = contextMessages(ctx);
			messages.push({ role: "user", content: [{ type: "text", text: question }], timestamp: Date.now() } as Message);

			// ctx.getSystemPrompt() is a live view of the current system prompt and is
			// part of ExtensionContext; the try/catch covers a runner
			// that is no longer active.
			let systemPrompt = FALLBACK_PROMPT;
			try {
				systemPrompt = ctx.getSystemPrompt?.() || FALLBACK_PROMPT;
			} catch { /* session not active; fall back */ }

			const controller = new AbortController();
			ctx.signal?.addEventListener?.("abort", () => controller.abort());

			const model = ctx.model;
			const theme = themeOf(ctx);
			const targetSession = sessionIdOf(ctx);
			shared.sessionId = targetSession;

			// Show the block in the transcript right away, before any
			// answer exists.
			const block = buildBlock(question, theme);
			const list = shared.threads.get(targetSession) ?? [];
			list.push(block);
			shared.threads.set(targetSession, list);
			chat.addChild(block.box);
			shared.tui?.requestRender?.();

			void runSideCall({
				ctx,
				model,
				systemPrompt,
				tools: declaredTools(pi),
				messages,
				controller,
				block,
				theme,
				session: targetSession,
			});
		},
	});

	pi.on("session_start", async (_event, ctx: any) => {
		shared.sessionId = sessionIdOf(ctx);
	});
}

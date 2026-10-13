/**
 * zpi-btw — /btw: ask a one-off side question.
 *
 * The question inherits the full main-session context (system prompt and
 * the current branch's conversation) but is answered by a separate model
 * call, so nothing enters the main conversation. The Q&A block appears in
 * the live transcript immediately — first showing only "asking…" — and
 * the answer streams into the same block in place, delta by delta. The
 * block is visually identical to a session entry but held in process
 * memory only: nothing is ever written to the session file or disk, and
 * the command handler returns while the side call runs, so the editor
 * stays free. The side thread replays into follow-up questions;
 * everything is gone when pi exits.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";

interface BtwBlock {
	question: string;
	// null while the side call is still running, and stays null when it
	// was interrupted — only completed answers replay into follow-ups.
	answer: string | null;
	box: Box;
	placeholder: Text;
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

// The block shows the question immediately with an "asking…" placeholder;
// while the answer streams, the placeholder is swapped for a Markdown
// child that is rewritten with each accumulated delta.
function buildBlock(question: string, modelLabel: string, theme: Theme): BtwBlock {
	const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(theme.fg("accent", theme.bold("btw")) + theme.fg("dim", ` ${question}`), 0, 0));
	const placeholder = new Text(theme.fg("dim", `asking ${modelLabel}…`), 0, 0);
	box.addChild(placeholder);
	return { question, answer: null, box, placeholder, md: undefined };
}

// Remove the "asking…" line and start the streaming Markdown child.
function startStreaming(block: BtwBlock): Markdown {
	if (!block.md) {
		block.box.removeChild(block.placeholder);
		block.md = new Markdown("", 0, 0, getMarkdownTheme());
		block.box.addChild(block.md);
		block.box.invalidate();
	}
	return block.md;
}

function resolveBlock(block: BtwBlock, answer: string): void {
	block.answer = answer;
	startStreaming(block).setText(answer);
	block.box.invalidate();
}

function failBlock(block: BtwBlock, message: string, theme: Theme): void {
	block.answer = null;
	block.placeholder.setText(theme.fg("error", `btw failed: ${message}`));
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
		block.box.addChild(new Text(theme.fg("warning", "⚠ interrupted"), 0, 0));
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

// Main-session conversation plus the completed btw thread; thinking
// blocks are dropped because they are only valid inside their original
// stream.
function contextMessages(ctx: any): Message[] {
	const messages: Message[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg?.role !== "user" && msg?.role !== "assistant") continue;
		const content = Array.isArray(msg.content)
			? msg.content.filter((c: any) => c?.type !== "thinking")
			: msg.content;
		if (Array.isArray(content) && content.length === 0) continue;
		messages.push({ ...msg, content });
	}
	for (const block of shared.threads.get(sessionIdOf(ctx)) ?? []) {
		if (block.answer === null) continue;
		messages.push({ role: "user", content: [{ type: "text", text: block.question }] } as Message);
		messages.push({ role: "assistant", content: [{ type: "text", text: block.answer }] } as Message);
	}
	return messages;
}

function sessionIdOf(ctx: any): string {
	return ctx.sessionManager?.getSessionId?.() ?? "";
}

function answerText(response: any): string {
	return (response.content ?? [])
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("\n");
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
			messages.push({ role: "user", content: [{ type: "text", text: question }] } as Message);

			let systemPrompt = FALLBACK_PROMPT;
			try {
				systemPrompt = (ctx as any).getSystemPrompt?.() || FALLBACK_PROMPT;
			} catch { /* session not active; fall back */ }

			const controller = new AbortController();
			ctx.signal?.addEventListener?.("abort", () => controller.abort());

			const model = ctx.model;
			const theme = themeOf(ctx);
			const targetSession = sessionIdOf(ctx);
			shared.sessionId = targetSession;

			// Show the block in the transcript right away, before any
			// answer exists.
			const block = buildBlock(question, model.id, theme);
			const list = shared.threads.get(targetSession) ?? [];
			list.push(block);
			shared.threads.set(targetSession, list);
			chat.addChild(block.box);
			shared.tui?.requestRender?.();

			// Stream the side call in the background: the handler already
			// returned, so the editor stays usable while deltas land in the
			// transcript block.
			void (async () => {
				let streamed = "";
				try {
					const stream = ctx.modelRegistry.streamSimple(model, { systemPrompt, messages }, { signal: controller.signal });
					let finalMessage: any;
					for await (const event of stream) {
						if (event.type === "text_delta") {
							streamed += event.delta;
							startStreaming(block).setText(streamed);
						} else if (event.type === "done") {
							finalMessage = event.message;
						} else if (event.type === "error") {
							finalMessage = event.error;
						}
						shared.tui?.requestRender?.();
					}
					if (finalMessage?.stopReason === "aborted") {
						stopBlock(block, streamed, theme, targetSession);
						shared.tui?.requestRender?.();
						return;
					}
					if (finalMessage?.stopReason === "error" && !streamed) {
						failBlock(block, finalMessage.errorMessage || "model error", theme);
						shared.tui?.requestRender?.();
						return;
					}
					// Resolve into the block even when the session changed
					// mid-flight; the clear hook re-appends it when that
					// session becomes active again.
					resolveBlock(block, answerText(finalMessage) || streamed || "(no answer)");
					shared.tui?.requestRender?.();
				} catch (err: unknown) {
					if (controller.signal.aborted) {
						stopBlock(block, streamed, theme, targetSession);
					} else {
						failBlock(block, err instanceof Error ? err.message : String(err), theme);
					}
					shared.tui?.requestRender?.();
				}
			})();
		},
	});

	pi.on("session_start", async (_event, ctx: any) => {
		shared.sessionId = sessionIdOf(ctx);
	});
}

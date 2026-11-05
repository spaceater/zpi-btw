/**
 * zpi-btw — /btw: ask a one-off side question.
 *
 * The question inherits the full main-session context (system prompt and
 * the current branch's conversation) but is answered by a separate model
 * call, so nothing enters the main conversation. The Q&A block appears in
 * the live transcript immediately and the answer streams into it, delta by
 * delta. While the side call runs, a `Working...` line sits under the answer —
 * the working row above the editor belongs to the session's own agent run and
 * never appears for a side question. The block is visually identical to a
 * session entry but held in process memory only, keyed by session id and
 * placed back at its spot in that session's transcript whenever the transcript
 * is rebuilt (branch switch, compaction, resume). What a block remembers is the
 * id of the content it followed; a block whose content a compaction summarised
 * away moves to the front of that session. Nothing is ever written to the
 * session file or disk, and the command handler returns while the side call
 * runs, so the editor stays free. Side questions never see each other: no earlier side answer is
 * replayed, so one side question cannot colour the next. Everything is gone
 * when pi exits.
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
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

interface BtwBlock {
	box: Box;
	// Bottom line: `working` while the call runs, then the failure or
	// interruption text; gone once the answer settles.
	status: Text;
	md: Markdown | undefined;
	// The content the block follows, named the way pi names rendered content.
	anchor: string;
	// Blank line shown only when the block directly follows another block: two
	// side answers would otherwise share one tinted edge and read as one box.
	gap: Spacer;
}

// Process-wide state keyed on globalThis so /reload keeps blocks, the
// transcript hook, and the side threads alive.
const shared: {
	threads: Map<string, BtwBlock[]>;
	tui: any;
	chat: any;
	// The active session's entry source, needed to place blocks after a rebuild.
	session: any;
	sessionId: string;
	// True between session_shutdown and session_start: the transcript is being
	// replaced, so placing blocks mid-rebuild would use the old session.
	switching: boolean;
} = ((globalThis as any)[Symbol.for("zpi-btw-state")] ??= {
	threads: new Map<string, BtwBlock[]>(),
	tui: undefined,
	chat: undefined,
	session: undefined,
	sessionId: "",
	switching: false,
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

// --- transcript placement ---------------------------------------------------

// Where a block goes back to after the transcript is re-rendered: the content
// it followed, named the only way pi names rendered content — a message
// component carries its entry id, a tool component its tool call id. Nothing
// else is recorded, because a count of components says nothing once the live
// transcript (which also holds notices, hints and in-flight streaming rows that
// a rebuild never recreates) is replaced by the entries pi replays.
function anchorOf(ctx: any): string {
	const entries = ctx.sessionManager?.buildContextEntries?.() ?? [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "message") continue;
		const message = entry.message;
		// A tool result renders no component of its own: its component is the
		// tool call component the result was streamed into.
		if (message?.role === "toolResult") return message.toolCallId ?? "";
		if (message?.role === "user" || message?.role === "assistant") return entry.id ?? "";
	}
	return "";
}

// The tool components of the content at `at` follow it directly, so the slot
// after that content skips them; thinking and text are parts of the assistant
// component itself, never children of their own.
function afterContent(children: any[], at: number): number {
	let slot = at + 1;
	while (children[slot]?.toolCallId !== undefined) slot++;
	return slot;
}

// The session entry that follows the anchored content, if any.
function entryAfter(anchor: string, entries: any[]): any {
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const message = entry?.type === "message" ? entry.message : undefined;
		if (!message) continue;
		const id = message.role === "toolResult" ? message.toolCallId : entry.id;
		if (id === anchor) return entries[i + 1];
	}
	return undefined;
}

// Slot in the rebuilt transcript, right after the content the block followed.
// An anchor that no longer renders — a compaction summarised it away — puts the
// block at the front: the stretch of conversation it sat in is gone, and the
// front is where it reads as belonging to nothing in particular, while the end
// would claim it had just been asked.
function resolveSlot(anchor: string, children: any[], entries: any[]): number {
	if (!anchor) return 0;
	const at = children.findIndex((child: any) => child?.messageId === anchor || child?.toolCallId === anchor);
	if (at < 0) return 0;
	// Asked while a reply was streaming, the block was mounted under that very
	// reply: at that moment the reply is not a session entry yet, so the anchor
	// is the content before it, and the entry after the anchor is the reply.
	const next = entryAfter(anchor, entries);
	if (next?.message?.role === "assistant") {
		const reply = children.findIndex((child: any) => child?.messageId === next.id);
		if (reply >= 0) return afterContent(children, reply);
	}
	return afterContent(children, at);
}

// A block's box and its gap, when attached, are children of the live chat
// container. pi never tags components it did not create, so identity is the
// only marker.
function isBtwBox(component: any): boolean {
	for (const list of shared.threads.values()) {
		for (const block of list) if (block.box === component) return true;
	}
	return false;
}

function isBtwComponent(component: any): boolean {
	for (const list of shared.threads.values()) {
		for (const block of list) if (block.box === component || block.gap === component) return true;
	}
	return false;
}

// Swap the transcript's child list for `next` in one step, so it never renders
// a half-built list.
function rewrite(chat: any, next: any[]): void {
	const current: any[] = chat.children ?? [];
	if (current.length === next.length && next.every((child, i) => child === current[i])) return;
	// Through the unpatched clear: the patched one would queue a re-attach.
	chat.__btwClear();
	for (const child of next) chat.addChild(child);
	shared.tui?.requestRender?.();
}

// The transcript without any block: what a rebuild replayed from the entries.
function entryChildren(chat: any): any[] {
	return (chat.children ?? []).filter((child: any) => !isBtwComponent(child));
}

// The transcript keeping this session's blocks and dropping other sessions'.
function ownBlocks(chat: any): any[] {
	const list = shared.threads.get(shared.sessionId) ?? [];
	const keep: any[] = [];
	for (const child of chat.children ?? []) {
		if (!isBtwComponent(child) || list.some((block) => block.box === child || block.gap === child)) keep.push(child);
	}
	return keep;
}

// /btw itself: the question belongs where the conversation is right now, i.e.
// at the end of the live transcript. Blocks already there stay where they were
// put, and blocks of other sessions are dropped.
function appendBlock(chat: any, block: BtwBlock): void {
	const next = ownBlocks(chat);
	// Back-to-back blocks get a blank line between them, the way pi separates
	// consecutive entries.
	if (isBtwBox(next[next.length - 1])) next.push(block.gap);
	next.push(block.box);
	rewrite(chat, next);
}

// A rebuilt transcript (resume, branch switch, compaction) is replayed from
// session entries: every block goes back to its anchor, blocks of other
// sessions are dropped, and blocks sharing an anchor keep the order they were
// asked in.
function placeBlocks(chat: any): void {
	chat.__btwRebuilt = false;
	const children = entryChildren(chat);
	const entries = shared.session?.buildContextEntries?.() ?? [];
	const slots = [...(shared.threads.get(shared.sessionId) ?? [])]
		.map((block, order) => ({ block, order, at: resolveSlot(block.anchor, children, entries) }))
		.sort((a, b) => a.at - b.at || a.order - b.order);
	const next: any[] = [];
	let si = 0;
	for (let i = 0; i <= children.length; i++) {
		while (si < slots.length && slots[si].at <= i) {
			const block = slots[si++].block;
			if (isBtwBox(next[next.length - 1])) next.push(block.gap);
			next.push(block.box);
		}
		if (i < children.length) next.push(children[i]);
	}
	rewrite(chat, next);
}

// rebuildChatFromMessages / compaction / branch switches clear the chat
// container and re-render it from session entries. pi fills it synchronously
// right after the clear, so the blocks are placed back once that rebuild is
// done — and not at all while a session switch is replacing the transcript,
// which session_start places them itself.
function installClearHook(chat: any): void {
	if (chat.__btwClear) return;
	chat.__btwClear = chat.clear.bind(chat);
	chat.clear = () => {
		chat.__btwClear();
		chat.__btwRebuilt = true;
		queueMicrotask(() => {
			if (shared.switching || shared.chat !== chat) return;
			placeBlocks(chat);
		});
	};
}

// The status line always follows the answer, so it is kept last.
function statusToEnd(block: BtwBlock): void {
	block.box.removeChild(block.status);
	block.box.addChild(block.status);
}

// The block shows `btw <question>` with the status line under it; the answer
// streams into a Markdown child between the two.
function buildBlock(question: string, anchor: string, theme: Theme): BtwBlock {
	const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(theme.fg("dim", "/btw") + theme.fg("accent", theme.bold(` ${question}`)), 0, 0));
	const status = new Text(theme.fg("dim", "Working..."), 0, 0);
	box.addChild(status);
	return { box, status, md: undefined, anchor, gap: new Spacer(1) };
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
	startStreaming(block).setText(answer);
	// Done: the status line disappears.
	block.box.removeChild(block.status);
	block.box.invalidate();
}

// A failed call keeps whatever streamed and puts the failure on the status
// line, verbatim and without decoration.
function failBlock(block: BtwBlock, message: string, theme: Theme): void {
	block.status.setText(theme.fg("error", `Failed: ${message}`));
	statusToEnd(block);
	block.box.invalidate();
}

// Interrupted side calls stop where they are: the block keeps whatever
// streamed so far and shows an "interrupted" marker instead of vanishing.
// A block with nothing streamed yet is empty — it is removed entirely,
// from the transcript and its session's block list.
function stopBlock(block: BtwBlock, streamed: string, theme: Theme, session: string): void {
	if (streamed) {
		startStreaming(block).setText(streamed);
		block.status.setText(theme.fg("warning", "Interrupted"));
		statusToEnd(block);
		block.box.invalidate();
		return;
	}
	const list = shared.threads.get(session);
	if (list) {
		const index = list.indexOf(block);
		if (index !== -1) list.splice(index, 1);
	}
	if (shared.sessionId === session && shared.chat) {
		shared.chat.removeChild(block.gap);
		shared.chat.removeChild(block.box);
	}
}

// The session's conversation, projected by pi itself (compaction checkpoints,
// context edits, custom messages, branch summaries included) and converted with
// the same function the agent loop uses. The projection starts with the system
// message that carries the prompt and the tool declarations, so it is replayed
// as it is — nothing is filtered out and nothing is added, least of all an
// earlier side answer: side questions stay independent of each other.
function contextMessages(ctx: any): Message[] {
	return convertToLlm(ctx.sessionManager.buildSessionProjection().messages);
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
				// mid-flight; the block is placed again from its anchor when
				// that session's transcript is rebuilt.
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
			const block = buildBlock(question, anchorOf(ctx), theme);
			const list = shared.threads.get(targetSession) ?? [];
			list.push(block);
			shared.threads.set(targetSession, list);
			appendBlock(chat, block);

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

	// A replacement clears the transcript before the new session exists, so the
	// clear hook stands down until session_start knows which session is active.
	pi.on("session_shutdown", async () => {
		shared.switching = true;
	});

	pi.on("session_start", async (_event, ctx: any) => {
		shared.sessionId = sessionIdOf(ctx);
		shared.session = ctx.sessionManager;
		shared.switching = false;
		const chat = (shared.tui ? findChatContainer(shared.tui) : undefined) ?? shared.chat;
		if (!chat) return;
		shared.chat = chat;
		installClearHook(chat);
		// A session switch re-rendered the transcript while the hook stood down;
		// a plain /reload did not, and then the live positions are still the
		// right ones — only other sessions' blocks have to go.
		if (chat.__btwRebuilt) {
			placeBlocks(chat);
		} else {
			rewrite(chat, ownBlocks(chat));
		}
	});
}

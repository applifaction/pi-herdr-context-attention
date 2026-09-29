import { isContextOverflow } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, MessageEndEvent } from "@earendil-works/pi-coding-agent";

const LABEL = "Context-Limit erreicht – /compact erforderlich";

/** Additive companion to Herdr's managed herdr-agent-state.ts (integration v9). */
export default function herdrContextAttention(pi: ExtensionAPI) {
	let active = false;
	let unresolvedOverflow = false;
	let ownsBlocker = false;
	let startupTimer: ReturnType<typeof setTimeout> | undefined;

	function setBlocked(blocked: boolean): void {
		if (ownsBlocker === blocked) return;
		ownsBlocker = blocked;
		// Herdr's bus is reference-counted: release only our own acquisition.
		pi.events.emit("herdr:blocked", { active: blocked, label: LABEL });
	}

	function observe(message: MessageEndEvent["message"]): void {
		if (message.role !== "assistant") return;
		// Use Pi's provider-aware detector, not rendered text or token estimates.
		// Deliberately omit contextWindow: a successful large-context response is
		// not a blocked agent, and today's model may differ from a restored one.
		if (isContextOverflow(message)) {
			unresolvedOverflow = true;
		} else if (["stop", "toolUse", "length"].includes(message.stopReason ?? "")) {
			unresolvedOverflow = false;
		}
	}

	function restore(ctx: ExtensionContext): void {
		unresolvedOverflow = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "compaction") unresolvedOverflow = false;
			else if (entry.type === "message") observe(entry.message);
		}
	}

	function publish(ctx: ExtensionContext): void {
		if (active) setBlocked(unresolvedOverflow && ctx.isIdle());
	}

	pi.on("session_start", (_event, ctx) => {
		// RPC subagents inherit HERDR_* and even have hasUI=true. Never let
		// their errors mark the parent TUI pane as blocked.
		active = ctx.mode === "tui" && process.env.HERDR_ENV === "1"
			&& !!process.env.HERDR_SOCKET_PATH && !!process.env.HERDR_PANE_ID;
		if (!active) return;
		restore(ctx);
		// The native integration must finish its own session_start setup first;
		// do not depend on extension discovery order when restoring attention.
		startupTimer = setTimeout(() => {
			startupTimer = undefined;
			publish(ctx);
		}, 0);
		startupTimer.unref?.();
	});

	pi.on("message_end", (event) => {
		if (active) observe(event.message);
	});

	pi.on("agent_start", () => {
		if (active) setBlocked(false);
	});

	// agent_end is too early: Pi may still compact, retry, or run follow-ups.
	pi.on("agent_settled", (_event, ctx) => publish(ctx));

	pi.on("session_compact", () => {
		if (!active) return;
		unresolvedOverflow = false;
		setBlocked(false);
	});

	// A failed/cancelled compact does NOT emit session_compact. Keep attention
	// until actual recovery rather than clearing it on session_before_compact.
	pi.on("session_tree", (_event, ctx) => {
		if (!active) return;
		restore(ctx);
		publish(ctx);
	});

	pi.on("session_shutdown", () => {
		if (startupTimer) clearTimeout(startupTimer);
		startupTimer = undefined;
		setBlocked(false);
		active = false;
		unresolvedOverflow = false;
	});
}

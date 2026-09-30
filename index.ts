import { isContextOverflow } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { MetadataPublisher } from "./metadata.ts";
import { observeManualCompaction } from "./compaction-observer.ts";

/** Display-only companion to Herdr's managed Pi integration. */
export default function herdrContextAttention(pi: ExtensionAPI) {
	let active = false;
	let unresolvedOverflow = false;
	let publisher: MetadataPublisher | undefined;
	let startupTimer: ReturnType<typeof setTimeout> | undefined;
	let removeManualObserver: (() => void) | undefined;
	let compaction: { manual: boolean; detachAbort?: () => void } | undefined;

	function resetCompaction(): void {
		compaction?.detachAbort?.();
		compaction = undefined;
	}

	function beginCompaction(manual: boolean, ctx: ExtensionContext, signal?: AbortSignal) {
		resetCompaction();
		const run: NonNullable<typeof compaction> = { manual };
		compaction = run;
		const finish = (succeeded: boolean) => {
			if (!active || compaction !== run) return;
			resetCompaction();
			if (succeeded) unresolvedOverflow = false;
			void publish(ctx);
		};
		if (signal) {
			const abort = () => finish(false);
			signal.addEventListener("abort", abort, { once: true });
			run.detachAbort = () => signal.removeEventListener("abort", abort);
			if (signal.aborted) abort();
		}
		void publish(ctx);
		return finish;
	}

	function observe(message: MessageEndEvent["message"]): void {
		if (message.role !== "assistant") return;
		// Omit contextWindow: successful responses are not blocked work, and
		// today's model may differ from the model used in a restored message.
		if (isContextOverflow(message)) unresolvedOverflow = true;
		else if (["stop", "toolUse", "length"].includes(message.stopReason ?? "")) unresolvedOverflow = false;
	}

	function restore(ctx: ExtensionContext): void {
		unresolvedOverflow = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "compaction") unresolvedOverflow = false;
			else if (entry.type === "message") observe(entry.message);
		}
	}

	async function publish(ctx: ExtensionContext): Promise<void> {
		if (active) await publisher?.set(compaction ? "compacting" : unresolvedOverflow && ctx.isIdle());
	}

	pi.registerCommand("herdr-context-status", {
		description: "Check whether Context Attention is loaded and its Herdr delivery status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`Context Attention v0.3.0 loaded; Herdr: ${active ? "enabled" : "inactive"}; `
				+ `context full: ${unresolvedOverflow}; compacting: ${!!compaction}; delivery: ${publisher?.status ?? "not connected"}`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		// RPC subagents inherit HERDR_* and even have hasUI=true; only the TUI
		// owns this pane's token. Starting background work in the factory is unsafe.
		active = ctx.mode === "tui" && process.env.HERDR_ENV === "1"
			&& !!process.env.HERDR_SOCKET_PATH && !!process.env.HERDR_PANE_ID;
		if (!active) return;
		publisher = new MetadataPublisher(process.env.HERDR_SOCKET_PATH!, process.env.HERDR_PANE_ID!);
		restore(ctx);
		removeManualObserver = observeManualCompaction(ctx.sessionManager, () => beginCompaction(true, ctx));
		// Allow the native integration to establish the pane's agent identity.
		startupTimer = setTimeout(() => {
			startupTimer = undefined;
			void publish(ctx);
		}, 0);
		startupTimer.unref?.();
	});

	pi.on("message_end", (event) => {
		if (active) observe(event.message);
	});

	pi.on("agent_start", async () => {
		if (!active) return;
		if (!compaction?.manual) resetCompaction();
		await publisher?.set(compaction ? "compacting" : false);
	});

	pi.on("session_before_compact", (event, ctx) => {
		if (!active || compaction?.manual) return;
		beginCompaction(event.reason === "manual", ctx, event.signal);
	});

	// agent_end is too early. Automatic failure/cancellation settles after its
	// compaction attempt; manual compact() instead finishes via the SDK observer.
	pi.on("agent_settled", (_event, ctx) => {
		if (!compaction?.manual) resetCompaction();
		return publish(ctx);
	});

	pi.on("session_compact", async () => {
		if (!active) return;
		unresolvedOverflow = false;
		resetCompaction();
		await publisher?.set(false);
	});

	// Restore only the active branch when navigating session history.
	pi.on("session_tree", async (_event, ctx) => {
		if (!active) return;
		resetCompaction();
		restore(ctx);
		await publish(ctx);
	});

	pi.on("session_shutdown", async () => {
		active = false;
		removeManualObserver?.();
		removeManualObserver = undefined;
		resetCompaction();
		if (startupTimer) clearTimeout(startupTimer);
		startupTimer = undefined;
		await publisher?.close();
		publisher = undefined;
		unresolvedOverflow = false;
	});
}

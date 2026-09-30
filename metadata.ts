import net from "node:net";
import { performance } from "node:perf_hooks";

export const CONTEXT_TOKEN = "pica_context";
export const CONTEXT_LABEL = "⚠ Context full";
export const COMPACTION_LABEL = "⌛ Compacting context";
export type ContextDisplay = boolean | "compacting";
const SOURCE = "pi:context-attention";
const TTL_MS = 45_000;
let lastSequence = 0;
function nextSequence(): number {
	// Microseconds avoid duplicate/out-of-order sequences when a reload creates
	// a new publisher within the same wall-clock millisecond as the old clear.
	lastSequence = Math.max(lastSequence + 1, Math.floor((performance.timeOrigin + performance.now()) * 1000));
	return lastSequence;
}

/** A leased display token, never a native lifecycle report or another plugin's label. */
export class MetadataPublisher {
	private endpoint: string;
	private paneId: string;
	private timeoutMs: number;
	private ttlMs: number;
	private timer: ReturnType<typeof setInterval>;
	private desired: ContextDisplay = false;
	private acknowledged: ContextDisplay | undefined;
	private pending: { state: ContextDisplay; seq: number } | undefined;
	private draining: Promise<void> | undefined;
	private closed = false;
	status: "pending" | "acknowledged" | "failed" = "pending";

	constructor(socketPath: string, paneId: string, options: { refreshMs?: number; timeoutMs?: number; ttlMs?: number } = {}) {
		this.endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
		this.paneId = paneId;
		this.timeoutMs = options.timeoutMs ?? 500;
		this.ttlMs = options.ttlMs ?? TTL_MS;
		// Only constructed during session_start. A crashed Pi cannot leave a
		// permanent warning: the token expires unless its owner renews it.
		this.timer = setInterval(() => {
			if (this.desired || this.acknowledged !== this.desired) void this.queue(this.desired);
		}, options.refreshMs ?? 15_000);
		this.timer.unref?.();
	}

	set(state: ContextDisplay): Promise<void> {
		if (this.closed) return Promise.resolve();
		if (this.desired === state && this.acknowledged === state && !this.draining) return Promise.resolve();
		return this.queue(state);
	}

	async close(): Promise<void> {
		if (this.closed) return this.draining;
		this.closed = true;
		clearInterval(this.timer);
		// Await the final clear before a replacement session/extension starts.
		await this.queue(false);
	}

	private queue(state: ContextDisplay): Promise<void> {
		this.desired = state;
		this.pending = { state, seq: nextSequence() };
		this.status = "pending";
		if (!this.draining) {
			this.draining = this.drain().finally(() => { this.draining = undefined; });
		}
		return this.draining;
	}

	private async drain(): Promise<void> {
		while (this.pending) {
			const next = this.pending;
			this.pending = undefined;
			const request = {
				id: `${SOURCE}:${next.seq}`,
				method: "pane.report_metadata",
				params: {
					pane_id: this.paneId, source: SOURCE, agent: "pi", applies_to_source: "herdr:pi",
					seq: next.seq, ttl_ms: this.ttlMs,
					tokens: { [CONTEXT_TOKEN]: next.state === "compacting" ? COMPACTION_LABEL : next.state ? CONTEXT_LABEL : null },
				},
			};
			const delivered = await this.send(request) || await this.send(request);
			// Do not cache failed clears as successful (otherwise they never retry).
			if (delivered) this.acknowledged = next.state;
			else this.acknowledged = undefined;
			this.status = delivered ? "acknowledged" : "failed";
		}
	}

	private send(request: { id: string }): Promise<boolean> {
		return new Promise(resolve => {
			let done = false;
			let buffer = "";
			const socket = net.createConnection(this.endpoint);
			const timeout = setTimeout(() => finish(false), this.timeoutMs);
			function finish(ok: boolean) {
				if (done) return;
				done = true;
				clearTimeout(timeout);
				socket.destroy();
				resolve(ok);
			}
			socket.on("error", () => finish(false));
			socket.on("end", () => finish(false));
			socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
			socket.on("data", data => {
				buffer += data.toString();
				if (buffer.length > 65_536) return finish(false);
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				try {
					const reply = JSON.parse(buffer.slice(0, newline));
					finish(reply.id === request.id && !reply.error && reply.result !== undefined);
				} catch { finish(false); }
			});
		});
	}
}

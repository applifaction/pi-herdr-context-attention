import { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * Pi 0.84 exposes compaction_start/end to SDK subscribers but not extensions.
 * Observe its public manual compact() promise, scoped to this SessionManager.
 * Do not change arguments, results, errors, cancellation, or compaction policy.
 * No installed Pi files are patched. Automatic compaction uses extension hooks.
 */
export function observeManualCompaction(
	sessionManager: unknown,
	onStart: () => (succeeded: boolean) => void,
): () => void {
	const prototype = AgentSession.prototype;
	const previous = prototype.compact;
	let active = true;
	const wrapped: typeof previous = async function (this: AgentSession, ...args) {
		let finish: ((succeeded: boolean) => void) | undefined;
		if (active && this.sessionManager === sessionManager) {
			try { finish = onStart(); } catch { /* Observers must not break compaction. */ }
		}
		let succeeded = false;
		try {
			const result = await previous.apply(this, args);
			succeeded = true;
			return result;
		} finally {
			if (active) {
				try { finish?.(succeeded); } catch { /* Preserve the original result/error. */ }
			}
		}
	};
	prototype.compact = wrapped;
	return () => {
		active = false;
		// Never overwrite an unrelated wrapper installed after ours. A retained
		// inner wrapper becomes inert and only forwards to its predecessor.
		if (prototype.compact === wrapped) prototype.compact = previous;
	};
}

/**
 * Session state machine for the debugger.
 * Automatically listens to event bus and transitions state.
 */

import type { DebuggerEventBus } from "./event-bus.ts";
import type { SessionState } from "./types.ts";
import { SessionStateError } from "./errors.ts";

/**
 * Valid state transitions.
 */
const TRANSITIONS: Record<SessionState, SessionState[]> = {
	"not-started": ["launching", "error"],
	launching: ["running", "stopped", "exited", "error"],
	running: ["stopped", "exited", "detached", "error"],
	stopped: ["running", "exited", "detached", "error"],
	exited: [],
	detached: [],
	error: ["not-started"],
};

/**
 * Manages debugger session state transitions.
 */
export class SessionStateMachine {
	private state: SessionState = "not-started";
	private eventBus: DebuggerEventBus;

	constructor(eventBus: DebuggerEventBus) {
		this.eventBus = eventBus;
		this.autoWire();
	}

	/**
	 * Get the current state.
	 */
	getState(): SessionState {
		return this.state;
	}

	/**
	 * Transition to a new state.
	 */
	transition(newState: SessionState, data?: any): void {
		const validTransitions = TRANSITIONS[this.state];
		if (!validTransitions.includes(newState)) {
			throw new SessionStateError(
				`Invalid state transition: ${this.state} -> ${newState}. Valid transitions: ${validTransitions.join(", ")}`,
			);
		}

		this.state = newState;
		this.emitStateEvent(newState, data);
	}

	/**
	 * Check if a transition is valid.
	 */
	canTransition(newState: SessionState): boolean {
		return TRANSITIONS[this.state].includes(newState);
	}

	/**
	 * Force state without transition validation (for DAP events).
	 */
	forceState(newState: SessionState, data?: any): void {
		this.state = newState;
		this.emitStateEvent(newState, data);
	}

	/**
	 * Reset to initial state.
	 */
	reset(): void {
		this.state = "not-started";
	}

	/**
	 * Auto-wire to event bus so DAP events update state.
	 * Updates are silent: dap-client is the single emitter of canonical
	 * session:* events, and re-emitting here would duplicate them.
	 */
	private autoWire(): void {
		this.eventBus.on("session:running", () => {
			if (this.state === "launching" || this.state === "stopped") {
				this.setSilently("running");
			}
		});

		this.eventBus.on("session:stopped", () => {
			// A stop event always means a live, halted target — trust it even if
			// bookkeeping briefly said "exited" (e.g. during a relaunch race).
			if (this.state !== "detached") {
				this.setSilently("stopped");
			}
		});

		this.eventBus.on("session:exited", () => {
			if (this.state !== "exited" && this.state !== "detached") {
				this.setSilently("exited");
			}
		});

		this.eventBus.on("session:detached", () => {
			if (this.state !== "detached") {
				this.setSilently("detached");
			}
		});
	}

	private setSilently(state: SessionState): void {
		this.state = state;
	}

	/**
	 * Emit state-specific event on the bus.
	 */
	private emitStateEvent(newState: SessionState, data?: any): void {
		switch (newState) {
			case "running":
				this.eventBus.emit("session:running", data ?? {});
				break;
			case "stopped":
				this.eventBus.emit("session:stopped", data ?? { reason: "unknown" });
				break;
			case "exited":
				this.eventBus.emit("session:exited", data ?? { exitCode: 0 });
				break;
			case "detached":
				this.eventBus.emit("session:detached", {});
				break;
			case "error":
				this.eventBus.emit("session:error", { error: data ?? new Error("Unknown error") });
				break;
		}
	}
}

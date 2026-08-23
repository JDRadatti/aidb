/**
 * Typed event bus for debugger events.
 */

import type { DebuggerEvents } from "./types.ts";

type EventHandler<T> = (data: T) => void;

/**
 * Typed event emitter for debugger events.
 */
export class DebuggerEventBus {
	private listeners = new Map<string, Set<EventHandler<any>>>();

	/**
	 * Subscribe to an event.
	 * Returns an unsubscribe function.
	 */
	on<K extends keyof DebuggerEvents>(event: K, handler: EventHandler<DebuggerEvents[K]>): () => void {
		if (!this.listeners.has(event)) {
			this.listeners.set(event, new Set());
		}
		this.listeners.get(event)!.add(handler);

		return () => this.off(event, handler);
	}

	/**
	 * Unsubscribe from an event.
	 */
	off<K extends keyof DebuggerEvents>(event: K, handler: EventHandler<DebuggerEvents[K]>): void {
		this.listeners.get(event)?.delete(handler);
	}

	/**
	 * Emit an event.
	 */
	emit<K extends keyof DebuggerEvents>(event: K, data: DebuggerEvents[K]): void {
		const handlers = this.listeners.get(event);
		if (handlers) {
			for (const handler of handlers) {
				try {
					handler(data);
				} catch (error) {
					console.error(`Error in debugger event handler for "${event}":`, error);
				}
			}
		}
	}

	/**
	 * Remove all listeners.
	 */
	clear(): void {
		this.listeners.clear();
	}
}

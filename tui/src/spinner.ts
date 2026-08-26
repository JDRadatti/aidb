import { Loader, type TUI } from "@earendil-works/pi-tui";
import { colors } from "./theme.ts";

const APPEAR_WAIT_MS = 200;
const SLOW_WAIT_MS = 750;
const STUCK_WAIT_MS = 5_000;

/** A pi-style loader shared by command and shortcut initiated operations. */
export class ActivitySpinner {
	private readonly loader: Loader;
	private readonly host: { addChild(component: Loader): void; removeChild(component: Loader): void };
	private appearTimer: ReturnType<typeof setTimeout> | null = null;
	private slowTimer: ReturnType<typeof setTimeout> | null = null;
	private stuckTimer: ReturnType<typeof setTimeout> | null = null;
	private label = "";
	private visible = false;

	constructor(tui: TUI, host: { addChild(component: Loader): void; removeChild(component: Loader): void }) {
		this.host = host;
		this.loader = new Loader(tui, colors.accent, colors.muted, "");
		this.loader.stop();
	}

	async run<T>(label: string, operation: () => Promise<T>): Promise<T> {
		this.show(label);
		try {
			return await operation();
		} finally {
			this.hide();
		}
	}

	private show(label: string): void {
		this.clearTimers();
		this.label = label;
		if (!this.visible) {
			this.appearTimer = setTimeout(() => {
				this.appearTimer = null;
				this.host.addChild(this.loader);
				this.visible = true;
				this.loader.setMessage(this.label);
				this.loader.start();
			}, APPEAR_WAIT_MS);
		} else {
			this.loader.setMessage(label);
		}
		this.slowTimer = setTimeout(() => {
			if (this.visible) this.loader.setMessage(`${this.label} (waiting...)`);
		}, SLOW_WAIT_MS);
		this.stuckTimer = setTimeout(() => {
			if (this.visible) this.loader.setMessage(`${this.label} (still waiting — may be stuck)`);
		}, STUCK_WAIT_MS);
	}

	private hide(): void {
		this.clearTimers();
		if (!this.visible) return;
		this.loader.stop();
		this.host.removeChild(this.loader);
		this.visible = false;
	}

	private clearTimers(): void {
		if (this.appearTimer) clearTimeout(this.appearTimer);
		if (this.slowTimer) clearTimeout(this.slowTimer);
		if (this.stuckTimer) clearTimeout(this.stuckTimer);
		this.appearTimer = null;
		this.slowTimer = null;
		this.stuckTimer = null;
	}
}

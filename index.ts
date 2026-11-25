/**
 * omlx-speeds: live PP/TG speeds + prompt timer for oMLX-backed models.
 *
 * While pi is waiting for or receiving a model response, this polls the oMLX
 * admin activity endpoint (the same one the dashboard uses, every second) and shows:
 *
 *   prefilling:  prompt 3.2s · PP 412 t/s · ~4s left · 12.3k/16.5k tok
 *   generating:  gen 12.4s · TG 34 t/s · 421 tok
 *   queued:      queued 2.1s
 *
 * in the working loader line, and keeps the last summary in the footer status.
 * If the admin API is unreachable, a client-side timer (turn start -> now) is shown instead.
 *
 * Config (env): OMLX_URL (default http://127.0.0.1:8000), OMLX_API_KEY
 * (default: auth.api_key from ~/.omlx/settings.json).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const OMLX_URL = (process.env.OMLX_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
const STATUS_KEY = "omlx";
const POLL_MS = 1000;

interface PrefillRow {
	request_id: string;
	processed: number;
	total: number;
	speed: number;
	eta: number | null;
	elapsed: number;
	phase?: string;
}
interface GenRow {
	request_id: string;
	elapsed_seconds: number | null;
	generated_tokens: number;
	tokens_per_second: number;
	prompt_tokens?: number;
}
interface ActivityModel {
	id: string;
	prefilling: PrefillRow[];
	generating: GenRow[];
	waiting: Array<{ request_id: string }>;
}

function readOmlxApiKey(): string | undefined {
	if (process.env.OMLX_API_KEY) return process.env.OMLX_API_KEY;
	try {
		const settings = JSON.parse(
			readFileSync(path.join(homedir(), ".omlx", "settings.json"), "utf8"),
		);
		const key = settings?.auth?.api_key;
		return typeof key === "string" && key.length > 0 ? key : undefined;
	} catch {
		return undefined;
	}
}

const fmt = (n: number): string =>
	n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));

export default function (pi: ExtensionAPI) {
	let apiKey: string | undefined;
	let ctx: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let inFlight = false;
	let warnedAuth = false;
	let turnStartAt = 0;
	let firstTokenAt = 0;
	let myRequestIds = new Set<string>();

	const stopTimer = (): void => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	};

	/**
	 * Prefer rows belonging to pi's own requests (matched via the
	 * X-oMLX-Request-ID response header); otherwise the furthest-along row.
	 */
	function pickRow<T extends { request_id: string }>(rows: T[], rank: (r: T) => number): T | undefined {
		if (rows.length === 0) return undefined;
		const mine = rows.find((r) => myRequestIds.has(r.request_id));
		if (mine) return mine;
		return rows.reduce((best, r) => (rank(r) > rank(best) ? r : best), rows[0]!);
	}

	function updateFallback(c: ExtensionContext): void {
		if (!c.hasUI) return;
		const base = firstTokenAt ? (Date.now() - firstTokenAt) / 1000 : (Date.now() - turnStartAt) / 1000;
		c.ui.setWorkingMessage(
			firstTokenAt
				? `gen ${base.toFixed(1)}s (omlx stats unavailable)`
				: `prompt ${base.toFixed(1)}s (omlx stats unavailable)`,
		);
	}

	async function tick(c: ExtensionContext): Promise<void> {
		if (inFlight) return;
		inFlight = true;
		try {
			if (!apiKey || !c.hasUI) return;
			let data: { active_models?: { models?: ActivityModel[] } };
			try {
				const res = await fetch(`${OMLX_URL}/admin/api/activity`, {
					headers: { Authorization: `Bearer ${apiKey}` },
					signal: AbortSignal.timeout(2000),
				});
				if (!res.ok) {
					if (res.status === 401 && !warnedAuth) {
						warnedAuth = true;
						c.ui.notify?.(
							"omlx-speeds: admin API rejected the key (needs the main oMLX API key) — showing client-side timer only",
							"warning",
						);
					}
					updateFallback(c);
					return;
				}
				data = await res.json();
			} catch {
				updateFallback(c);
				return;
			}

			const models = data.active_models?.models ?? [];
			const model =
				models.find((m) => m.id === c.model?.id) ??
				models.find((m) => (m.prefilling?.length ?? 0) > 0 || (m.generating?.length ?? 0) > 0) ??
				models[0];
			if (!model) return;

			const pref = model.prefilling ?? [];
			const gen = model.generating ?? [];
			const waiting = model.waiting ?? [];

			if (pref.length > 0) {
				const row = pickRow(pref, (r) => r.elapsed ?? 0)!;
				const parts = [
					`prompt ${(row.elapsed ?? 0).toFixed(1)}s`,
					`PP ${fmt(row.speed ?? 0)} t/s`,
				];
				if (row.eta != null) parts.push(`~${row.eta}s left`);
				if (row.total) parts.push(`${fmt(row.processed ?? 0)}/${fmt(row.total)} tok`);
				c.ui.setWorkingMessage(parts.join(" · "));
				c.ui.setStatus(STATUS_KEY, `omlx ${parts.join(" · ")}`);
			} else if (gen.length > 0) {
				const row = pickRow(gen, (r) => r.generated_tokens ?? 0)!;
				const el =
					row.elapsed_seconds != null
						? row.elapsed_seconds
						: (Date.now() - turnStartAt) / 1000;
				const parts = [
					`gen ${el.toFixed(1)}s`,
					`TG ${fmt(row.tokens_per_second ?? 0)} t/s`,
					`${fmt(row.generated_tokens ?? 0)} tok`,
				];
				c.ui.setWorkingMessage(parts.join(" · "));
				c.ui.setStatus(STATUS_KEY, `omlx ${parts.join(" · ")}`);
			} else if (waiting.length > 0) {
				const s = (Date.now() - turnStartAt) / 1000;
				c.ui.setWorkingMessage(`queued ${s.toFixed(1)}s`);
			} else {
				// Nothing in flight on the server; the last footer status stays visible.
				c.ui.setWorkingMessage(undefined);
			}
		} catch {
			// Swallow poll errors; keep whatever was shown last.
		} finally {
			inFlight = false;
		}
	}

	pi.on("session_start", async (_event, c) => {
		ctx = c;
		apiKey = readOmlxApiKey();
		warnedAuth = false;
		myRequestIds = new Set();
	});

	pi.on("turn_start", async (_event, c) => {
		ctx = c;
		turnStartAt = Date.now();
		firstTokenAt = 0;
		if (timer) return;
		timer = setInterval(() => {
			void tick(c);
		}, POLL_MS);
		void tick(c);
	});

	pi.on("after_provider_response", (event) => {
		for (const [key, value] of Object.entries(event.headers ?? {})) {
			if (key.toLowerCase() === "x-omlx-request-id") {
				myRequestIds.add(value);
				if (myRequestIds.size > 64) myRequestIds = new Set([...myRequestIds].slice(-64));
			}
		}
	});

	pi.on("message_update", (event) => {
		if (firstTokenAt) return;
		const m = event.message;
		if (m?.role !== "assistant") return;
		const blocks = (m as { content?: Array<{ type?: string; text?: string; thinking?: string }> }).content;
		if (blocks?.some((b) => (b.type === "text" && b.text) || (b.type === "thinking" && b.thinking))) {
			firstTokenAt = Date.now();
		}
	});

	pi.on("message_end", (event) => {
		if (event.message?.role === "assistant") stopTimer(); // resume on next turn_start
	});

	pi.on("agent_settled", async (_event, c) => {
		stopTimer();
		if (c.hasUI) c.ui.setWorkingMessage(undefined);
	});

	pi.on("session_shutdown", () => {
		stopTimer();
		ctx?.hasUI && ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx = undefined;
	});
}

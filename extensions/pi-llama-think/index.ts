import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, AnyModel, Model, Provider, RefreshModelsContext } from "@earendil-works/pi-ai";
import { isModelType } from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/compat";
import { llamaCppClassifyApi } from "@earendil-works/pi-ai/api/llama-cpp-classify.lazy";
import { typesafeSystemOneApi } from "@earendil-works/pi-ai/api/typesafe-system-one.lazy";

import { buildLevelMap, parseEfforts } from "./parse.ts";

/**
 * pi-llama-think
 *
 * Overrides the built-in `llama.cpp` provider so the `/thinking` selector shows the
 * REAL reasoning-effort levels a model's chat template supports — discovered live from
 * the server and parsed out of the template's `raise_exception` guard — instead of the
 * hardcoded `off + medium` the built-in sends.
 *
 * The built-in only ever sends a boolean (`enable_thinking`) via
 * `thinkingFormat: "qwen-chat-template"`. This extension switches to
 * `thinkingFormat: "chat-template"` and emits a per-level `reasoning_effort` in
 * `chat_template_kwargs`, so selecting e.g. `xhigh` actually reaches the model.
 *
 * Everything else about the provider (auth / `/login`, classifier models, streaming)
 * mirrors the built-in verbatim so nothing regresses. See docs/pi-llama-think-implementation.md.
 */

const LLAMA_PROVIDER_ID = "llama.cpp";
const DEFAULT_LLAMA_SERVER_URL = "http://127.0.0.1:9931";

// ---------------------------------------------------------------------------
// Catalog / props shapes (subset of llama.cpp router responses we rely on)
// ---------------------------------------------------------------------------

interface LlamaCatalogModel {
	id: string;
	status: {
		value: string;
		failed?: boolean;
		args?: string[];
		exit_code?: number;
	};
	source?: string;
	architecture?: {
		input_modalities?: string[];
		output_modalities?: string[];
	};
	meta?: { n_ctx?: number; n_ctx_train?: number };
}

interface LlamaProps {
	models_autoload?: boolean;
	chat_template?: string;
}

// ---------------------------------------------------------------------------
// Client (mirrors dist/extensions/llama/client.js; only what we need)
// ---------------------------------------------------------------------------

function normalizeLlamaServerUrl(value: string): string {
	const url = new URL(value.trim());
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Server URL must use http or https");
	}
	url.hash = "";
	url.search = "";
	url.pathname = url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "") || "/";
	return url.toString().replace(/\/$/u, "");
}

function llamaInferenceUrl(serverUrl: string): string {
	return `${normalizeLlamaServerUrl(serverUrl)}/v1`;
}

class LlamaClient {
	serverUrl: string;
	apiKey?: string;

	constructor(serverUrl: string, apiKey?: string) {
		this.serverUrl = normalizeLlamaServerUrl(serverUrl);
		this.apiKey = apiKey;
	}

	private async request(path: string, init: RequestInit = {}): Promise<unknown> {
		const headers = new Headers(init.headers);
		if (init.body !== undefined) headers.set("Content-Type", "application/json");
		if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);
		const timeout = AbortSignal.timeout(15_000);
		const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
		const response = await fetch(`${this.serverUrl}${path}`, { ...init, headers, signal });
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			payload = undefined;
		}
		if (!response.ok) {
			const message =
				payload && typeof payload === "object" && "error" in payload
					? (payload as { error?: { message?: string } }).error?.message
					: `llama.cpp returned HTTP ${response.status}`;
			throw new Error(message ?? `llama.cpp returned HTTP ${response.status}`);
		}
		return payload;
	}

	async list(options: { signal?: AbortSignal } = {}): Promise<LlamaCatalogModel[]> {
		const payload = (await this.request(`/models`, { signal: options.signal })) as {
			data?: LlamaCatalogModel[];
		};
		if (!Array.isArray(payload.data)) {
			throw new Error("llama.cpp returned an invalid model catalog");
		}
		return payload.data;
	}

	async props(options: { model?: string; signal?: AbortSignal } = {}): Promise<LlamaProps> {
		const query = options.model
			? `?${new URLSearchParams({ model: options.model, autoload: "false" })}`
			: "";
		const payload = (await this.request(`/props${query}`, { signal: options.signal })) as
			LlamaProps | undefined;
		if (typeof payload !== "object" || payload === null) return {};
		return {
			...(typeof payload.models_autoload === "boolean"
				? { models_autoload: payload.models_autoload }
				: {}),
			...(typeof payload.chat_template === "string"
				? { chat_template: payload.chat_template }
				: {}),
		};
	}
}

// ---------------------------------------------------------------------------
// Model mapping (mirrors built-in toPiModel/toPiClassifierModel, enhanced)
// ---------------------------------------------------------------------------

function modelIsSelectable(model: LlamaCatalogModel, routerAutoload: boolean): boolean {
	if (model.status.value === "loaded") return true;
	// llama.cpp reports idle-slept models as "sleeping"; requests wake them automatically.
	if (model.status.value === "sleeping") return true;
	// Unloaded presets are routable only when router autoload can load them on first use.
	return (
		routerAutoload &&
		model.status.value === "unloaded" &&
		!model.status.failed &&
		model.source === "preset"
	);
}

async function routerAutoloadEnabled(
	client: LlamaClient,
	catalog: LlamaCatalogModel[],
	signal: AbortSignal,
): Promise<boolean> {
	if (!catalog.some((m) => m.status.value === "unloaded" && m.source === "preset")) return false;
	try {
		return (await client.props({ signal })).models_autoload === true;
	} catch {
		return false;
	}
}

function isDecisionModel(model: LlamaCatalogModel): boolean {
	return model.architecture?.output_modalities?.includes("decisions") === true;
}

/** Decision-only models cannot generate text and are not listed for chat. */
function isChatModel(model: LlamaCatalogModel): boolean {
	return (
		!isDecisionModel(model) || model.architecture?.output_modalities?.includes("text") === true
	);
}

function configuredContextWindow(model: LlamaCatalogModel): number | undefined {
	const args = model.status.args ?? [];
	for (let i = 0; i < args.length - 1; i++) {
		const flag = args[i];
		if (flag !== "--ctx-size" && flag !== "-c" && flag !== "-ctx") continue;
		const contextWindow = Number(args[i + 1]);
		if (Number.isSafeInteger(contextWindow) && contextWindow > 0) return contextWindow;
	}
	return undefined;
}

function contextWindowOf(model: LlamaCatalogModel, cached?: number): number {
	const runtime = model.meta?.n_ctx;
	if (runtime && runtime > 0) return runtime;
	const configured = configuredContextWindow(model);
	if (configured) return configured;
	if (cached && cached > 0) return cached;
	const train = model.meta?.n_ctx_train;
	return train && train > 0 ? train : 128000;
}

function toPiClassifierModel(
	model: LlamaCatalogModel,
	serverUrl: string,
	cachedContextWindow?: number,
) {
	const decision = isDecisionModel(model);
	const image = decision && model.architecture?.input_modalities?.includes("image") === true;
	return {
		type: "classifier" as const,
		id: model.id,
		name: model.id,
		api: decision ? "typesafe-system-one" : "llama-cpp-classify",
		provider: LLAMA_PROVIDER_ID,
		baseUrl: decision ? llamaInferenceUrl(serverUrl) : serverUrl,
		input: image
			? (["text", "image"] as ("text" | "image")[])
			: (["text"] as ("text" | "image")[]),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: contextWindowOf(model, cachedContextWindow),
		...(image && {
			compat: { imageInput: "images" as const, sendImageOptInHeader: false },
		}),
	};
}

function isLlamaClassifierModel(model: AnyModel): boolean {
	return (
		isModelType(model, "classifier") &&
		(model.api === "llama-cpp-classify" || model.api === "typesafe-system-one")
	);
}

/**
 * Build the chat-model entry. Identical to the built-in except the thinking wiring:
 *  - `thinkingLevelMap` is derived from the template's accepted efforts (not hardcoded), and
 *  - when efforts are present we use `thinkingFormat: "chat-template"` to send a per-level
 *    `reasoning_effort` (with `omitWhenOff` so `off` never sends a value the template rejects).
 */
function toPiModel(
	model: LlamaCatalogModel,
	serverUrl: string,
	props: LlamaProps | undefined,
	cachedContextWindow?: number,
) {
	const contextWindow = contextWindowOf(model, cachedContextWindow);
	const template = props?.chat_template;
	const hasThinking = template?.includes("enable_thinking") === true;
	const efforts = hasThinking ? parseEfforts(template) : [];
	const supportsEffort = hasThinking && efforts.length > 0;

	return {
		id: model.id,
		name: model.id,
		api: "openai-completions" as const,
		provider: LLAMA_PROVIDER_ID,
		baseUrl: llamaInferenceUrl(serverUrl),
		reasoning: hasThinking,
		...(hasThinking && { thinkingLevelMap: buildLevelMap(efforts) }),
		input: model.architecture?.input_modalities?.includes("image")
			? (["text", "image"] as ("text" | "image")[])
			: (["text"] as ("text" | "image")[]),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: contextWindow,
		compat: {
			supportsStore: false,
			supportsReasoningEffort: false,
			supportsUsageInStreaming: true,
			supportsStrictMode: false,
			maxTokensField: "max_tokens" as const,
			...(hasThinking &&
				supportsEffort && {
					thinkingFormat: "chat-template" as const,
					chatTemplateKwargs: {
						enable_thinking: { $var: "thinking.enabled" as const },
						reasoning_effort: { $var: "thinking.effort" as const, omitWhenOff: true },
						preserve_thinking: true,
					},
				}),
			// Thinking template with no parseable effort guard: fall back to the built-in
			// boolean behavior so the model at least gets thinking on/off.
			...(hasThinking &&
				!supportsEffort && { thinkingFormat: "qwen-chat-template" as const }),
		},
	};
}

// ---------------------------------------------------------------------------
// Provider factory (mirrors built-in createLlamaProvider)
// ---------------------------------------------------------------------------

type AuthCtx = { env: (name: string) => Promise<string | undefined> };
type CredentialLike = {
	type?: string;
	key?: string;
	env?: Record<string, string>;
};

function credentialServerUrl(credential: CredentialLike | undefined): string | undefined {
	const value = credential?.env?.LLAMA_BASE_URL;
	return typeof value === "string" && value.trim() ? normalizeLlamaServerUrl(value) : undefined;
}

async function resolveServerUrl(
	ctx: AuthCtx,
	credential: CredentialLike | undefined,
): Promise<string | undefined> {
	const configured = credentialServerUrl(credential) ?? (await ctx.env("LLAMA_BASE_URL"))?.trim();
	return configured ? normalizeLlamaServerUrl(configured) : undefined;
}

function createLlamaThinkProvider(): Provider {
	let models: Model<Api>[] = [];
	let classifiers: AnyModel[] = [];
	const fallbackClassifier = llamaCppClassifyApi();
	const decisionClassifier = typesafeSystemOneApi();

	const provider: Provider = {
		id: LLAMA_PROVIDER_ID,
		name: "llama.cpp",
		baseUrl: llamaInferenceUrl(DEFAULT_LLAMA_SERVER_URL),
		auth: {
			apiKey: {
				name: "llama.cpp server",
				login: async (interaction) => {
					const enteredUrl = await interaction.prompt({
						type: "text",
						message: "llama.cpp server URL",
						placeholder: process.env.LLAMA_BASE_URL ?? DEFAULT_LLAMA_SERVER_URL,
					});
					const serverUrl = normalizeLlamaServerUrl(
						enteredUrl.trim() || process.env.LLAMA_BASE_URL || DEFAULT_LLAMA_SERVER_URL,
					);
					const apiKey = (
						await interaction.prompt({ type: "secret", message: "API key (optional)" })
					).trim();
					await new LlamaClient(serverUrl, apiKey || undefined).list({
						signal: interaction.signal,
					});
					return {
						type: "api_key" as const,
						key: apiKey || undefined,
						env: { LLAMA_BASE_URL: serverUrl },
					};
				},
				check: async ({ ctx, credential }) => {
					const serverUrl = await resolveServerUrl(ctx, credential);
					return serverUrl
						? {
								type: "api_key" as const,
								source: credential ? "stored credential" : "LLAMA_BASE_URL",
							}
						: undefined;
				},
				resolve: async ({ ctx, credential }) => {
					const serverUrl = await resolveServerUrl(ctx, credential);
					if (!serverUrl) return undefined;
					const apiKey = credential?.key ?? (await ctx.env("LLAMA_API_KEY")) ?? "local";
					return {
						auth: { apiKey, baseUrl: llamaInferenceUrl(serverUrl) },
						env: { ...credential?.env, LLAMA_BASE_URL: serverUrl },
						source: credential ? "stored credential" : "LLAMA_BASE_URL",
					};
				},
			},
		},
		getModels: () => models,
		getAllModels: () => [...models, ...classifiers],
		refreshModels: async (context: RefreshModelsContext) => {
			const cachedContextWindows = new Map<string, number>();
			if (context.stored) {
				const stored = (context.stored.models ?? []).filter(
					(m) => (m as { provider?: string }).provider === LLAMA_PROVIDER_ID,
				);
				const restored = stored.filter(
					(m) =>
						isModelType(m, "chat") &&
						(m as { api?: string }).api === "openai-completions",
				);
				const restoredClassifiers = stored.filter(isLlamaClassifierModel);
				for (const m of [...restored, ...restoredClassifiers]) {
					cachedContextWindows.set(
						(m as { id: string }).id,
						(m as { contextWindow: number }).contextWindow,
					);
				}
				if (
					!(await context.publish({
						update: () => {
							models = restored as Model<Api>[];
							classifiers = restoredClassifiers;
						},
					}))
				) {
					return;
				}
			}

			if (
				!context.allowNetwork ||
				context.signal.aborted ||
				context.credential?.type !== "api_key"
			) {
				return;
			}
			const serverUrl = credentialServerUrl(context.credential as CredentialLike);
			if (!serverUrl) return;

			const client = new LlamaClient(serverUrl, (context.credential as CredentialLike)?.key);
			const catalog = await client.list({ signal: context.signal });
			if (context.signal.aborted) return;

			const routerAutoload = await routerAutoloadEnabled(client, catalog, context.signal);
			if (context.signal.aborted) return;

			const selectable = catalog.filter((m) => modelIsSelectable(m, routerAutoload));

			// Only loaded models expose their chat template without side effects. Unloaded
			// autoload presets would need loading; querying sleeping models may wake them.
			// Those stay without thinking support until loaded + a later refresh.
			const refreshed = await Promise.all(
				selectable.filter(isChatModel).map(async (m) => {
					const cached = cachedContextWindows.get(m.id);
					if (m.status.value !== "loaded")
						return toPiModel(m, serverUrl, undefined, cached);
					const props = await client.props({ model: m.id, signal: context.signal });
					return toPiModel(m, serverUrl, props, cached);
				}),
			);
			const refreshedClassifiers = selectable.map((m) =>
				toPiClassifierModel(m, serverUrl, cachedContextWindows.get(m.id)),
			);
			if (context.signal.aborted) return;

			await context.publish({
				persist: { models: [...refreshed, ...refreshedClassifiers], checkedAt: Date.now() },
				update: () => {
					models = refreshed;
					classifiers = refreshedClassifiers;
				},
			});
		},
		// pi-ai's compat `stream` is typed against `ProviderStreamOptions`; the `Provider`
		// interface declares `ApiStreamOptions<T>`. The built-in passes it through untyped;
		// we cast at the boundary. `streamSimple`/`classify` conform as-is.
		stream: stream as Provider["stream"],
		streamSimple,
		classify: (model, context, options) =>
			model.api === "typesafe-system-one"
				? decisionClassifier.classify(model, context, options)
				: fallbackClassifier.classify(model, context, options),
	};

	return provider;
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider(createLlamaThinkProvider());
}

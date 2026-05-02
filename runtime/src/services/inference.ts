/**
 * Inference service. Single client used by the wizard, the population
 * bots, and the model-loop research agents. Every call results in a
 * signed `op.inference` event in VANTA's event log — the request hash,
 * response hash, and inline excerpt are part of the immutable record.
 *
 * Two backends, env-selected via `INFERENCE_BACKEND`:
 *
 *  - `eigen` — EigenCloud Eigen Gateway via `@layr-labs/ai-gateway-provider`.
 *    Auth is per-call JWT minted via TEE attestation against
 *    `KMS_SERVER_URL` + `KMS_PUBLIC_KEY` (auto-injected inside EigenCompute);
 *    billed to the agent's own EigenCompute account. The agent self-funds
 *    inference end-to-end. As of 2026-05-02 this path returns
 *    `crypto/rsa: verification error` 401s on our sepolia-prod account —
 *    reproducible with `Layr-Labs/ecloud-inference-example` deployed
 *    unmodified — so the path is staged but inactive until Eigen ships a fix.
 *
 *  - `vercel` — Vercel AI Gateway, OpenAI-compatible. Auth is an operator-
 *    held bearer key (`VERCEL_AI_GATEWAY_KEY`). The operator pays Vercel
 *    in fiat downstream; the agent's inference spend is still bounded
 *    on chain by `VendorPayment(Inference)` weekly cap (immutable post-deploy).
 *    Default until the Eigen gateway is fixed.
 *
 * Both backends use the same OpenAI-style model slugs (anthropic/...,
 * openai/..., google/...) so the canonical request and event shape is
 * uniform regardless of which path is live. The active backend is logged
 * on client construction and on every call so the trust story is explicit.
 *
 * The provider for `researcher` / `evaluator` / `adversary` rotates
 * deterministically per UTC day so the three roles never share the
 * same provider on the same epoch:
 *
 *   epoch = floor(utc_unix_ms / 86_400_000)
 *   researcher: PROVIDERS[epoch          % 3]
 *   evaluator:  PROVIDERS[(epoch + 1)    % 3]
 *   adversary:  PROVIDERS[(epoch + 2)    % 3]
 *
 * `wizard` and `population_bot` are pinned to Anthropic — chat surfaces
 * benefit from a single voice.
 *
 * Failure modes are surfaced as `InferenceError` with a typed code. The
 * runtime treats them as recoverable: the calling wizard or bot retries
 * or apologises in chat; the model loop logs and waits for the next
 * epoch.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { Buffer } from "node:buffer";

import {
  buildAndSign,
  canonicalJsonBytes,
  type OpInferenceBody,
  type SignFn,
  type Sha256Hex,
  type VantaEvent,
} from "@vanta/events";
import { asSha256Hex } from "@vanta/tee";
import {
  createEigenGateway,
  type EigenGatewayLanguageModel,
} from "@layr-labs/ai-gateway-provider";
import { generateText } from "ai";

import type { InferenceConfig } from "../config.js";

type EigenProviderFn = (modelId: string) => EigenGatewayLanguageModel;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type InferenceProvider = "anthropic" | "openai" | "google";

export type InferenceRole =
  | "researcher"
  | "evaluator"
  | "adversary"
  | "wizard"
  | "population_bot";

export interface InferenceMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface InferenceRequest {
  readonly role: InferenceRole;
  /** Required iff `role === "population_bot"`. */
  readonly botHandle?: string;
  /** Optional system prompt. */
  readonly system?: string;
  readonly messages: readonly InferenceMessage[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  /**
   * Causal parent. The op.inference event is appended with this id as
   * its sole parent. Defaults to the client's `defaultParentId` (set by
   * the runtime to the genesis event id). Pass a different id to chain
   * an inference under a triggering event (e.g. a player's chat command
   * envelope, or the previous inference in a multi-turn agent loop).
   */
  readonly parentId?: Sha256Hex;
  /**
   * Override the deterministic provider rotation. Useful for tests and
   * for in-character calls that must be on a specific provider (e.g.
   * the wizard always on Anthropic).
   */
  readonly providerHint?: InferenceProvider;
  /**
   * Override `Date.now()` for the started_at timestamp. Used by tests;
   * production should leave this undefined.
   */
  readonly nowMs?: () => number;
}

export interface InferenceResponse {
  readonly inferenceId: Sha256Hex;
  readonly text: string;
  readonly provider: InferenceProvider;
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly latencyMs: number;
  /** The `op.inference` event id appended to the log. */
  readonly eventId: Sha256Hex;
}

export interface InferenceClient {
  call(req: InferenceRequest): Promise<InferenceResponse>;
}

export type InferenceErrorCode =
  | "no_credentials"
  | "provider_unsupported"
  | "request_invalid"
  | "http_error"
  | "response_malformed";

export class InferenceError extends Error {
  public readonly code: InferenceErrorCode;
  public readonly meta: Readonly<Record<string, string>>;

  public constructor(
    code: InferenceErrorCode,
    message: string,
    meta: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "InferenceError";
    this.code = code;
    this.meta = meta;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_ROTATION: readonly InferenceProvider[] = [
  "anthropic",
  "openai",
  "google",
];

const EXCERPT_MAX_CHARS = 4096;

const ROLE_TO_LINEAGE: Record<InferenceRole, string> = {
  researcher: "vanta-model-loop-researcher",
  evaluator: "vanta-model-loop-evaluator",
  adversary: "vanta-model-loop-adversary",
  wizard: "vanta-wizard",
  population_bot: "vanta-population-bot",
};

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export interface CreateInferenceClientOpts {
  readonly config: InferenceConfig;
  readonly tee: {
    readonly signingPubKey: string;
    readonly kmsKeyHash: string;
    readonly attestationJwtHash: string;
    readonly bootedAt: number;
  };
  readonly instance: string;
  readonly sign: SignFn;
  readonly appendEvent: (ev: VantaEvent) => Promise<void>;
  /**
   * Default parent id for op.inference events. Bootstrap wires this to
   * the genesis event id; callers can override per-request.
   */
  readonly defaultParentId: Sha256Hex;
  /** Where to persist full request+response blobs. */
  readonly blobDir: string;
  /** fetch implementation (override for tests). */
  readonly fetchImpl?: typeof fetch;
  /** Epoch source (ms). Override for tests. */
  readonly nowMs?: () => number;
}

export function createInferenceClient(
  opts: CreateInferenceClientOpts,
): InferenceClient {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const now = opts.nowMs ?? Date.now;
  const eigenProvider = buildEigenProvider(opts.config);

  // Boot-time log of the active backend. Stays explicit about which auth
  // path is live for this deploy; pairs with the per-call log below.
  const bootBackend = chooseBackend(opts.config);
  if (bootBackend === null) {
    console.warn(
      `[inference] backend=${opts.config.backend} unavailable at boot — required env not set; calls will fail with no_credentials`,
    );
  } else {
    console.log(`[inference] backend=${bootBackend.kind} (active)`);
  }

  return {
    async call(req: InferenceRequest): Promise<InferenceResponse> {
      validateRequest(req);

      const startedAtUnixMs = (req.nowMs ?? now)();
      const epoch = Math.floor(startedAtUnixMs / 86_400_000);
      const provider = req.providerHint ?? resolveProvider(req.role, epoch);
      const model = pickModelSlug(provider, opts.config.models);

      const backend = chooseBackend(opts.config);
      if (backend === null) {
        const reason =
          opts.config.backend === "vercel"
            ? "VERCEL_AI_GATEWAY_KEY required when INFERENCE_BACKEND=vercel"
            : "KMS_SERVER_URL + KMS_PUBLIC_KEY (or INFERENCE_STATIC_JWT) required when INFERENCE_BACKEND=eigen";
        throw new InferenceError("no_credentials", reason, {
          provider,
          role: req.role,
          backend: opts.config.backend,
        });
      }
      console.log(
        `[inference] backend=${backend.kind} provider=${provider} model=${model} role=${req.role}`,
      );

      const canonicalRequestBody = buildCanonicalRequestBody({
        provider,
        model,
        role: req.role,
        botHandle: req.botHandle ?? "",
        system: req.system ?? "",
        messages: req.messages,
        maxTokens: req.maxTokens ?? 1024,
        temperature: req.temperature ?? 0,
      });
      const canonicalRequestBytes = canonicalJsonBytes(canonicalRequestBody);
      const requestCanonicalHash = sha256Hex(canonicalRequestBytes);

      const inferenceId = asSha256Hex(randomBytes(32).toString("hex"));

      const t0 = now();
      let providerCall: ProviderCallResult;
      try {
        providerCall = await invokeBackend({
          backend,
          provider,
          model,
          system: req.system ?? "",
          messages: req.messages,
          maxTokens: req.maxTokens ?? 1024,
          temperature: req.temperature ?? 0,
          fetchImpl,
          eigenProvider,
          vercelBaseUrl: opts.config.vercelBaseUrl,
          vercelApiKey: opts.config.vercelApiKey,
        });
      } catch (err: unknown) {
        if (err instanceof InferenceError) throw err;
        throw new InferenceError(
          "http_error",
          err instanceof Error ? err.message : String(err),
          { provider, model },
        );
      }
      const latencyMs = now() - t0;

      const responseTextHash = sha256Hex(Buffer.from(providerCall.text, "utf8"));
      const excerpt = providerCall.text.slice(0, EXCERPT_MAX_CHARS);

      const { requestUri, responseUri } = persistBlobs({
        blobDir: opts.blobDir,
        inferenceId,
        canonicalRequestBytes,
        responseText: providerCall.text,
      });

      const body: OpInferenceBody = {
        inference_id: inferenceId,
        role: req.role,
        bot_handle: req.role === "population_bot" ? (req.botHandle ?? "") : "",
        provider,
        model,
        request_canonical_hash: requestCanonicalHash,
        response_text_hash: responseTextHash,
        response_text_excerpt: excerpt,
        request_blob_uri: requestUri,
        response_blob_uri: responseUri,
        prompt_tokens: providerCall.promptTokens,
        completion_tokens: providerCall.completionTokens,
        latency_ms: latencyMs,
        started_at_unix_ms: startedAtUnixMs,
      };

      const parent = req.parentId ?? opts.defaultParentId;
      const event = buildAndSign({
        type: "op.inference",
        parent_ids: [parent],
        lineage: ROLE_TO_LINEAGE[req.role],
        timestamp: Math.floor(startedAtUnixMs / 1000),
        epoch: Math.floor(opts.tee.bootedAt / 1000),
        tee: {
          signingPubKey: opts.tee.signingPubKey as never,
          kmsKeyHash: opts.tee.kmsKeyHash as never,
          tdxQuoteHash: null,
          attestationJwtHash: opts.tee.attestationJwtHash as never,
        },
        instance: opts.instance,
        body,
        sign: opts.sign,
      });

      await opts.appendEvent(event);

      return {
        inferenceId,
        text: providerCall.text,
        provider,
        model,
        promptTokens: providerCall.promptTokens,
        completionTokens: providerCall.completionTokens,
        latencyMs,
        eventId: event.id,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Provider rotation
// ---------------------------------------------------------------------------

export function resolveProvider(
  role: InferenceRole,
  epoch: number,
): InferenceProvider {
  if (role === "wizard" || role === "population_bot") return "anthropic";
  const offset =
    role === "researcher" ? 0 : role === "evaluator" ? 1 : 2;
  const idx = ((epoch + offset) % PROVIDER_ROTATION.length + PROVIDER_ROTATION.length) % PROVIDER_ROTATION.length;
  return PROVIDER_ROTATION[idx]!;
}

function pickModelSlug(
  provider: InferenceProvider,
  models: InferenceConfig["models"],
): string {
  if (provider === "anthropic") return models.anthropic;
  if (provider === "openai") return models.openai;
  return models.google;
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

/**
 * Backend choice — `null` when the configured backend isn't usable
 * (no KMS env for `eigen`, no API key for `vercel`). Inside EigenCompute,
 * `KMS_SERVER_URL` + `KMS_PUBLIC_KEY` are auto-injected; outside, the
 * Vercel path needs `VERCEL_AI_GATEWAY_KEY` set.
 */
type BackendChoice =
  | { readonly kind: "eigen" }
  | { readonly kind: "vercel" };

function chooseBackend(cfg: InferenceConfig): BackendChoice | null {
  if (cfg.backend === "vercel") {
    if (cfg.vercelApiKey.length === 0 || cfg.vercelBaseUrl.length === 0) {
      return null;
    }
    return { kind: "vercel" };
  }
  // backend === "eigen"
  const kmsServerURL = process.env["KMS_SERVER_URL"];
  const kmsPublicKey = process.env["KMS_PUBLIC_KEY"];
  const envJwtOverride = process.env["KMS_AUTH_JWT"];
  const cfgStaticJwt = cfg.staticJwt;
  if (
    (typeof kmsServerURL === "string" && kmsServerURL.length > 0 &&
      typeof kmsPublicKey === "string" && kmsPublicKey.length > 0) ||
    (typeof envJwtOverride === "string" && envJwtOverride.length > 0) ||
    cfgStaticJwt.length > 0
  ) {
    return { kind: "eigen" };
  }
  return null;
}

/**
 * Build the eigen-gateway provider once per inference client. Audience,
 * gateway URL, debug, and static-JWT override all flow through config —
 * no env reads, no upstream singleton. The upstream `eigen()` singleton
 * hardcodes audience `'llm-proxy'`, which our deployment fails RSA
 * verification against; the same KMS happily mints externally-verified
 * `vanta.app` JWTs at boot.
 *
 * Returns a thin wrapper so call sites stay `eigenProvider(modelId)`.
 */
function buildEigenProvider(cfg: InferenceConfig): EigenProviderFn {
  const kmsServerURL = process.env["KMS_SERVER_URL"] ?? "";
  const kmsPublicKey = process.env["KMS_PUBLIC_KEY"] ?? "";
  const envStaticJwt = process.env["KMS_AUTH_JWT"] ?? "";

  const staticJwt =
    cfg.staticJwt.length > 0
      ? cfg.staticJwt
      : envStaticJwt.length > 0
        ? envStaticJwt
        : undefined;

  const attestConfig =
    staticJwt === undefined && kmsServerURL.length > 0 && kmsPublicKey.length > 0
      ? { kmsServerURL, kmsPublicKey, audience: cfg.audience }
      : undefined;

  const provider = createEigenGateway({
    baseURL: cfg.eigenGatewayUrl,
    debug: cfg.debug,
    ...(staticJwt !== undefined ? { jwt: staticJwt } : {}),
    ...(attestConfig !== undefined ? { attestConfig } : {}),
  });

  return (modelId: string) => provider(modelId);
}

// ---------------------------------------------------------------------------
// Provider invocation
// ---------------------------------------------------------------------------

interface ProviderCallResult {
  readonly text: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

interface InvokeArgs {
  readonly backend: BackendChoice;
  readonly provider: InferenceProvider;
  readonly model: string;
  readonly system: string;
  readonly messages: readonly InferenceMessage[];
  readonly maxTokens: number;
  readonly temperature: number;
  readonly fetchImpl: typeof fetch;
  readonly eigenProvider: EigenProviderFn;
  readonly vercelBaseUrl: string;
  readonly vercelApiKey: string;
}

async function invokeBackend(args: InvokeArgs): Promise<ProviderCallResult> {
  if (args.backend.kind === "vercel") return invokeVercelGateway(args);
  return invokeEigenGateway(args);
}

/**
 * Drive the Vercel AI SDK against the EigenCloud Eigen Gateway. Auth
 * is handled inside `@layr-labs/ai-gateway-provider` via TEE
 * attestation (KMS_SERVER_URL + KMS_PUBLIC_KEY auto-injected at boot)
 * — no manual API keys, billed to the agent's own EigenCompute account.
 *
 * This is the T1 Direct inference path: every call is a real, agent-
 * funded inference. No bearer-token gateway, no operator-held keys.
 */
async function invokeEigenGateway(args: InvokeArgs): Promise<ProviderCallResult> {
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  if (args.system.length > 0) {
    messages.push({ role: "system", content: args.system });
  }
  for (const m of args.messages) {
    messages.push({ role: m.role, content: m.content });
  }

  try {
    const result = await generateText({
      model: args.eigenProvider(args.model),
      messages,
      maxOutputTokens: args.maxTokens,
      temperature: args.temperature,
    });
    return {
      text: result.text,
      promptTokens: result.usage.inputTokens ?? 0,
      completionTokens: result.usage.outputTokens ?? 0,
    };
  } catch (err: unknown) {
    throw new InferenceError(
      "http_error",
      err instanceof Error ? err.message : String(err),
      { provider: args.provider, model: args.model },
    );
  }
}

/**
 * Hit the Vercel AI Gateway via raw fetch (OpenAI-compatible chat-
 * completions). Bearer auth uses an operator-held API key
 * (`VERCEL_AI_GATEWAY_KEY`) — the operator pays Vercel in fiat downstream.
 * The agent's inference spend is bounded on chain by
 * `VendorPayment(Inference)` weekly cap (immutable post-deploy), so a
 * compromised key still cannot drain more than the cap allows.
 *
 * In use as the default backend until EigenCloud ships a fix for the
 * gateway-side `crypto/rsa: verification error` 401 (reproducible with
 * the official inference example deployed unmodified, 2026-05-02).
 */
async function invokeVercelGateway(args: InvokeArgs): Promise<ProviderCallResult> {
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  if (args.system.length > 0) {
    messages.push({ role: "system", content: args.system });
  }
  for (const m of args.messages) {
    messages.push({ role: m.role, content: m.content });
  }

  const url = joinUrl(args.vercelBaseUrl, "/v1/chat/completions");
  const body = {
    model: args.model,
    messages,
    max_tokens: args.maxTokens,
    temperature: args.temperature,
  };

  let res: Response;
  try {
    res = await args.fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.vercelApiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err: unknown) {
    throw new InferenceError(
      "http_error",
      err instanceof Error ? err.message : String(err),
      { provider: args.provider, model: args.model, backend: "vercel" },
    );
  }

  if (!res.ok) {
    const text = await safeReadText(res);
    throw new InferenceError(
      "http_error",
      `Vercel AI Gateway ${res.status}: ${text.slice(0, 256)}`,
      { provider: args.provider, model: args.model, backend: "vercel" },
    );
  }

  let json: VercelChatCompletionsResponse;
  try {
    json = (await res.json()) as VercelChatCompletionsResponse;
  } catch (err: unknown) {
    throw new InferenceError(
      "response_malformed",
      `Vercel AI Gateway: invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { provider: args.provider, model: args.model, backend: "vercel" },
    );
  }

  const text = json.choices?.[0]?.message?.content ?? "";
  if (typeof text !== "string" || text.length === 0) {
    throw new InferenceError(
      "response_malformed",
      "Vercel AI Gateway returned no message content",
      { provider: args.provider, model: args.model, backend: "vercel" },
    );
  }

  return {
    text,
    promptTokens: json.usage?.prompt_tokens ?? 0,
    completionTokens: json.usage?.completion_tokens ?? 0,
  };
}

interface VercelChatCompletionsResponse {
  readonly choices?: ReadonlyArray<{
    readonly message?: { readonly content?: string };
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  };
}

// ---------------------------------------------------------------------------
// Canonicalisation + persistence
// ---------------------------------------------------------------------------

interface CanonicalRequestArgs {
  readonly provider: InferenceProvider;
  readonly model: string;
  readonly role: InferenceRole;
  readonly botHandle: string;
  readonly system: string;
  readonly messages: readonly InferenceMessage[];
  readonly maxTokens: number;
  readonly temperature: number;
}

function buildCanonicalRequestBody(a: CanonicalRequestArgs): Record<string, unknown> {
  return {
    provider: a.provider,
    model: a.model,
    role: a.role,
    bot_handle: a.botHandle,
    system: a.system,
    messages: a.messages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: a.maxTokens,
    temperature: a.temperature,
  };
}

interface PersistArgs {
  readonly blobDir: string;
  readonly inferenceId: Sha256Hex;
  readonly canonicalRequestBytes: Uint8Array;
  readonly responseText: string;
}

interface PersistResult {
  readonly requestUri: string;
  readonly responseUri: string;
}

function persistBlobs(args: PersistArgs): PersistResult {
  try {
    mkdirSync(args.blobDir, { recursive: true });
    const reqPath = pathResolve(args.blobDir, `${args.inferenceId}.request.json`);
    const resPath = pathResolve(args.blobDir, `${args.inferenceId}.response.txt`);
    writeFileSync(reqPath, args.canonicalRequestBytes);
    writeFileSync(resPath, args.responseText);
    return {
      requestUri: `file://${reqPath}`,
      responseUri: `file://${resPath}`,
    };
  } catch {
    // Persistence is best-effort; the hash on the event is the
    // load-bearing integrity binding. Empty URIs signal "not persisted".
    return { requestUri: "", responseUri: "" };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateRequest(req: InferenceRequest): void {
  if (req.messages.length === 0) {
    throw new InferenceError("request_invalid", "messages must be non-empty");
  }
  if (req.role === "population_bot") {
    const handle = req.botHandle ?? "";
    if (handle.length === 0) {
      throw new InferenceError(
        "request_invalid",
        "population_bot role requires bot_handle",
      );
    }
    if (!/^[a-z0-9_-]{1,64}$/.test(handle)) {
      throw new InferenceError(
        "request_invalid",
        "bot_handle must match [a-z0-9_-]{1,64}",
        { botHandle: handle },
      );
    }
  } else if (req.botHandle !== undefined && req.botHandle.length > 0) {
    throw new InferenceError(
      "request_invalid",
      "bot_handle must be empty for non-bot roles",
      { role: req.role },
    );
  }
  if (req.maxTokens !== undefined && req.maxTokens <= 0) {
    throw new InferenceError("request_invalid", "max_tokens must be > 0");
  }
}

function sha256Hex(bytes: Uint8Array): Sha256Hex {
  return asSha256Hex(createHash("sha256").update(bytes).digest("hex"));
}

function joinUrl(base: string, path: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

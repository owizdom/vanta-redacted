/**
 * `/api/dev/probe-eigen` — diagnostic probe for the Eigen Gateway 401
 * (`crypto/rsa: verification error`). Mints a JWT via the same
 * `AttestClient` the inference path uses, decodes the header + payload
 * (no signature verify), bare-fetches the gateway with that JWT, and
 * returns everything needed to confirm or rule out:
 *
 *   - H1 — audience-keyed verification on the gateway (`vanta.app` vs
 *     `llm-proxy`, etc.)
 *   - H2 — stale gateway-side registration for our specific app
 *   - H3 — KMS region/zone mismatch
 *   - H4 — genuine gateway-side bug (probe output → support ticket)
 *
 * Gated on `NODE_ENV !== "production"` OR `VANTA_DEV_PROBE_ENABLED=1`.
 * Never logs/returns the raw JWT — only its decoded claims, the gateway
 * status, and a bounded response excerpt.
 *
 * Query params:
 *   - audience    — override audience (default: config.inference.audience)
 *   - endpoint    — override gateway base URL (default: config.inference.eigenGatewayUrl)
 *   - bypass_kms  — "1" to skip minting; use the `jwt` param verbatim
 *   - jwt         — static JWT to send (only with bypass_kms=1)
 *   - path        — gateway path to hit (default: /v1/models)
 */

import { Buffer } from "node:buffer";

import { AttestClient } from "@layr-labs/ecloud-sdk/attest";
import type { FastifyInstance } from "fastify";

const DEFAULT_PROBE_PATH = "/v1/models";
const RESPONSE_EXCERPT_BYTES = 1024;

interface DecodedJwt {
  readonly header: Record<string, unknown>;
  readonly claims: Record<string, unknown>;
  readonly raw_segments: 2 | 3 | "malformed";
}

function decodeJwtNoVerify(jwt: string): DecodedJwt {
  const parts = jwt.split(".");
  if (parts.length !== 3 && parts.length !== 2) {
    return { header: {}, claims: {}, raw_segments: "malformed" };
  }
  const decode = (s: string): Record<string, unknown> => {
    try {
      const json = Buffer.from(s, "base64url").toString("utf8");
      const obj: unknown = JSON.parse(json);
      if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
        return obj as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  };
  return {
    header: decode(parts[0] ?? ""),
    claims: decode(parts[1] ?? ""),
    raw_segments: parts.length === 3 ? 3 : 2,
  };
}

function isProbeEnabled(): boolean {
  if (process.env["NODE_ENV"] !== "production") return true;
  return process.env["VANTA_DEV_PROBE_ENABLED"] === "1";
}

export async function registerDevProbeRoute(app: FastifyInstance): Promise<void> {
  app.get("/api/dev/probe-eigen", async (req, reply) => {
    if (!isProbeEnabled()) {
      void reply.code(404);
      return { error: "not_found" };
    }

    const q = req.query as Record<string, string | undefined>;
    const cfg = app.config.inference;
    const audience = q["audience"] ?? cfg.audience;
    const endpoint = q["endpoint"] ?? cfg.eigenGatewayUrl;
    const path = q["path"] ?? DEFAULT_PROBE_PATH;
    const bypassKms = q["bypass_kms"] === "1";
    const overrideJwt = q["jwt"];

    let jwt: string;
    let mintedVia: "attest_client" | "static_override" | "config_static" = "attest_client";
    let mintError: string | null = null;

    if (bypassKms) {
      if (typeof overrideJwt !== "string" || overrideJwt.length === 0) {
        void reply.code(400);
        return { error: "bypass_kms=1 requires jwt= param" };
      }
      jwt = overrideJwt;
      mintedVia = "static_override";
    } else if (cfg.staticJwt.length > 0) {
      jwt = cfg.staticJwt;
      mintedVia = "config_static";
    } else {
      const kmsServerURL = process.env["KMS_SERVER_URL"];
      const kmsPublicKey = process.env["KMS_PUBLIC_KEY"];
      if (
        typeof kmsServerURL !== "string" ||
        kmsServerURL.length === 0 ||
        typeof kmsPublicKey !== "string" ||
        kmsPublicKey.length === 0
      ) {
        void reply.code(503);
        return {
          error: "kms_env_missing",
          detail: "KMS_SERVER_URL + KMS_PUBLIC_KEY must be set (auto-injected inside EigenCompute)",
        };
      }
      try {
        const client = new AttestClient({ kmsServerURL, kmsPublicKey, audience });
        jwt = await client.attest();
      } catch (err: unknown) {
        mintError = err instanceof Error ? err.message : String(err);
        return {
          stage: "mint_jwt",
          error: "attest_failed",
          detail: mintError,
          audience,
          gateway_endpoint: endpoint,
        };
      }
    }

    const decoded = decodeJwtNoVerify(jwt);

    // Bare fetch — Authorization header only, no other auth shape.
    const target = `${endpoint.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
    let gatewayStatus: number | null = null;
    let gatewayBody: string = "";
    let gatewayError: string | null = null;
    try {
      const res = await fetch(target, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/json",
        },
      });
      gatewayStatus = res.status;
      const text = await res.text();
      gatewayBody = text.slice(0, RESPONSE_EXCERPT_BYTES);
    } catch (err: unknown) {
      gatewayError = err instanceof Error ? err.message : String(err);
    }

    return {
      stage: "probe_complete",
      request: {
        gateway_endpoint: endpoint,
        gateway_path: path,
        audience,
        minted_via: mintedVia,
      },
      jwt_header: decoded.header,
      jwt_claims: decoded.claims,
      jwt_segments: decoded.raw_segments,
      gateway_status: gatewayStatus,
      gateway_response_excerpt: gatewayBody,
      gateway_error: gatewayError,
    };
  });
}

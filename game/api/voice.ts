/**
 * Vercel Edge function — ElevenLabs TTS proxy.
 *
 * Mirror of the dev-server middleware in game/vite.config.ts so the
 * client (`lib/voice.ts`) hits the same `POST /api/voice` shape in
 * dev and prod. The API key lives in Vercel env (`ELEVENLABS_API_KEY`)
 * and never reaches the client bundle. Edge runtime is used because
 * the handler is a Web-API Request→Response and binary streaming of
 * the upstream MP3 works natively without buffer juggling.
 */

export const config = {
  runtime: "edge",
};

interface RequestBody {
  voiceId?: string;
  text?: string;
}

export default async function handler(
  req: Request,
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  const apiKey = process.env["ELEVENLABS_API_KEY"] ?? "";
  if (apiKey.length === 0) {
    return new Response("ELEVENLABS_API_KEY not set", { status: 503 });
  }
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  const { voiceId, text } = body;
  if (typeof voiceId !== "string" || typeof text !== "string") {
    return new Response("voiceId + text required", { status: 400 });
  }
  const upstream = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2_5",
        voice_settings: { stability: 0.45, similarity_boost: 0.7 },
      }),
    },
  );
  if (!upstream.ok) {
    return new Response(await upstream.text(), { status: upstream.status });
  }
  const buf = await upstream.arrayBuffer();
  return new Response(buf, {
    status: 200,
    headers: {
      "content-type": "audio/mpeg",
      "content-length": String(buf.byteLength),
    },
  });
}

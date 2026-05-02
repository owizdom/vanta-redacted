/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Proxy /api/runtime/* → the local fastify runtime so the browser
  // can talk to it without CORS gymnastics during dev.
  async rewrites() {
    const target = process.env.RUNTIME_URL ?? "http://127.0.0.1:8787";
    return [
      { source: "/api/runtime/:path*", destination: `${target}/api/:path*` },
      { source: "/.well-known/:path*", destination: `${target}/.well-known/:path*` },
      { source: "/healthz", destination: `${target}/healthz` },
    ];
  },
};

export default nextConfig;

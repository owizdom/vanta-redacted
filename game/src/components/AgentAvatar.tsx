import type { Kingdom } from "../lib/kingdoms";

interface Props {
  readonly kingdom: Kingdom;
  readonly size?: number;
}

/**
 * Large stylized agent avatar. Concentric rings + sigil rendered
 * fully in CSS / inline SVG so it scales crisply. The sigil
 * differs per kingdom: opus = wizard star, gpt = sports laurel,
 * gemini = compass.
 */
export function AgentAvatar({ kingdom, size = 96 }: Props): JSX.Element {
  return (
    <div
      className="relative grid place-items-center rounded-full"
      style={{
        width: size,
        height: size,
        background: `radial-gradient(circle at 30% 30%, ${kingdom.glow}, ${kingdom.color} 60%, ${kingdom.color}AA)`,
        boxShadow: `0 0 32px ${kingdom.color}88, inset 0 -8px 18px rgba(0,0,0,0.35)`,
      }}
    >
      <div
        className="absolute inset-2 rounded-full border border-black/30"
        style={{
          background: `linear-gradient(180deg, ${kingdom.color}DD, ${kingdom.color}88)`,
        }}
      />
      <Sigil kingdom={kingdom} size={size * 0.5} />
    </div>
  );
}

function Sigil({ kingdom, size }: { readonly kingdom: Kingdom; readonly size: number }): JSX.Element {
  const stroke = "rgba(255,255,255,0.95)";
  const fill = "none";
  switch (kingdom.key) {
    case "opus":
      return (
        <svg width={size} height={size} viewBox="0 0 64 64" fill={fill} stroke={stroke} strokeWidth={2.5} strokeLinejoin="round">
          <path d="M32 6 L37 26 L57 26 L41 38 L47 58 L32 46 L17 58 L23 38 L7 26 L27 26 Z" />
        </svg>
      );
    case "gpt":
      return (
        <svg width={size} height={size} viewBox="0 0 64 64" fill={fill} stroke={stroke} strokeWidth={2.5} strokeLinecap="round">
          <path d="M14 32 C 14 14, 50 14, 50 32 C 50 50, 14 50, 14 32 Z" />
          <path d="M22 26 L32 36 L42 26" />
          <path d="M32 18 L32 36" />
        </svg>
      );
    case "gemini":
      return (
        <svg width={size} height={size} viewBox="0 0 64 64" fill={fill} stroke={stroke} strokeWidth={2.5} strokeLinejoin="round">
          <circle cx={32} cy={32} r={22} />
          <path d="M32 12 L36 32 L32 52 L28 32 Z" />
          <path d="M12 32 L32 28 L52 32 L32 36 Z" />
        </svg>
      );
  }
}

/**
 * Per-market avatar — gradient circle with a 2-letter monogram derived
 * from the market's question. Replaces the celebrity-photo pattern in
 * other prediction-market apps with something neutral that scales to any
 * market without carrying image assets.
 *
 * Color is bucketed by category (politics / sports / crypto / macro /
 * tech) so all 2028 election markets share a violet hue, all WC markets
 * share an orange hue, etc. — visually scannable.
 */

type Category = "politics" | "sports" | "crypto" | "macro" | "tech" | "other";

const PALETTE: Record<Category, string> = {
  politics: "from-violet-500 to-violet-400",
  sports: "from-accent-orange to-amber-400",
  crypto: "from-signal-green to-emerald-400",
  macro: "from-accent-lavender to-sky-400",
  tech: "from-accent-mint to-cyan-400",
  other: "from-chalk-400 to-chalk-200",
};

function categoryFromQuestion(q: string): Category {
  const s = q.toLowerCase();
  if (
    s.includes("nomination") ||
    s.includes("president") ||
    s.includes("election") ||
    s.includes("senate") ||
    s.includes("congress")
  ) {
    return "politics";
  }
  if (
    s.includes("world cup") ||
    s.includes("fifa") ||
    s.includes("nba") ||
    s.includes("champion")
  ) {
    return "sports";
  }
  if (s.includes("bitcoin") || s.includes("eth") || s.includes("crypto")) return "crypto";
  if (s.includes("fed") || s.includes("fomc") || s.includes("rate") || s.includes("cpi")) {
    return "macro";
  }
  if (s.includes("ai") || s.includes("llm") || s.includes("openai")) return "tech";
  return "other";
}

function monogramFromQuestion(q: string): string {
  // Drop common stop-words and grab the first letter of the next two
  // notable words. Falls back to first two letters of the question.
  const stops = new Set([
    "will",
    "the",
    "a",
    "an",
    "is",
    "are",
    "be",
    "in",
    "on",
    "at",
    "to",
    "of",
    "for",
    "by",
    "any",
  ]);
  const tokens = q
    .replace(/[^A-Za-z\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !stops.has(t.toLowerCase()));
  const a = tokens[0] ?? "?";
  const b = tokens[1] ?? a.slice(1, 2) ?? "?";
  return (a[0] + b[0]).toUpperCase();
}

export function MarketAvatar({
  question,
  size = 32,
}: {
  readonly question: string;
  readonly size?: number;
}): JSX.Element {
  const category = categoryFromQuestion(question);
  const monogram = monogramFromQuestion(question);
  const fontSize = Math.round(size * 0.4);
  return (
    <span
      className={`inline-flex items-center justify-center bg-gradient-to-br font-display font-semibold tracking-tight text-ink-950 ${PALETTE[category]}`}
      style={{
        width: size,
        height: size,
        fontSize,
        borderRadius: "50%",
      }}
      aria-hidden
    >
      {monogram}
    </span>
  );
}

/**
 * Shared truncation + URL helpers for the receipt plaques.
 *
 * Mirrors viewer/src/util.js — keep both in lockstep so the launcher
 * (browser) and the in-world signs render the same hashes the same
 * way. A visitor reading a sign must be able to take the prefix shown
 * and find the same prefix in the launcher's expanded event card.
 */
package co.vanta.bridge

object HexUtil {
    const val BASESCAN_TX_BASE = "https://sepolia.basescan.org/tx/"
    const val BASESCAN_BLOCK_BASE = "https://sepolia.basescan.org/block/"
    const val BASESCAN_ADDR_BASE = "https://sepolia.basescan.org/address/"

    fun truncate(s: String?, head: Int = 6, tail: Int = 4): String {
        if (s.isNullOrEmpty()) return "—"
        val withPrefix = if (s.startsWith("0x")) s else "0x$s"
        if (withPrefix.length <= head + tail + 3) return withPrefix
        return "${withPrefix.substring(0, head)}…${withPrefix.substring(withPrefix.length - tail)}"
    }

    /** USDC has 6 decimals. "1000000" → "1.000". 3-decimal display fits a sign line. */
    fun formatUsdc6(raw: String): String {
        return try {
            val n = raw.toBigInteger()
            val whole = n / 1_000_000.toBigInteger()
            val frac = (n % 1_000_000.toBigInteger())
                .toString()
                .padStart(6, '0')
                .take(3)
            "$whole.$frac"
        } catch (_: Exception) {
            "?"
        }
    }
}

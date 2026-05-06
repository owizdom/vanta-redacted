/**
 * VANTA — multi-VANTA island layout (v3.0).
 *
 * One deployment per VANTA: each registered agent lives on its own
 * island. agents[0] (the original Claude-thesis vanta-zero) sits at
 * world origin (0, 0); agents[1..8] occupy the 8 cardinal/ordinal
 * positions of the inner ring at radius 200; agents[9..16] populate
 * the next ring at radius 380, and so on.
 *
 * This Kotlin helper MUST agree with the Solidity contract
 * `AgentRegistry.islandOffsetOf(agentId)` — both compute the same
 * (x, z) for any given agentId so the watchable layer's island and
 * the on-chain registration match without a runtime lookup.
 *
 * The 8-position pre-computed table at radius 200 is in
 * cardinal/ordinal order (N, NE, E, SE, S, SW, W, NW) using a
 * 3-4-5-style approximation: 200 / 141 ≈ √2 / 1, so a 45° offset
 * lands on (141, 141) blocks. This trades trigonometric drift for
 * exact-match-to-on-chain integer coordinates.
 *
 * Each ring after the first sits 180 blocks further out (200 + (ring −
 * 1) × 180), so islands don't overlap visually even with 60-block
 * mini-plazas.
 */
package co.vanta.bridge

object IslandLayout {

    /** Deterministic offset for a given agentId. The contract's
     *  `AgentRegistry.islandOffsetOf` uses the same ring-and-slot
     *  topology but a 200-block base radius; for the watchable layer
     *  we tighten to a 120-block base radius so all neighbouring
     *  islands fit in one camera frame. The 8-position unit-table
     *  remains pre-scaled to radius 200 so the on-chain contract and
     *  this helper share the same vector lookup math; only the final
     *  scalar `r` differs.
     *
     *  Visual radius (this helper):     120 + (ring - 1) × 100
     *  Contract radius (chain):         200 + (ring - 1) × 180
     */
    fun offsetOf(agentId: Int): Pair<Int, Int> {
        require(agentId >= 0) { "agentId must be non-negative, got $agentId" }
        if (agentId == 0) return 0 to 0

        val idx = agentId - 1
        val ring = (idx / 8) + 1
        val slot = idx % 8

        val dx = intArrayOf(0, 141, 200, 141, 0, -141, -200, -141)
        val dz = intArrayOf(-200, -141, 0, 141, 200, 141, 0, -141)

        val r = 220 + (ring - 1) * 130
        val x = dx[slot] * r / 200
        val z = dz[slot] * r / 200
        return x to z
    }

    /** The 0-coloured Wool/blackstone palette index closest to a
     *  packed RGB triple. Used by the world builder to pick a
     *  per-island wool tint that matches the registry's `colorRgb`
     *  field. Returns the Bukkit Material enum NAME (so callers can
     *  Material.valueOf(name) without depending on this module knowing
     *  about Bukkit at compile time).
     *
     *  Set is the 16 vanilla wool variants — coarse but consistent
     *  with the watchable layer's blockstone budget. */
    fun closestWool(rgb: Int): String {
        val r = (rgb shr 16) and 0xFF
        val g = (rgb shr 8) and 0xFF
        val b = rgb and 0xFF

        var bestName = "WHITE_WOOL"
        var bestDistSq = Int.MAX_VALUE
        for ((name, palette) in WOOL_PALETTE) {
            val dr = palette[0] - r
            val dg = palette[1] - g
            val db = palette[2] - b
            val d = dr * dr + dg * dg + db * db
            if (d < bestDistSq) {
                bestDistSq = d
                bestName = name
            }
        }
        return bestName
    }

    // Approximate sRGB centroids of vanilla 1.21 wool blocks. Source:
    // Mojang reference textures, sampled at the centre of each pixel
    // on a flat block face.
    private val WOOL_PALETTE: List<Pair<String, IntArray>> = listOf(
        "WHITE_WOOL"      to intArrayOf(234, 236, 236),
        "ORANGE_WOOL"     to intArrayOf(240, 118,  19),
        "MAGENTA_WOOL"    to intArrayOf(189,  68, 179),
        "LIGHT_BLUE_WOOL" to intArrayOf( 58, 175, 217),
        "YELLOW_WOOL"     to intArrayOf(248, 197,  39),
        "LIME_WOOL"       to intArrayOf(112, 185,  25),
        "PINK_WOOL"       to intArrayOf(237, 141, 172),
        "GRAY_WOOL"       to intArrayOf( 62,  68,  71),
        "LIGHT_GRAY_WOOL" to intArrayOf(142, 142, 134),
        "CYAN_WOOL"       to intArrayOf( 21, 137, 145),
        "PURPLE_WOOL"     to intArrayOf(121,  42, 172),
        "BLUE_WOOL"       to intArrayOf( 53,  57, 157),
        "BROWN_WOOL"      to intArrayOf(114,  71,  40),
        "GREEN_WOOL"      to intArrayOf( 84, 109,  27),
        "RED_WOOL"        to intArrayOf(160,  39,  34),
        "BLACK_WOOL"      to intArrayOf( 20,  21,  25),
    )
}

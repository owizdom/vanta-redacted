/**
 * VANTA — per-VANTA plaza builder (v3 multi-VANTA).
 *
 * The central VANTA-zero plaza stays at world origin (built by
 * WorldBuilder.kt). For every additional registered VANTA, this
 * module builds a *full-size sibling plaza* at the deterministic
 * ring offset (`IslandLayout.offsetOf(agentId)`), tinted with the
 * agent's wool palette. Each plaza mirrors the central layout:
 *
 *   - 120×120 wool floor (the agent's signature colour)
 *   - polished blackstone perimeter band
 *   - 5×5 raised polished-blackstone dais at centre
 *   - lectern at dais centre (the credit-officer's desk)
 *   - 3×3 LP-vault chest grid behind the dais
 *   - chiseled-bookshelf frame around the chest grid
 *   - red-carpet rug in front of the dais
 *   - 4 iron-bar + soul-lantern corner posts on the dais
 *   - hanging-sign + wall-sign labels
 *   - 5×5×N central tower with sea-lantern beacon on top
 *   - 3×3 red-carpet entry pad + label sign at south edge
 *
 * Idempotency: a `vanta_islands_placed` persistent flag on the
 * world prevents re-placement on every plugin reload. A separate
 * `vanta_islands_demolished` flag gates a one-shot pass that
 * clears any orphan plazas left over by earlier IslandBuilder
 * versions.
 */
package co.vanta.bridge

import net.kyori.adventure.text.Component
import org.bukkit.Material
import org.bukkit.NamespacedKey
import org.bukkit.World
import org.bukkit.block.BlockFace
import org.bukkit.block.Sign
import org.bukkit.block.data.Bisected
import org.bukkit.block.data.type.Stairs
import org.bukkit.block.sign.Side
import org.bukkit.persistence.PersistentDataType
import org.bukkit.plugin.java.JavaPlugin
import kotlin.math.max
import kotlin.math.min

class IslandBuilder(private val plugin: JavaPlugin) {

    private val placedKey = NamespacedKey(plugin, "vanta_islands_placed")
    private val demolishedKey = NamespacedKey(plugin, "vanta_islands_demolished")
    private val currentVersion = "v6-demolish-only"  // v6: outside plazas removed; central-plaza partition does the work
    private val demolitionVersion = "d4"  // d4: also clears v5 sites at radius 220

    // Match WorldBuilder's plaza floor; islands sit at the same y-band
    // so visitors can walk between them without elevation changes.
    // 60×60 footprint chosen so the desk + chest grid + carpet rug
    // (≈ 7×11 area) fits comfortably while three plazas still frame
    // together in CameraBot's overhead vantage.
    private val baseY = 63                    // floor (smooth-stone level)
    private val plazaY = 64                   // walkable surface (one above floor)
    private val islandHalf = 30               // 60×60 plaza
    private val islandClearAbove = 40

    /** Build plazas for every (non-zero) agent. agent_id=0 is the
     *  central plaza (built by WorldBuilder). */
    fun placeIfNeeded(world: World, agents: List<IslandAgent>) {
        val pdc = world.persistentDataContainer

        val demolished = pdc.get(demolishedKey, PersistentDataType.STRING)
        if (demolished != demolitionVersion) {
            plugin.logger.info("vanta-islands: demolition pass (had=$demolished, want=$demolitionVersion)")
            demolishPriorIslandSites(world)
            pdc.set(demolishedKey, PersistentDataType.STRING, demolitionVersion)
        }

        val current = pdc.get(placedKey, PersistentDataType.STRING)
        val key = "$currentVersion:${agents.joinToString("|") { "${it.agentId}.${it.colorRgb}" }}"
        if (current == key) {
            plugin.logger.info("vanta-islands: already placed (${agents.size} agents); skipping")
            return
        }
        plugin.logger.info("vanta-islands: outside-plaza placement disabled in v6 (PlazaPartitioner handles central plaza)")
        pdc.set(placedKey, PersistentDataType.STRING, key)
        world.save()
    }

    /**
     * Lay one plaza at (cx, cz). Mirrors `WorldBuilder.buildDesk` and
     * `clearAndPlaza`, but every coordinate is shifted by (cx, cz)
     * and the floor uses the agent's wool colour instead of
     * smooth-stone.
     */
    private fun buildOnePlaza(world: World, cx: Int, cz: Int, agent: IslandAgent) {
        val woolName = IslandLayout.closestWool(agent.colorRgb)
        val wool = Material.matchMaterial(woolName) ?: Material.WHITE_WOOL

        clearAndFloor(world, cx, cz, wool)
        buildDesk(world, cx, cz, wool)
        buildEntryPad(world, cx, cz, agent)
    }

    private fun clearAndFloor(world: World, cx: Int, cz: Int, wool: Material) {
        // Clear the air column over the plaza footprint so any pre-
        // existing terrain (trees, hills) doesn't poke through.
        fill(
            world,
            cx - islandHalf, baseY + 1, cz - islandHalf,
            cx + islandHalf, baseY + islandClearAbove, cz + islandHalf,
            Material.AIR,
        )
        // Coloured floor: the *plaza ground* IS the wool. Whole
        // 120×120 footprint is the agent's signature colour.
        fill(
            world,
            cx - islandHalf, baseY, cz - islandHalf,
            cx + islandHalf, baseY, cz + islandHalf,
            wool,
        )
        // Polished blackstone perimeter band, one ring inside the wool
        // so the plaza border reads as framed (matches central plaza).
        for (x in (cx - islandHalf)..(cx + islandHalf)) {
            world.getBlockAt(x, baseY, cz - islandHalf).type = Material.POLISHED_BLACKSTONE
            world.getBlockAt(x, baseY, cz + islandHalf).type = Material.POLISHED_BLACKSTONE
        }
        for (z in (cz - islandHalf)..(cz + islandHalf)) {
            world.getBlockAt(cx - islandHalf, baseY, z).type = Material.POLISHED_BLACKSTONE
            world.getBlockAt(cx + islandHalf, baseY, z).type = Material.POLISHED_BLACKSTONE
        }
    }

    /**
     * Replicate `WorldBuilder.buildDesk` at offset (cx, cz). The desk
     * sits centred on the plaza: 5×5 dais, 3×3 chest wall behind,
     * lectern + carpet rug in front, lantern posts, sign labels.
     */
    private fun buildDesk(world: World, cx: Int, cz: Int, wool: Material) {
        val y = plazaY  // dais bottom at y=64 (one above floor)

        // 5×5 raised dais, polished blackstone.
        fill(
            world,
            cx - 2, y, cz - 2,
            cx + 2, y, cz + 2,
            Material.POLISHED_BLACKSTONE,
        )

        // Walk-up stairs around the dais — 4 sides facing inward.
        for (dx in -2..2) {
            placeStair(world, cx + dx, y, cz - 3, Material.POLISHED_ANDESITE_STAIRS, BlockFace.SOUTH)
            placeStair(world, cx + dx, y, cz + 3, Material.POLISHED_ANDESITE_STAIRS, BlockFace.NORTH)
        }
        for (dz in -2..2) {
            placeStair(world, cx - 3, y, cz + dz, Material.POLISHED_ANDESITE_STAIRS, BlockFace.EAST)
            placeStair(world, cx + 3, y, cz + dz, Material.POLISHED_ANDESITE_STAIRS, BlockFace.WEST)
        }

        // Bookshelf frame around chest wall (outer columns + back band).
        for (dx in listOf(-3, -2, 2, 3)) {
            for (dy in 1..3) {
                world.getBlockAt(cx + dx, y + dy, cz - 2).type = Material.CHISELED_BOOKSHELF
            }
        }
        for (dx in listOf(-2, 2)) {
            world.getBlockAt(cx + dx, y + 1, cz - 3).type = Material.CHISELED_BOOKSHELF
            world.getBlockAt(cx + dx, y + 2, cz - 3).type = Material.CHISELED_BOOKSHELF
        }

        // 3×3 LP-vault chest grid, all facing south (visitor side).
        for (dx in -1..1) {
            for (dy in 1..3) {
                placeSingleChest(world, cx + dx, y + dy, cz - 2, BlockFace.SOUTH)
            }
        }

        // Lectern at dais centre.
        world.getBlockAt(cx, y + 1, cz).type = Material.LECTERN

        // Quill jar (decorative water cauldron) at dais corner.
        world.getBlockAt(cx - 1, y + 1, cz + 1).type = Material.WATER_CAULDRON

        // Soul-lantern posts at the four dais corners.
        for (cornerX in listOf(-3, 3)) {
            for (zOff in listOf(-3, 3)) {
                for (dy in 0..2) {
                    world.getBlockAt(cx + cornerX, y + dy, cz + zOff).type = Material.IRON_BARS
                }
                world.getBlockAt(cx + cornerX, y + 3, cz + zOff).type = Material.SOUL_LANTERN
            }
        }

        // Hanging signs at the front lantern posts identifying the desk.
        world.getBlockAt(cx - 3, y + 2, cz + 4).type = Material.OAK_HANGING_SIGN
        world.getBlockAt(cx + 3, y + 2, cz + 4).type = Material.OAK_HANGING_SIGN

        // Receipt plaque east of chest grid (wall sign).
        placeWallSign(world, cx + 4, y + 2, cz - 2, BlockFace.EAST)

        // Red-wool rug in front of the lectern — visitor stands here.
        for (dz in 1..2) {
            for (dx in -1..1) {
                world.getBlockAt(cx + dx, y + 1, cz + dz).type = Material.RED_CARPET
            }
        }
    }

    /**
     * 3×3 red-carpet entry pad + label sign at the south edge.
     * Stepping onto the pad fires `visitor.island_entered`.
     */
    private fun buildEntryPad(world: World, cx: Int, cz: Int, agent: IslandAgent) {
        val y = plazaY
        val padCenter = cz + islandHalf - 4
        for (dx in -1..1) for (dz in -1..1) {
            world.getBlockAt(cx + dx, y, padCenter + dz).type = Material.RED_CARPET
        }
        val signBlock = world.getBlockAt(cx, y, padCenter + 2)
        signBlock.type = Material.OAK_SIGN
        val signState = signBlock.state
        if (signState is Sign) {
            val side = signState.getSide(Side.FRONT)
            side.line(0, Component.text("VANTA"))
            side.line(1, Component.text(agent.name))
            side.line(2, Component.text("id #${agent.agentId}"))
            side.line(3, Component.text("← step on"))
            signState.update(true, false)
        }
    }

    // -----------------------------------------------------------------
    // Block-placement primitives (mirrored from WorldBuilder.kt)
    // -----------------------------------------------------------------

    private fun placeStair(world: World, x: Int, y: Int, z: Int, material: Material, facing: BlockFace) {
        val block = world.getBlockAt(x, y, z)
        block.type = material
        val data = block.blockData
        if (data is Stairs) {
            data.facing = facing
            data.half = Bisected.Half.BOTTOM
            block.blockData = data
        }
    }

    private fun placeWallSign(world: World, x: Int, y: Int, z: Int, facing: BlockFace) {
        val block = world.getBlockAt(x, y, z)
        block.type = Material.OAK_WALL_SIGN
        val data = block.blockData
        if (data is org.bukkit.block.data.type.WallSign) {
            data.facing = facing
            block.blockData = data
        }
    }

    private fun placeSingleChest(world: World, x: Int, y: Int, z: Int, facing: BlockFace) {
        val block = world.getBlockAt(x, y, z)
        block.type = Material.CHEST
        val data = block.blockData
        if (data is org.bukkit.block.data.type.Chest) {
            data.type = org.bukkit.block.data.type.Chest.Type.SINGLE
            data.facing = facing
            block.blockData = data
        }
    }

    // -----------------------------------------------------------------
    // Demolition pass — clears prior IslandBuilder versions
    // -----------------------------------------------------------------

    private fun demolishPriorIslandSites(world: World) {
        // Unit table — same as IslandLayout, keyed to radius 200.
        val dx = intArrayOf(0, 141, 200, 141, 0, -141, -200, -141)
        val dz = intArrayOf(-200, -141, 0, 141, 200, 141, 0, -141)
        // Every previous IslandBuilder ring radius:
        //   v1: 200, v2: 120, v3: 150, v4: 180, v5: 220
        val priorRadii = listOf(200, 120, 150, 180, 220)
        val half = 35  // covers v5's 60×60 + perimeter

        for (r in priorRadii) {
            for (slot in 0..1) {
                val cx = dx[slot] * r / 200
                val cz = dz[slot] * r / 200
                try {
                    fill(world,
                        cx - half, baseY + 1, cz - half,
                        cx + half, baseY + islandClearAbove, cz + half,
                        Material.AIR)
                    fill(world,
                        cx - half, baseY, cz - half,
                        cx + half, baseY, cz + half,
                        Material.GRASS_BLOCK)
                    fill(world,
                        cx - half, baseY - 1, cz - half,
                        cx + half, baseY - 1, cz + half,
                        Material.DIRT)
                    plugin.logger.info(
                        "vanta-islands: demolished r=$r slot=$slot at ($cx,$cz)"
                    )
                } catch (e: Exception) {
                    plugin.logger.warning(
                        "vanta-islands: demolish r=$r slot=$slot failed: ${e.message}"
                    )
                }
            }
        }
    }

    private fun fill(world: World, x1: Int, y1: Int, z1: Int, x2: Int, y2: Int, z2: Int, mat: Material) {
        val xs = min(x1, x2)..max(x1, x2)
        val ys = min(y1, y2)..max(y1, y2)
        val zs = min(z1, z2)..max(z1, z2)
        val cxRange = (xs.first shr 4)..(xs.last shr 4)
        val czRange = (zs.first shr 4)..(zs.last shr 4)
        for (cx in cxRange) for (cz in czRange) {
            world.loadChunk(cx, cz, true)
        }
        for (x in xs) for (y in ys) for (z in zs) {
            world.getBlockAt(x, y, z).type = mat
        }
    }
}

/** Minimal agent shape the IslandBuilder needs. */
data class IslandAgent(
    val agentId: Int,
    val name: String,
    val colorRgb: Int,
)

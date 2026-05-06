/**
 * VANTA — central-plaza partitioner (v3 multi-VANTA, central-only).
 *
 * Divides the existing central 120×120 plaza into 3 vertical strips,
 * one per VANTA:
 *
 *    west  strip  x = -60..-21   →  vanta-gemini   (light-blue floor)
 *    middle strip x = -20.. 20   →  vanta-zero     (existing smooth-stone)
 *    east  strip  x =  21.. 60   →  vanta-gpt      (lime floor)
 *
 * The middle strip retains the wizard's desk + 9-chest LP wall +
 * lectern, so vanta-zero's narrative (the original credit officer)
 * stays intact. The two side strips get:
 *
 *   - the agent's wool colour painted across the floor
 *   - a 5×5×10 polished-blackstone tower with wool cap +
 *     sea-lantern beacon, sitting one ring inside the strip
 *   - a 3-chest cluster + label sign at the south edge
 *
 * Two dividing walls at x=±20 (3 blocks tall, polished blackstone,
 * with a 3-block-wide centre arch so visitors can walk between
 * strips) make the partitioning legible from above.
 *
 * The pre-existing pledge altar (east @ x=30) and verifier altar
 * (west @ x=-30) sit inside their respective strips by coincidence
 * of the central layout — they read as already belonging to that
 * strip's VANTA.
 *
 * Idempotent: a `vanta_plaza_partitioned` persistent flag prevents
 * a re-partition on every reload.
 */
package co.vanta.bridge

import net.kyori.adventure.text.Component
import net.kyori.adventure.text.format.NamedTextColor
import org.bukkit.Location
import org.bukkit.Material
import org.bukkit.NamespacedKey
import org.bukkit.World
import org.bukkit.block.Sign
import org.bukkit.block.sign.Side
import org.bukkit.entity.ArmorStand
import org.bukkit.entity.EntityType
import org.bukkit.inventory.ItemStack
import org.bukkit.persistence.PersistentDataType
import org.bukkit.plugin.java.JavaPlugin
import kotlin.math.max
import kotlin.math.min

class PlazaPartitioner(private val plugin: JavaPlugin) {

    private val flagKey = NamespacedKey(plugin, "vanta_plaza_partitioned")
    private val currentVersion = "p2"  // p2: model labels + armor-stand characters

    // Match WorldBuilder's plaza coords.
    private val baseY = 63                 // floor (smooth-stone level)
    private val plazaY = 64                // walkable surface
    private val plazaHalf = 60             // 120×120 central plaza

    // Strip boundaries (vertical strips along z-axis). Walls sit at
    // these x-coords; floor recolour fills the area to either side.
    private val westDivider = -20
    private val eastDivider = 20
    // Centre-arch width through each wall — 3 blocks of empty wall so
    // visitors can pass between strips.
    private val archHalfWidth = 1   // 3-block arch = -1..+1 around z=0

    /**
     * Paint the partition. agents must include vanta-zero (id=0) +
     * the side-strip occupants. v3.0 ships with a fixed id→strip
     * mapping: id=1 → east, id=2 → west. Unknown ids skip.
     */
    fun apply(world: World, agents: List<IslandAgent>) {
        val pdc = world.persistentDataContainer
        val current = pdc.get(flagKey, PersistentDataType.STRING)
        val key = "$currentVersion:${agents.joinToString("|") { "${it.agentId}.${it.colorRgb}" }}"
        if (current == key) {
            plugin.logger.info("vanta-plaza: already partitioned ($key); skipping")
            return
        }
        plugin.logger.info("vanta-plaza: partitioning central plaza (had=$current, want=$key)")

        val east = agents.firstOrNull { it.agentId == 1 }
        val west = agents.firstOrNull { it.agentId == 2 }
        if (east != null) {
            paintStrip(world, eastDivider + 1, plazaHalf, east)
            buildSideTower(world, 40, -10, east)
            buildSideChestsAndSign(world, 40, plazaHalf - 6, east)
            placeBigBanner(world, 40, -plazaHalf + 4, east)
            spawnCharacter(world, 40, -10, east)
        }
        if (west != null) {
            paintStrip(world, -plazaHalf, westDivider - 1, west)
            buildSideTower(world, -40, -10, west)
            buildSideChestsAndSign(world, -40, plazaHalf - 6, west)
            placeBigBanner(world, -40, -plazaHalf + 4, west)
            spawnCharacter(world, -40, -10, west)
        }
        // vanta-opus (id=0) keeps the central wizard NPC; just stamp a
        // big banner at the north edge so visitors read the model name
        // from the same vantage as the side strips.
        val opus = agents.firstOrNull { it.agentId == 0 }
        if (opus != null) {
            placeBigBanner(world, 0, -plazaHalf + 4, opus)
        }

        buildDividerWall(world, westDivider)
        buildDividerWall(world, eastDivider)

        pdc.set(flagKey, PersistentDataType.STRING, key)
        world.save()
        plugin.logger.info("vanta-plaza: partitioning complete")
    }

    /** Paint one vertical strip's floor with the agent's wool. */
    private fun paintStrip(world: World, xMin: Int, xMax: Int, agent: IslandAgent) {
        val woolName = IslandLayout.closestWool(agent.colorRgb)
        val wool = Material.matchMaterial(woolName) ?: Material.WHITE_WOOL
        // Floor: full strip width × full plaza length.
        fill(
            world,
            xMin, baseY, -plazaHalf + 1,
            xMax, baseY, plazaHalf - 1,
            wool,
        )
        plugin.logger.info(
            "vanta-plaza: painted strip x=$xMin..$xMax with $woolName for agent=${agent.agentId} '${agent.name}'"
        )
    }

    /** Build a polished-blackstone wall at the given x-coordinate, 3
     *  blocks tall, full plaza length, with a 3-block centre arch. */
    private fun buildDividerWall(world: World, x: Int) {
        for (z in -plazaHalf + 1..plazaHalf - 1) {
            // Skip the centre arch so visitors can walk through.
            if (z >= -archHalfWidth && z <= archHalfWidth) continue
            for (dy in 1..3) {
                world.getBlockAt(x, baseY + dy, z).type = Material.POLISHED_BLACKSTONE
            }
        }
        // Arch capstone — a single block above the doorway, on each
        // arch position, to make the opening read as a portal.
        for (z in -archHalfWidth..archHalfWidth) {
            world.getBlockAt(x, baseY + 4, z).type = Material.POLISHED_BLACKSTONE
        }
    }

    /** Build a 5×5×10 tower with the agent's wool cap and a
     *  sea-lantern beacon. Mirrors the central wizard tower. */
    private fun buildSideTower(world: World, cx: Int, cz: Int, agent: IslandAgent) {
        val woolName = IslandLayout.closestWool(agent.colorRgb)
        val wool = Material.matchMaterial(woolName) ?: Material.WHITE_WOOL
        val towerHalf = 2
        val towerHeight = 10

        // Hollow polished-blackstone shaft.
        for (y in 1..(towerHeight - 2)) {
            for (dx in -towerHalf..towerHalf) {
                world.getBlockAt(cx + dx, baseY + y, cz - towerHalf).type = Material.POLISHED_BLACKSTONE
                world.getBlockAt(cx + dx, baseY + y, cz + towerHalf).type = Material.POLISHED_BLACKSTONE
            }
            for (dz in -towerHalf..towerHalf) {
                world.getBlockAt(cx - towerHalf, baseY + y, cz + dz).type = Material.POLISHED_BLACKSTONE
                world.getBlockAt(cx + towerHalf, baseY + y, cz + dz).type = Material.POLISHED_BLACKSTONE
            }
        }
        // Wool cap (top 2 layers solid).
        fill(
            world,
            cx - towerHalf, baseY + towerHeight - 1, cz - towerHalf,
            cx + towerHalf, baseY + towerHeight, cz + towerHalf,
            wool,
        )
        // Sea-lantern beacon on top.
        world.getBlockAt(cx, baseY + towerHeight + 1, cz).type = Material.SEA_LANTERN
    }

    /** 3-chest cluster + label sign at the south end of the strip. */
    private fun buildSideChestsAndSign(
        world: World,
        cx: Int,
        cz: Int,
        agent: IslandAgent,
    ) {
        for (dx in -1..1) {
            world.getBlockAt(cx + dx, plazaY, cz).type = Material.CHEST
        }
        // 3×3 red carpet pad in front of the chests.
        for (dx in -1..1) for (dz in 1..3) {
            world.getBlockAt(cx + dx, plazaY, cz + dz).type = Material.RED_CARPET
        }
        // Sign behind the carpet, facing inward.
        val signBlock = world.getBlockAt(cx, plazaY, cz + 4)
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

    /**
     * Big banner — pair of hanging signs flanking a column of wool +
     * an OAK_SIGN at eye level. Reads model name + thesis from the
     * north entrance of each strip.
     */
    private fun placeBigBanner(world: World, cx: Int, cz: Int, agent: IslandAgent) {
        val woolName = IslandLayout.closestWool(agent.colorRgb)
        val wool = Material.matchMaterial(woolName) ?: Material.WHITE_WOOL
        val y = plazaY

        // Two-block-wide wool pillar 4 tall (visible from afar).
        for (dy in 1..4) {
            world.getBlockAt(cx - 1, y + dy, cz).type = wool
            world.getBlockAt(cx + 1, y + dy, cz).type = wool
        }

        // Sign at eye level on the south face of the pillar.
        val signBlock = world.getBlockAt(cx, y + 2, cz)
        signBlock.type = Material.OAK_SIGN
        val signState = signBlock.state
        if (signState is Sign) {
            val side = signState.getSide(Side.FRONT)
            val tone = nameTone(agent.agentId)
            side.line(0, Component.text("VANTA", NamedTextColor.WHITE))
            side.line(1, Component.text(agent.name.uppercase(), tone))
            side.line(2, Component.text("id #${agent.agentId}", NamedTextColor.GRAY))
            signState.update(true, false)
        }
    }

    private fun nameTone(agentId: Int): NamedTextColor = when (agentId) {
        0 -> NamedTextColor.LIGHT_PURPLE
        1 -> NamedTextColor.GREEN
        2 -> NamedTextColor.AQUA
        else -> NamedTextColor.WHITE
    }

    /**
     * Spawn an armor-stand "character" representing the model. The
     * stand is named with the agent's model name + visible nameplate
     * so visitors read who runs which strip. v3.0 uses an armor stand
     * (no extra mineflayer bot needed); v3.1 may upgrade to a
     * dedicated bot per strip with idle motion.
     */
    private fun spawnCharacter(world: World, cx: Int, cz: Int, agent: IslandAgent) {
        // Pick a spot 3 blocks south of the tower, on the strip floor.
        val loc = Location(world, cx + 0.5, plazaY.toDouble(), cz + 4.5, 180f, 0f)
        // Despawn any prior character at this spot to keep the place
        // idempotent.
        world.getNearbyEntities(loc, 1.5, 2.0, 1.5)
            .filterIsInstance<ArmorStand>()
            .forEach { it.remove() }

        val stand = world.spawnEntity(loc, EntityType.ARMOR_STAND) as ArmorStand
        stand.customName(Component.text(agent.name, nameTone(agent.agentId)))
        stand.isCustomNameVisible = true
        stand.isInvulnerable = true
        stand.setBasePlate(true)
        stand.setArms(true)
        stand.setPersistent(true)

        val (helmet, chest, leggings, boots, weapon) = outfitFor(agent.agentId)
        val eq = stand.equipment
        eq.helmet = ItemStack(helmet)
        eq.chestplate = ItemStack(chest)
        eq.leggings = ItemStack(leggings)
        eq.boots = ItemStack(boots)
        eq.setItemInMainHand(ItemStack(weapon))
    }

    /**
     * Per-VANTA outfit. Different helmet/chestplate combinations
     * give each character a distinct silhouette in the strip.
     *   id=0 vanta-opus    purple-leaning, hooded                — wizard
     *   id=1 vanta-gpt     gold-leaning,   bright/active         — analyst
     *   id=2 vanta-gemini  iron-leaning,   restrained / patient  — strategist
     */
    private fun outfitFor(agentId: Int): Quintuple<Material, Material, Material, Material, Material> = when (agentId) {
        0 -> Quintuple(Material.LEATHER_HELMET, Material.LEATHER_CHESTPLATE, Material.LEATHER_LEGGINGS, Material.LEATHER_BOOTS, Material.STICK)
        1 -> Quintuple(Material.GOLDEN_HELMET, Material.GOLDEN_CHESTPLATE, Material.GOLDEN_LEGGINGS, Material.GOLDEN_BOOTS, Material.SPYGLASS)
        2 -> Quintuple(Material.IRON_HELMET, Material.IRON_CHESTPLATE, Material.IRON_LEGGINGS, Material.IRON_BOOTS, Material.WRITTEN_BOOK)
        else -> Quintuple(Material.LEATHER_HELMET, Material.LEATHER_CHESTPLATE, Material.LEATHER_LEGGINGS, Material.LEATHER_BOOTS, Material.STICK)
    }

    /** Tiny 5-tuple to keep the outfit table readable. */
    private data class Quintuple<A, B, C, D, E>(val a: A, val b: B, val c: C, val d: D, val e: E)

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

/**
 * VANTA — Minecraft world builder.
 *
 * §1.2 — Paper-side mirror of the structures we placed in Roblox
 * during the detour. Five locations from the paper §7.1:
 *   1. Stone tower at (0, 64, 0) — credit officer's office
 *   2. Pledge altar east (60)   — borrowers' scrolls
 *   3. Mark belfry north (90)   — bell + TWAP sign
 *   4. Verifier altar west (-60) — chain-walk
 *   5. Graveyard south (-90)    — settled-loan plaques
 *
 * Idempotent: a `vanta_world_placed` flag in the world's persistent
 * data store prevents a second pass on plugin reload.
 *
 * Placement is synchronous on the main thread (a few k blocks ≈
 * one tick of lag on first boot, then never again).
 */
package co.vanta.bridge

import org.bukkit.Bukkit
import org.bukkit.Location
import org.bukkit.Material
import org.bukkit.NamespacedKey
import org.bukkit.World
import org.bukkit.block.BlockFace
import org.bukkit.block.data.Bisected
import org.bukkit.block.data.type.Stairs
import org.bukkit.entity.EntityType
import org.bukkit.entity.Goat
import org.bukkit.entity.Parrot
import org.bukkit.persistence.PersistentDataType
import org.bukkit.plugin.java.JavaPlugin
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

class WorldBuilder(private val plugin: JavaPlugin) {

    private val placedKey = NamespacedKey(plugin, "vanta_world_placed")

    private val plazaY = 63                  // stone-brick floor sits at y=63, walkable surface y=64
    private val plazaHalf = 60               // 120×120 plaza
    private val plazaClearAbove = 60         // clear up to y=123 over the plaza
    private val bufferRadius = 60            // 60-block cleared+painted ring outside the plaza wall

    private val currentVersion = "v17"  // bump → re-place on next boot

    fun placeIfNeeded(world: World) {
        val pdc = world.persistentDataContainer
        val current = pdc.get(placedKey, PersistentDataType.STRING)
        if (current == currentVersion) {
            plugin.logger.info("vanta-world: already placed ($current); skipping")
            return
        }
        plugin.logger.info("vanta-world: placing structures at world origin (had=$current, want=$currentVersion)")
        clearAndPlaza(world)
        clearBufferZone(world)
        paintBufferAsPlains(world)
        spawnBirds(world)
        spawnGoats(world)
        buildDesk(world)
        buildPledgeAltar(world)
        buildMarkBelfry(world)
        buildVerifierAltar(world)
        buildGraveyard(world)
        buildSpawnPad(world)
        setSpawnSouthOfDesk(world)
        pdc.set(placedKey, PersistentDataType.STRING, currentVersion)
        world.save()
        plugin.logger.info("vanta-world: placed ✓ ($currentVersion)")
    }

    // -----------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------

    private fun set(world: World, x: Int, y: Int, z: Int, mat: Material) {
        world.getBlockAt(x, y, z).type = mat
    }

    private fun fill(world: World, x1: Int, y1: Int, z1: Int, x2: Int, y2: Int, z2: Int, mat: Material) {
        val xs = min(x1, x2)..max(x1, x2)
        val ys = min(y1, y2)..max(y1, y2)
        val zs = min(z1, z2)..max(z1, z2)
        // Force-load every chunk the fill touches before writing blocks.
        // Bukkit docs say getBlockAt auto-loads, but on first-boot worlds
        // the far perimeter chunks (e.g. (-60..60, -60)) sometimes silently
        // dropped wall blocks. Explicit loadChunk(x, z, true) is the
        // belt-and-suspenders fix; harmless when chunks are already loaded.
        val cxRange = (xs.first shr 4)..(xs.last shr 4)
        val czRange = (zs.first shr 4)..(zs.last shr 4)
        for (cx in cxRange) for (cz in czRange) {
            world.loadChunk(cx, cz, true)
        }
        for (x in xs) for (y in ys) for (z in zs) {
            world.getBlockAt(x, y, z).type = mat
        }
    }

    // -----------------------------------------------------------------
    // 0. Plaza — clear terrain, lay smooth-stone floor
    // -----------------------------------------------------------------

    private fun clearAndPlaza(world: World) {
        // Clear air above the floor (handles the vanilla terrain hills that
        // would otherwise clip through the structures).
        fill(world, -plazaHalf, plazaY + 1, -plazaHalf, plazaHalf, plazaY + plazaClearAbove, plazaHalf, Material.AIR)
        // Floor.
        fill(world, -plazaHalf, plazaY, -plazaHalf, plazaHalf, plazaY, plazaHalf, Material.SMOOTH_STONE)
        // A ring of polished stone at the perimeter to delineate.
        for (x in -plazaHalf..plazaHalf) {
            set(world, x, plazaY, -plazaHalf, Material.POLISHED_BLACKSTONE)
            set(world, x, plazaY,  plazaHalf, Material.POLISHED_BLACKSTONE)
        }
        for (z in -plazaHalf..plazaHalf) {
            set(world, -plazaHalf, plazaY, z, Material.POLISHED_BLACKSTONE)
            set(world,  plazaHalf, plazaY, z, Material.POLISHED_BLACKSTONE)
        }
    }

    // -----------------------------------------------------------------
    // 0b. Buffer zone — clear a 30-block ring outside the plaza wall
    // so trees, hills, and ocean spikes don't crowd the perimeter
    // regardless of which seed Paper picked. Beyond the buffer, natural
    // terrain stays intact (mountains, biomes, mobs).
    // -----------------------------------------------------------------

    private fun clearBufferZone(world: World) {
        val outer = plazaHalf + bufferRadius
        val clearTop = plazaY + plazaClearAbove   // same vertical envelope as plaza
        plugin.logger.info("vanta-world: clearing buffer zone (radius=$bufferRadius)")
        // Four rectangular bands around the plaza, no overlap with plaza interior.
        // North band: full width × bufferRadius deep, z from -outer..-plazaHalf-1
        fill(world, -outer, plazaY + 1, -outer, outer, clearTop, -plazaHalf - 1, Material.AIR)
        // South band: z from plazaHalf+1..outer
        fill(world, -outer, plazaY + 1,  plazaHalf + 1, outer, clearTop,  outer, Material.AIR)
        // West band: x from -outer..-plazaHalf-1, z spans only plaza width
        fill(world, -outer, plazaY + 1, -plazaHalf, -plazaHalf - 1, clearTop, plazaHalf, Material.AIR)
        // East band: x from plazaHalf+1..outer
        fill(world,  plazaHalf + 1, plazaY + 1, -plazaHalf, outer, clearTop, plazaHalf, Material.AIR)
    }

    // -----------------------------------------------------------------
    // 0c. Paint the buffer ring as plains — grass-block floor, plains
    // biome label, sparse flowers + tall grass. Seed-independent: even
    // if the natural biome is taiga / ocean / desert, the cleared ring
    // around the plaza always reads as a plains meadow. Beyond the
    // ring, original biomes (forests, mountains, goats) stay intact.
    // -----------------------------------------------------------------

    // -----------------------------------------------------------------
    // 0d. Birds — scatter persistent parrots (random colours) around
    // the buffer ring at perch height. Parrots flap, bob, and follow
    // nearby players, giving the plaza approach some life.
    // -----------------------------------------------------------------

    private fun spawnBirds(world: World) {
        val outer = plazaHalf + bufferRadius
        val rng = java.util.Random((currentVersion + ":birds").hashCode().toLong())
        val variants = Parrot.Variant.values()
        plugin.logger.info("vanta-world: spawning birds")
        var spawned = 0
        var attempts = 0
        while (spawned < 40 && attempts < 600) {
            attempts++
            val x = rng.nextInt(outer * 2 + 1) - outer
            val z = rng.nextInt(outer * 2 + 1) - outer
            // Skip plaza interior; only spawn in the painted ring
            if (abs(x) <= plazaHalf && abs(z) <= plazaHalf) continue
            val loc = Location(world, x + 0.5, plazaY + 6.0, z + 0.5)
            val parrot = world.spawnEntity(loc, EntityType.PARROT) as? Parrot ?: continue
            parrot.variant = variants[rng.nextInt(variants.size)]
            parrot.setPersistent(true)
            parrot.isInvulnerable = true
            spawned++
        }
    }

    // -----------------------------------------------------------------
    // 0e. Goats — scatter persistent goats in the buffer ring. Goats
    // need mountain biomes to spawn naturally and the seed rarely
    // puts one within view distance, so we spawn explicitly. One in
    // ~6 is the rare screaming variant.
    // -----------------------------------------------------------------

    private fun spawnGoats(world: World) {
        val outer = plazaHalf + bufferRadius
        val rng = java.util.Random((currentVersion + ":goats").hashCode().toLong())
        plugin.logger.info("vanta-world: spawning goats")
        var spawned = 0
        var attempts = 0
        while (spawned < 30 && attempts < 600) {
            attempts++
            val x = rng.nextInt(outer * 2 + 1) - outer
            val z = rng.nextInt(outer * 2 + 1) - outer
            if (abs(x) <= plazaHalf && abs(z) <= plazaHalf) continue
            val loc = Location(world, x + 0.5, plazaY + 1.0, z + 0.5)
            val goat = world.spawnEntity(loc, EntityType.GOAT) as? Goat ?: continue
            goat.isScreaming = rng.nextInt(6) == 0
            goat.setPersistent(true)
            spawned++
        }
    }

    private fun paintBufferAsPlains(world: World) {
        val outer = plazaHalf + bufferRadius
        plugin.logger.info("vanta-world: painting buffer as plains (radius=$bufferRadius)")
        val rng = java.util.Random(currentVersion.hashCode().toLong())
        for (x in -outer..outer) {
            for (z in -outer..outer) {
                val ax = kotlin.math.abs(x)
                val az = kotlin.math.abs(z)
                if (ax <= plazaHalf && az <= plazaHalf) continue   // skip plaza interior
                world.getBlockAt(x, plazaY, z).type = Material.GRASS_BLOCK
                world.setBiome(x, plazaY, z, org.bukkit.block.Biome.PLAINS)
                if (rng.nextInt(100) < 3) {
                    val flower = when (rng.nextInt(4)) {
                        0 -> Material.OXEYE_DAISY
                        1 -> Material.DANDELION
                        2 -> Material.POPPY
                        else -> Material.TALL_GRASS
                    }
                    world.getBlockAt(x, plazaY + 1, z).type = flower
                }
            }
        }
    }

    // -----------------------------------------------------------------
    // 1. Wizard's desk at origin — multi-block raised dais, lectern,
    //    bookshelf wall behind, soul-lantern posts, stair steps up.
    //    No walls, no roof, no fire — fully open-air workstation.
    // -----------------------------------------------------------------

    private fun buildDesk(world: World) {
        val baseY = plazaY + 1   // dais bottom at y=64

        // 5×5 raised dais, polished blackstone
        fill(world, -2, baseY, -2, 2, baseY, 2, Material.POLISHED_BLACKSTONE)
        // Smoother top using polished-blackstone-pressure-plate? No — keep
        // it solid so NPCs walk on it. The dais top y=baseY..baseY+1.

        // Walk-up steps on all four sides of the dais (1-stud high stairs
        // at y=baseY pointing inward).
        for (x in -2..2) {
            placeStair(world, x, baseY, -3, Material.POLISHED_ANDESITE_STAIRS, BlockFace.SOUTH) // north edge: stairs face south (descending into the dais looks like going down)
            placeStair(world, x, baseY,  3, Material.POLISHED_ANDESITE_STAIRS, BlockFace.NORTH)
        }
        for (z in -2..2) {
            placeStair(world, -3, baseY, z, Material.POLISHED_ANDESITE_STAIRS, BlockFace.EAST)
            placeStair(world,  3, baseY, z, Material.POLISHED_ANDESITE_STAIRS, BlockFace.WEST)
        }

        // Behind the desk: paper §7.2 — the LP-vault chest grid. Nine
        // chests in a 3×3 wall (x=-1,0,1 × y=baseY+1..baseY+3) at
        // z=-2, framed by a band of chiseled bookshelves on the
        // outer columns (x=-3,-2,2,3) so the chest wall reads as set
        // INTO the library, not floating. Chests are filled with
        // gold ingots (1 ingot per 100 USDC) by ChestRenderer based
        // on live LpVault.totalAssets() — visitors see the lender
        // vault filling and emptying in real time.
        //
        // The frame keeps the half-block diagonal closures at z=-3
        // that prevent Mineflayer's walkToward overshoot from leaking
        // the wizard out the back; the chest column never gets a
        // back row so the chest doors can open.
        for (x in listOf(-3, -2, 2, 3)) {
            for (y in (baseY + 1)..(baseY + 3)) {
                set(world, x, y, -2, Material.CHISELED_BOOKSHELF)
            }
        }
        for (x in listOf(-2, 2)) {
            set(world, x, baseY + 1, -3, Material.CHISELED_BOOKSHELF)
            set(world, x, baseY + 2, -3, Material.CHISELED_BOOKSHELF)
        }
        // Gold-vault chest grid — 3 columns × 3 rows, all facing south
        // (visitor side) so right-clicking reveals the gold inside.
        // Each chest is set to SINGLE so adjacent chests don't merge
        // into double-chests. ChestRenderer expects exactly these
        // coordinates (see VAULT_CHEST_COORDS in ChestRenderer.kt).
        for (x in -1..1) {
            for (y in (baseY + 1)..(baseY + 3)) {
                placeSingleChest(world, x, y, -2, BlockFace.SOUTH)
            }
        }

        // Lectern at platform center, facing south so visitors approach
        // it and the open book angles toward them. The wizard NPC stands
        // BEHIND the lectern at (0, baseY+1, -1) — that block is left
        // empty deliberately (don't put a bookshelf there or he can't
        // stand on it).
        set(world, 0, baseY + 1, 0, Material.LECTERN)

        // Quill jar — cauldron with water at one corner of the dais,
        // for "ink". Decorative.
        set(world, -1, baseY + 1, 1, Material.WATER_CAULDRON)

        // Two soul-lantern posts at the front corners — iron-bar pillars
        // 3 high, soul-lantern on top. Cool blue light, no fire damage.
        for (cornerX in listOf(-3, 3)) {
            for (y in baseY..baseY + 2) {
                set(world, cornerX, y, 3, Material.IRON_BARS)
            }
            set(world, cornerX, baseY + 3, 3, Material.SOUL_LANTERN)
        }
        // Two more lantern posts on the back corners for symmetry
        for (cornerX in listOf(-3, 3)) {
            for (y in baseY..baseY + 2) {
                set(world, cornerX, y, -3, Material.IRON_BARS)
            }
            set(world, cornerX, baseY + 3, -3, Material.SOUL_LANTERN)
        }

        // Hanging sign on each front lantern post identifying the desk
        set(world, -3, baseY + 2, 4, Material.OAK_HANGING_SIGN)
        set(world,  3, baseY + 2, 4, Material.OAK_HANGING_SIGN)

        // Receipt plaque next to the LP-vault chest grid. Sits on the
        // east face of an iron-bar lantern post (x=4 is air, place the
        // sign at x=4 attached to the bookshelf wall at x=3, facing
        // east into the plaza so visitors approaching the desk read
        // the latest treasury.inflow before they reach the chests).
        // ReceiptPlaques.kt populates the 4 lines on every event.
        // Coordinate documented in ReceiptPlaques.lpVaultSign — keep
        // both in lockstep when moving.
        placeWallSign(world, 4, baseY + 2, -2, BlockFace.EAST)

        // A small "rug" of red wool in front of the lectern — visual
        // cue for where visitors stand.
        for (z in 1..2) {
            for (x in -1..1) {
                set(world, x, baseY + 1, z, Material.RED_CARPET)
            }
        }
    }

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

    /**
     * Place an OAK_WALL_SIGN at (x,y,z) attached to its supporting block
     * by `facing`. ReceiptPlaques.kt populates the lines from runtime
     * events; this just ensures the sign block exists with the right
     * orientation.
     */
    private fun placeWallSign(world: World, x: Int, y: Int, z: Int, facing: BlockFace) {
        val block = world.getBlockAt(x, y, z)
        block.type = Material.OAK_WALL_SIGN
        val data = block.blockData
        if (data is org.bukkit.block.data.type.WallSign) {
            data.facing = facing
            block.blockData = data
        }
    }

    /** Place a vanilla chest with type=SINGLE so adjacent chests don't
     *  merge into double-chests. Used for the LP-vault 3×3 chest wall;
     *  ChestRenderer fills the inventory based on agent-state. */
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
    // 2. Pledge altar (east) — diorite ring + lit core
    // -----------------------------------------------------------------

    private fun buildPledgeAltar(world: World) {
        val cx = 30; val cz = 0; val baseY = plazaY + 1
        // Diorite outer ring (5×5)
        fill(world, cx - 2, baseY, cz - 2, cx + 2, baseY, cz + 2, Material.POLISHED_DIORITE)
        // Marble inner ring (3×3, raised)
        fill(world, cx - 1, baseY + 1, cz - 1, cx + 1, baseY + 1, cz + 1, Material.QUARTZ_BLOCK)
        // Pillar
        for (y in baseY + 2..baseY + 5) set(world, cx, y, cz, Material.QUARTZ_PILLAR)
        // Glowing core (sea lantern + soul torch attribution)
        set(world, cx, baseY + 6, cz, Material.SEA_LANTERN)
        set(world, cx, baseY + 7, cz, Material.GLOWSTONE)
        // Pledge sign
        set(world, cx, baseY + 1, cz + 2, Material.OAK_SIGN)
    }

    // -----------------------------------------------------------------
    // 3. Mark belfry (north) — cobblestone spire + bell
    // -----------------------------------------------------------------

    private fun buildMarkBelfry(world: World) {
        val cx = 0; val cz = -45; val baseY = plazaY + 1
        // 3×3 base widening up to a spire
        for (y in baseY until baseY + 14) {
            fill(world, cx - 1, y, cz - 1, cx + 1, y, cz + 1, Material.COBBLESTONE)
        }
        // Belfry chamber (open arches): hollow it from y+10..y+13
        fill(world, cx - 1, baseY + 10, cz - 1, cx + 1, baseY + 13, cz + 1, Material.AIR)
        // Re-place the four corners as posts
        for (y in baseY + 10..baseY + 13) {
            set(world, cx - 1, y, cz - 1, Material.COBBLESTONE_WALL)
            set(world, cx + 1, y, cz - 1, Material.COBBLESTONE_WALL)
            set(world, cx - 1, y, cz + 1, Material.COBBLESTONE_WALL)
            set(world, cx + 1, y, cz + 1, Material.COBBLESTONE_WALL)
        }
        // Roof slab + bell
        fill(world, cx - 2, baseY + 14, cz - 2, cx + 2, baseY + 14, cz + 2, Material.COBBLESTONE_SLAB)
        set(world, cx, baseY + 12, cz, Material.BELL)
        // Brazier at base east
        set(world, cx + 2, baseY, cz, Material.CAMPFIRE)
        // TWAP sign at eye level facing south (toward tower)
        set(world, cx, baseY + 1, cz + 2, Material.OAK_HANGING_SIGN)

        // Second sign one block below the TWAP sign — populated once
        // at start by ReceiptPlaques.kt with the issuer pubkey from
        // /.well-known/x402. Visitors look up at the belfry, see
        // "MARK / twap 0.42 / 4200 bps / 12:34:56" on the upper sign,
        // and "SIGNED BY VANTA / ed25…0895 / pubkey from /
        // .well-known/x402" on the lower — proves the feed is the
        // enclave's, not the world's.
        placeWallSign(world, cx, baseY, cz + 1, BlockFace.SOUTH)
    }

    // -----------------------------------------------------------------
    // 4. Verifier altar (west) — andesite + amethyst core
    // -----------------------------------------------------------------

    private fun buildVerifierAltar(world: World) {
        val cx = -30; val cz = 0; val baseY = plazaY + 1
        fill(world, cx - 2, baseY, cz - 2, cx + 2, baseY, cz + 2, Material.POLISHED_ANDESITE)
        fill(world, cx - 1, baseY + 1, cz - 1, cx + 1, baseY + 1, cz + 1, Material.SMOOTH_BASALT)
        for (y in baseY + 2..baseY + 5) set(world, cx, y, cz, Material.BASALT)
        set(world, cx, baseY + 6, cz, Material.AMETHYST_BLOCK)
        set(world, cx, baseY + 7, cz, Material.AMETHYST_CLUSTER)
        set(world, cx, baseY + 1, cz + 2, Material.OAK_SIGN)

        // 4-event ticker — four hanging signs on a fence-post run two
        // blocks east of the altar core, all attached to oak fences so
        // they hang at eye level. ReceiptPlaques.kt fills them every
        // 5s with the latest 4 events: type + truncated event id +
        // wall-clock time. Visitors at the altar can read the chain's
        // recent activity at a glance and click each row in the console
        // to drill into the full signed payload.
        val tickerY = baseY + 2
        val tickerZ = cz + 3
        // Fence pillars to hang the signs from — one block south of the
        // altar core. Place 4 oak-fence posts at x = cx-3, cx-1, cx+1,
        // cx+3 (matches ReceiptPlaques.verifierTickerSigns).
        for (offset in listOf(-3, -1, 1, 3)) {
            set(world, cx + offset, baseY + 1, tickerZ - 1, Material.OAK_FENCE)
            set(world, cx + offset, baseY + 2, tickerZ - 1, Material.OAK_FENCE)
            // Hanging sign attached UNDER the fence post (default y is
            // tickerY = baseY+2; the sign sits below the post, dangling
            // toward the visitor at eye level y=baseY+2 on a 1-block
            // sign body). HANGING signs auto-attach to the block above.
            set(world, cx + offset, tickerY, tickerZ, Material.OAK_HANGING_SIGN)
        }
    }

    // -----------------------------------------------------------------
    // 5. Graveyard (south) — fence + plaque grid
    // -----------------------------------------------------------------

    private fun buildGraveyard(world: World) {
        val cx = 0; val cz = 45; val baseY = plazaY + 1
        // Iron-bar perimeter, 24×24
        val r = 12
        for (x in cx - r..cx + r) {
            set(world, x, baseY,     cz - r, Material.IRON_BARS)
            set(world, x, baseY + 1, cz - r, Material.IRON_BARS)
            set(world, x, baseY,     cz + r, Material.IRON_BARS)
            set(world, x, baseY + 1, cz + r, Material.IRON_BARS)
        }
        for (z in cz - r..cz + r) {
            set(world, cx - r, baseY,     z, Material.IRON_BARS)
            set(world, cx - r, baseY + 1, z, Material.IRON_BARS)
            set(world, cx + r, baseY,     z, Material.IRON_BARS)
            set(world, cx + r, baseY + 1, z, Material.IRON_BARS)
        }
        // Soul-fire braziers at corners (cool blue light)
        set(world, cx - r, baseY, cz - r, Material.SOUL_CAMPFIRE)
        set(world, cx + r, baseY, cz - r, Material.SOUL_CAMPFIRE)
        // Plaque grid: 7 columns × 2 rows. 14 plaques total — each one
        // gets a wall sign on its south face, populated by
        // ReceiptPlaques.kt as loan.settlement / loan.liquidation
        // events arrive (round-robin, oldest plaque overwritten last).
        // Coordinates are duplicated in ReceiptPlaques.graveyardPlaqueSigns
        // — keep both lists in lockstep.
        for (col in -3..3) {
            for (row in 0..1) {
                val px = cx + col * 3
                val pz = cz + row * 3 - 2
                set(world, px, baseY,     pz, Material.STONE_BRICKS)
                set(world, px, baseY + 1, pz, Material.CHISELED_STONE_BRICKS)
                set(world, px, baseY + 2, pz, Material.STONE_BRICK_SLAB)
                // Wall sign on the south face of the chiselled body.
                placeWallSign(world, px, baseY + 1, pz - 1, BlockFace.SOUTH)
            }
        }
    }

    // -----------------------------------------------------------------
    // Spawn — south of the desk, on the open plaza, facing the lectern
    // -----------------------------------------------------------------

    private fun setSpawnSouthOfDesk(world: World) {
        // Spawn matches PlayerListener.kt's gate teleport — SE corner
        // of the plaza so visitors arrive at the edge and walk
        // diagonally NW toward the desk in the centre.
        val spawn = Location(world, 52.5, (plazaY + 2).toDouble(), 52.5, 135f, 0f)
        world.setSpawnLocation(spawn.blockX, spawn.blockY, spawn.blockZ)
    }

    // -----------------------------------------------------------------
    // Spawn pad — visible "town gate" tucked into the SE CORNER of the
    // plaza, near the perimeter ring at (60, 60). The arch faces NW
    // toward the desk: visitors land on the pad, look across the
    // plaza at the lectern, and walk through the gate diagonally
    // into town. Reads like a real entry-point at the edge.
    // -----------------------------------------------------------------

    private fun buildSpawnPad(world: World) {
        val padCx = 52
        val padCz = 52
        val padY = plazaY + 1                 // top surface at y=64
        // 5×5 polished andesite pad
        for (x in (padCx - 2)..(padCx + 2)) {
            for (z in (padCz - 2)..(padCz + 2)) {
                set(world, x, padY, z, Material.POLISHED_ANDESITE)
            }
        }
        // Corner end-rods (vertical light pillars marking the gate)
        for ((dx, dz) in listOf(-2 to -2, -2 to 2, 2 to -2, 2 to 2)) {
            set(world, padCx + dx, padY + 1, padCz + dz, Material.END_ROD)
        }
        // Stone-brick arch on the SE side of the pad (the "outside"
        // edge facing the perimeter), so visitors are framed by the
        // arch when they look NW toward the desk.
        for (y in (padY + 1)..(padY + 4)) {
            set(world, padCx + 2, y, padCz - 2, Material.STONE_BRICKS)
            set(world, padCx + 2, y, padCz + 2, Material.STONE_BRICKS)
        }
        for (z in (padCz - 2)..(padCz + 2)) {
            set(world, padCx + 2, padY + 4, z, Material.CHISELED_STONE_BRICKS)
            set(world, padCx + 2, padY + 5, z, Material.POLISHED_BLACKSTONE)
        }
        // Two soul-lanterns hanging from the arch lintel
        set(world, padCx + 2, padY + 3, padCz - 1, Material.SOUL_LANTERN)
        set(world, padCx + 2, padY + 3, padCz + 1, Material.SOUL_LANTERN)
        // Welcome-mat: red carpet running NW across the pad, pointing
        // toward the desk at world centre.
        for (d in -2..2) {
            set(world, padCx + d, padY + 1, padCz + d, Material.RED_CARPET)
        }
    }
}

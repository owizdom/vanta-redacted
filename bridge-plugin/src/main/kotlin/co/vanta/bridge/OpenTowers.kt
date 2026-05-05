/**
 * VANTA — open-layer tower renderer (paper §8).
 *
 * Polls /open/town/state every 10s. For each tower in the response
 * we haven't placed yet, builds a small wood-stripe tower at the
 * runtime-assigned plot, lights a stained-glass beacon in the
 * agent's robe colour, and spawns a name-tag-only armor stand
 * wearing the same colour leather chestplate.
 *
 * Coordinates mirror runtime/src/services/open-towers.ts EXACTLY:
 *   plazaY (=63) -> baseY 64
 *   ring radius 90 around (0, *, 0)
 *   plotIndex 0 reserved for VANTA's own tower (not rendered here;
 *   WorldBuilder places that one).
 *
 * Visible-side cosmetics are intentionally minimal in v1:
 *   - chatName  -> armor-stand custom-name above the plinth
 *   - skin      -> persisted but ignored (mineflayer skin pipeline
 *                  is a follow-up; the entity is an armor stand,
 *                  not a player)
 *   - robeColor -> coloured beacon glass + leather chestplate dye
 */
package co.vanta.bridge

import net.kyori.adventure.text.Component
import org.bukkit.Bukkit
import org.bukkit.Color
import org.bukkit.Location
import org.bukkit.Material
import org.bukkit.NamespacedKey
import org.bukkit.World
import org.bukkit.entity.ArmorStand
import org.bukkit.entity.EntityType
import org.bukkit.inventory.ItemStack
import org.bukkit.inventory.meta.LeatherArmorMeta
import org.bukkit.persistence.PersistentDataType
import org.bukkit.plugin.java.JavaPlugin
import org.bukkit.scheduler.BukkitTask
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.atomic.AtomicBoolean

class OpenTowers(private val plugin: JavaPlugin) {

    private val http = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        .build()

    private val runtimeUrl = System.getenv("VANTA_RUNTIME_URL") ?: "http://runtime:8787"

    // Mirrors runtime/src/services/open-towers.ts. Changing one without
    // the other puts the visible tower in the wrong spot.
    private val plazaBaseY = 64
    private val towerHeight = 9

    private val running = AtomicBoolean(false)
    private val placed = mutableSetOf<Int>()                       // plotIndex set
    private val standsByTowerId = mutableMapOf<String, ArmorStand>()
    private var task: BukkitTask? = null

    fun start() {
        if (!running.compareAndSet(false, true)) return
        // 10s cadence (200 ticks). 5s warm-up so the runtime has time
        // to finish booting on a fresh `docker compose up`.
        task = Bukkit.getScheduler().runTaskTimerAsynchronously(plugin, Runnable {
            try {
                tick()
            } catch (e: Exception) {
                plugin.logger.warning("vanta-open: tick failed: ${e.message}")
            }
        }, 100L, 200L)
        plugin.logger.info("vanta-open: tower poller started, 10s cadence")
    }

    fun stop() {
        running.set(false)
        task?.cancel()
        task = null
    }

    private fun tick() {
        val req = HttpRequest.newBuilder()
            .uri(URI.create("$runtimeUrl/open/town/state"))
            .timeout(Duration.ofSeconds(8))
            .GET()
            .build()
        val resp = http.send(req, HttpResponse.BodyHandlers.ofString())
        if (resp.statusCode() != 200) return

        val towers = parseTowers(resp.body())
        if (towers.isEmpty()) return

        // Apply on the main thread — Bukkit world ops aren't thread-safe.
        Bukkit.getScheduler().runTask(plugin, Runnable {
            try {
                applyTowers(towers)
            } catch (e: Exception) {
                plugin.logger.warning("vanta-open: world apply failed: ${e.message}")
            }
        })
    }

    private fun applyTowers(towers: List<TowerRec>) {
        val world = Bukkit.getWorlds().firstOrNull() ?: return
        for (t in towers) {
            if (t.plotIndex in placed) {
                updateNameTag(t)
                continue
            }
            try {
                buildTowerAt(world, t)
                placed.add(t.plotIndex)
                plugin.logger.info("vanta-open: placed tower ${t.towerId} at plot ${t.plotIndex} (${t.plotX}, ${t.plotZ}) for ${t.chatName}")
            } catch (e: Exception) {
                plugin.logger.warning("vanta-open: build failed for ${t.towerId}: ${e.message}")
            }
        }
    }

    private fun buildTowerAt(world: World, t: TowerRec) {
        val pdc = world.persistentDataContainer
        val key = NamespacedKey(plugin, "vanta_open_tower_${t.plotIndex}")
        if (pdc.get(key, PersistentDataType.STRING) == "v1") {
            // Already placed in a prior server run; just remember.
            placed.add(t.plotIndex)
            return
        }

        val cx = t.plotX
        val cz = t.plotZ
        val baseY = plazaBaseY

        // Clear the column so we don't build inside whatever was there.
        for (y in baseY..(baseY + towerHeight + 3)) {
            for (dx in -2..2) for (dz in -2..2) {
                world.getBlockAt(cx + dx, y, cz + dz).type = Material.AIR
            }
        }

        // Stone foundation pad (3x3 polished stone, embedded into plaza).
        for (dx in -1..1) for (dz in -1..1) {
            world.getBlockAt(cx + dx, baseY - 1, cz + dz).type = Material.POLISHED_BLACKSTONE
        }

        // Wood-log shaft, 4x4 hollow square, 9 high — a small shadow of
        // VANTA's own stone tower. The square's outer ring is logs;
        // the inside is air so any future visitor can climb in.
        for (y in baseY..(baseY + towerHeight - 1)) {
            for (dx in -1..2) for (dz in -1..2) {
                val isEdge = (dx == -1 || dx == 2 || dz == -1 || dz == 2)
                if (isEdge) {
                    world.getBlockAt(cx + dx, y, cz + dz).type = Material.OAK_LOG
                }
            }
        }

        // Iron-block pyramid base for the beacon (3x3 at baseY+towerHeight,
        // beacon block one above), then the coloured glass cap.
        for (dx in -1..1) for (dz in -1..1) {
            world.getBlockAt(cx + dx, baseY + towerHeight, cz + dz).type = Material.IRON_BLOCK
        }
        world.getBlockAt(cx, baseY + towerHeight + 1, cz).type = Material.BEACON
        world.getBlockAt(cx, baseY + towerHeight + 2, cz).type = robeGlass(t.robeColor)

        // Armor stand wizard, glowing, in front of the tower facing the
        // origin (so visitors walking out from VANTA's tower see his face).
        val standLoc = Location(
            world,
            cx + 0.5,
            (baseY).toDouble(),
            cz + 0.5,
        )
        // Face inward (toward origin) — yaw is degrees, 0 = south.
        val yaw = Math.toDegrees(Math.atan2(-cx.toDouble(), -cz.toDouble())).toFloat()
        standLoc.yaw = yaw

        val stand = world.spawnEntity(standLoc, EntityType.ARMOR_STAND) as ArmorStand
        stand.customName(Component.text(t.chatName))
        stand.isCustomNameVisible = true
        stand.isInvulnerable = true
        stand.isPersistent = true
        stand.isGlowing = true
        stand.setBasePlate(true)
        stand.setArms(true)

        val chest = ItemStack(Material.LEATHER_CHESTPLATE)
        val meta = chest.itemMeta as LeatherArmorMeta
        meta.setColor(robeRgb(t.robeColor))
        chest.itemMeta = meta
        stand.equipment?.chestplate = chest
        // Plain leather helmet so it actually looks like a wizard with
        // something on his head, dyed to match.
        val helm = ItemStack(Material.LEATHER_HELMET)
        val helmMeta = helm.itemMeta as LeatherArmorMeta
        helmMeta.setColor(robeRgb(t.robeColor))
        helm.itemMeta = helmMeta
        stand.equipment?.helmet = helm

        standsByTowerId[t.towerId] = stand

        pdc.set(key, PersistentDataType.STRING, "v1")
    }

    private fun updateNameTag(t: TowerRec) {
        val stand = standsByTowerId[t.towerId] ?: return
        stand.customName(Component.text(t.chatName))
    }

    private fun robeGlass(color: String): Material = when (color) {
        "red" -> Material.RED_STAINED_GLASS
        "orange" -> Material.ORANGE_STAINED_GLASS
        "yellow" -> Material.YELLOW_STAINED_GLASS
        "green" -> Material.LIME_STAINED_GLASS
        "blue" -> Material.LIGHT_BLUE_STAINED_GLASS
        "purple" -> Material.PURPLE_STAINED_GLASS
        "white" -> Material.WHITE_STAINED_GLASS
        "black" -> Material.BLACK_STAINED_GLASS
        else -> Material.WHITE_STAINED_GLASS
    }

    private fun robeRgb(color: String): Color = when (color) {
        "red" -> Color.fromRGB(196, 66, 61)
        "orange" -> Color.fromRGB(217, 122, 58)
        "yellow" -> Color.fromRGB(217, 193, 74)
        "green" -> Color.fromRGB(79, 156, 90)
        "blue" -> Color.fromRGB(93, 114, 214)
        "purple" -> Color.fromRGB(139, 101, 200)
        "white" -> Color.fromRGB(223, 225, 234)
        "black" -> Color.fromRGB(38, 42, 50)
        else -> Color.WHITE
    }

    // ----- runtime → kotlin model mapping ------------------------------

    private data class TowerRec(
        val towerId: String,
        val chatName: String,
        val robeColor: String,
        val plotIndex: Int,
        val plotX: Int,
        val plotZ: Int,
    )

    /**
     * Lightweight JSON parse — same hand-rolled extractor pattern as
     * MarkBelfry. Avoids pulling in a JSON dep and keeps the plugin
     * jar small. We only need 6 fields per tower from a known shape.
     */
    private fun parseTowers(json: String): List<TowerRec> {
        val out = mutableListOf<TowerRec>()
        // Find the "towers" array and walk top-level objects inside it.
        val arrStart = json.indexOf("\"towers\":")
        if (arrStart < 0) return out
        val openBracket = json.indexOf('[', arrStart)
        if (openBracket < 0) return out
        var i = openBracket + 1
        var depth = 0
        var objStart = -1
        while (i < json.length) {
            val c = json[i]
            when {
                c == '{' -> {
                    if (depth == 0) objStart = i
                    depth++
                }
                c == '}' -> {
                    depth--
                    if (depth == 0 && objStart >= 0) {
                        val rec = parseTowerObject(json.substring(objStart, i + 1))
                        if (rec != null) out.add(rec)
                        objStart = -1
                    }
                }
                c == ']' && depth == 0 -> return out
            }
            i++
        }
        return out
    }

    private fun parseTowerObject(obj: String): TowerRec? {
        val id = extractField(obj, "id") ?: return null
        val chat = extractField(obj, "chatName") ?: return null
        val robe = extractField(obj, "robeColor") ?: return null
        val plotIdx = extractField(obj, "plotIndex")?.toIntOrNull() ?: return null
        val plotX = extractField(obj, "plotX")?.toIntOrNull() ?: return null
        val plotZ = extractField(obj, "plotZ")?.toIntOrNull() ?: return null
        return TowerRec(
            towerId = id,
            chatName = chat,
            robeColor = robe,
            plotIndex = plotIdx,
            plotX = plotX,
            plotZ = plotZ,
        )
    }

    private fun extractField(json: String, key: String): String? {
        val pattern = "\"$key\":".toRegex()
        val match = pattern.find(json) ?: return null
        var i = match.range.last + 1
        while (i < json.length && json[i].isWhitespace()) i++
        if (i >= json.length) return null
        return if (json[i] == '"') {
            val end = json.indexOf('"', i + 1)
            if (end < 0) null else json.substring(i + 1, end)
        } else {
            var end = i
            while (end < json.length
                && json[end] != ','
                && json[end] != '}'
                && !json[end].isWhitespace()
            ) end++
            json.substring(i, end)
        }
    }
}

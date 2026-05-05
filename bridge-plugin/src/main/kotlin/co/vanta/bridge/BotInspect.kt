/**
 * VANTA — in-world bot reveal (Ship 2 of the Polymarket-visibility plan).
 *
 * Right-click a population bot (Alice/Bob/Eve/Cynthia/Daniel) → the
 * clicker (and only the clicker) sees a 5-line reveal with the bot's
 * Polymarket position, live mid, recent interactions, and a clickable
 * link to the market on polymarket.com.
 *
 * Floating armor-stand label above each bot shows an abbreviated
 * "Bot · SIDE shortName · mid X.XXXX" string, refreshed every 5s. The
 * stand follows the bot via a 1Hz teleport task (cheap; one entity per
 * population bot).
 *
 * Per-player rate-limit (8 inspections / 10s) mirrors ChatBridge so
 * mass-clicking the same bot doesn't pound the runtime. Cancels the
 * vanilla "swap held items" interaction so the click feels like a UI
 * affordance, not an inventory transfer.
 *
 * Net-new in this slice — no listener for PlayerInteractEntityEvent
 * existed previously.
 */
package co.vanta.bridge

import net.kyori.adventure.text.Component
import net.kyori.adventure.text.event.ClickEvent
import net.kyori.adventure.text.format.NamedTextColor
import org.bukkit.Bukkit
import org.bukkit.Location
import org.bukkit.entity.ArmorStand
import org.bukkit.entity.EntityType
import org.bukkit.entity.Player
import org.bukkit.event.EventHandler
import org.bukkit.event.EventPriority
import org.bukkit.event.Listener
import org.bukkit.event.player.PlayerInteractEntityEvent
import org.bukkit.plugin.java.JavaPlugin
import org.bukkit.scheduler.BukkitTask
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class BotInspect(private val plugin: JavaPlugin) : Listener {

    private val http = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(4))
        .build()

    private val runtimeUrl = System.getenv("VANTA_RUNTIME_URL") ?: "http://runtime:8787"

    private val BOT_NAMES = setOf("Alice", "Bob", "Eve", "Cynthia", "Daniel")

    // Per-player rate-limiting: 8 inspections per 10s window.
    private data class Window(val started: Long, var count: Int)
    private val windows = ConcurrentHashMap<UUID, Window>()
    private val WINDOW_MS = 10_000L
    private val WINDOW_MAX = 8

    // Floating-label state. One armor stand per bot; held weakly via
    // the entity's UUID (we re-resolve from Bukkit on every tick).
    private val labelByBot = mutableMapOf<String, UUID>()
    private var followTask: BukkitTask? = null
    private var refreshTask: BukkitTask? = null

    // Cached label text per bot — refreshed every 5s from runtime.
    private val labelTextByBot = ConcurrentHashMap<String, String>()

    fun start() {
        // 1Hz follow-tick — pin each label 2.4 blocks above the bot's
        // current position. Synchronous because entity reads / setLocation
        // must happen on the main thread.
        followTask = Bukkit.getScheduler().runTaskTimer(plugin, Runnable {
            for ((botName, standId) in labelByBot.toMap()) {
                val bot = Bukkit.getPlayerExact(botName) ?: continue
                val stand = Bukkit.getEntity(standId) as? ArmorStand
                if (stand == null) {
                    // entity lost (chunk unload, /kill, etc.) — drop the
                    // mapping so the next refresh re-spawns it
                    labelByBot.remove(botName)
                    continue
                }
                val target = bot.location.clone().add(0.0, 2.4, 0.0)
                stand.teleport(target)
            }
            // Pick up bots that have come online since last spawn pass.
            for (name in BOT_NAMES) {
                if (labelByBot[name] == null) {
                    val bot = Bukkit.getPlayerExact(name) ?: continue
                    spawnLabel(name, bot.location)
                }
            }
        }, 20L, 20L)

        // 5s refresh cadence: pull /api/bots/positions, build label
        // text per bot. Async so the HTTP call doesn't stall the tick
        // thread; back to main thread to update the customName.
        refreshTask = Bukkit.getScheduler().runTaskTimerAsynchronously(plugin, Runnable {
            try {
                val resp = http.send(
                    HttpRequest.newBuilder()
                        .uri(URI.create("$runtimeUrl/api/bots/positions"))
                        .timeout(Duration.ofSeconds(4))
                        .GET()
                        .build(),
                    HttpResponse.BodyHandlers.ofString(),
                )
                if (resp.statusCode() != 200) return@Runnable
                val labels = parseLabels(resp.body())
                Bukkit.getScheduler().runTask(plugin, Runnable {
                    for ((botName, label) in labels) {
                        labelTextByBot[botName] = label
                        val standId = labelByBot[botName] ?: continue
                        val stand = Bukkit.getEntity(standId) as? ArmorStand ?: continue
                        stand.customName(Component.text(label).color(NamedTextColor.AQUA))
                    }
                })
            } catch (_: Exception) {
                // Runtime unreachable or parse error — keep the previous
                // label text. Floater stays whatever it was last cycle.
            }
        }, 40L, 100L)
    }

    fun stop() {
        followTask?.cancel(); followTask = null
        refreshTask?.cancel(); refreshTask = null
        for ((_, standId) in labelByBot) {
            val stand = Bukkit.getEntity(standId) as? ArmorStand ?: continue
            stand.remove()
        }
        labelByBot.clear()
    }

    // ----- Right-click reveal ----------------------------------------

    @EventHandler(priority = EventPriority.HIGH, ignoreCancelled = true)
    fun onInteract(event: PlayerInteractEntityEvent) {
        val target = event.rightClicked
        if (target !is Player) return
        val botName = target.name
        if (botName !in BOT_NAMES) return
        val clicker = event.player
        if (clicker.uniqueId == target.uniqueId) return // bots clicking themselves

        // Cancel the vanilla swap-held-items interaction so the click
        // feels like a UI affordance, not an inventory action.
        event.isCancelled = true

        if (!checkRate(clicker.uniqueId)) {
            clicker.sendMessage(
                Component.text("(rate limited — slow down)").color(NamedTextColor.GRAY),
            )
            return
        }

        Bukkit.getScheduler().runTaskAsynchronously(plugin, Runnable {
            try {
                val resp = http.send(
                    HttpRequest.newBuilder()
                        .uri(URI.create("$runtimeUrl/api/bots/$botName"))
                        .timeout(Duration.ofSeconds(5))
                        .GET()
                        .build(),
                    HttpResponse.BodyHandlers.ofString(),
                )
                if (resp.statusCode() != 200) {
                    Bukkit.getScheduler().runTask(plugin, Runnable {
                        clicker.sendMessage(
                            Component.text("(runtime ${resp.statusCode()} — bot reveal unavailable)")
                                .color(NamedTextColor.GRAY),
                        )
                    })
                    return@Runnable
                }
                val view = parseBotView(resp.body())
                Bukkit.getScheduler().runTask(plugin, Runnable {
                    sendReveal(clicker, view)
                })
            } catch (e: Exception) {
                Bukkit.getScheduler().runTask(plugin, Runnable {
                    clicker.sendMessage(
                        Component.text("(runtime error: ${e.message?.take(80)})")
                            .color(NamedTextColor.GRAY),
                    )
                })
            }
        })
    }

    private fun sendReveal(p: Player, v: BotView) {
        val divider = "─".repeat(38)
        p.sendMessage(Component.text(divider).color(NamedTextColor.DARK_GRAY))
        p.sendMessage(
            Component.text("[${v.name}] ").color(NamedTextColor.LIGHT_PURPLE)
                .append(Component.text("· ${v.role}").color(NamedTextColor.GRAY)),
        )
        p.sendMessage(kv("position", "${v.sizeDisplay} of ${v.side}"))
        if (v.question != null) {
            p.sendMessage(kv("market", v.question))
        }
        if (v.mid != null) {
            p.sendMessage(kv("mid (${v.side})", v.mid))
        }
        if (v.recent.isNotEmpty()) {
            val first = v.recent.first()
            p.sendMessage(kv("recent", first))
        }
        if (v.polymarketUrl != null) {
            val link = Component.text(v.polymarketUrl).color(NamedTextColor.AQUA)
                .clickEvent(ClickEvent.openUrl(v.polymarketUrl))
            p.sendMessage(
                Component.text("polymarket : ").color(NamedTextColor.GRAY).append(link),
            )
        }
        p.sendMessage(Component.text(divider).color(NamedTextColor.DARK_GRAY))
    }

    private fun kv(key: String, value: String): Component {
        return Component.text("${key.padEnd(11)}: ").color(NamedTextColor.GRAY)
            .append(Component.text(value).color(NamedTextColor.WHITE))
    }

    private fun checkRate(uuid: UUID): Boolean {
        val now = System.currentTimeMillis()
        val w = windows[uuid]
        if (w == null || now - w.started > WINDOW_MS) {
            windows[uuid] = Window(now, 1)
            return true
        }
        if (w.count >= WINDOW_MAX) return false
        w.count += 1
        return true
    }

    // ----- Floating label --------------------------------------------

    private fun spawnLabel(botName: String, anchor: Location) {
        val world = anchor.world ?: return
        val loc = anchor.clone().add(0.0, 2.4, 0.0)
        val stand = world.spawnEntity(loc, EntityType.ARMOR_STAND) as ArmorStand
        stand.isMarker = true
        stand.isInvisible = true
        stand.setGravity(false)
        stand.isCustomNameVisible = true
        stand.isInvulnerable = true
        // Don't persist — these are visual chrome and should respawn
        // cleanly each plugin load (otherwise we leak armor stands).
        stand.isPersistent = false
        val text = labelTextByBot[botName] ?: "$botName · loading…"
        stand.customName(Component.text(text).color(NamedTextColor.AQUA))
        labelByBot[botName] = stand.uniqueId
    }

    // ----- Tiny JSON parsers (no jackson dep on this plugin) ---------
    //
    // The runtime's responses are well-formed and predictable; we only
    // need a handful of fields. Reuses the extractField pattern from
    // ChatBridge with one extra helper for nested object fields.

    private data class BotView(
        val name: String,
        val role: String,
        val side: String,
        val sizeDisplay: String,
        val question: String?,
        val mid: String?,
        val polymarketUrl: String?,
        val recent: List<String>,
    )

    private fun parseBotView(json: String): BotView {
        val name = stringField(json, "name") ?: "?"
        val role = stringField(json, "role") ?: "agent"
        val side = stringField(json, "side") ?: "?"
        val sizeDisplay = stringField(json, "sizeUsdcDisplay") ?: "—"
        val question = stringField(json, "question")
        val mid = stringField(json, "mid")
        val polymarketUrl = stringField(json, "polymarketUrl")
        val recent = stringFieldsInArray(json, "recentInteractions", "text")
        return BotView(
            name = name,
            role = role,
            side = side,
            sizeDisplay = sizeDisplay,
            question = question,
            mid = mid,
            polymarketUrl = polymarketUrl,
            recent = recent,
        )
    }

    /** Build short "Bot · SIDE shortName · mid X.XXXX" labels per bot. */
    private fun parseLabels(json: String): Map<String, String> {
        val out = mutableMapOf<String, String>()
        // Cheap split on "{" within positions array. Each position
        // object lives between two { } at top level inside the array;
        // we rely on the runtime's compact JSON shape (no whitespace
        // before braces).
        val arrayStart = json.indexOf("\"positions\"")
        if (arrayStart < 0) return out
        // Walk objects: each name field uniquely identifies a bot.
        var i = arrayStart
        while (true) {
            val nameIdx = json.indexOf("\"name\"", i)
            if (nameIdx < 0) break
            // Find the start of *this* position object — last '{' before
            // nameIdx that we haven't scanned yet.
            val objStart = json.lastIndexOf('{', nameIdx)
            // And its matching closing brace by simple brace counting.
            val objEnd = matchingBrace(json, objStart)
            if (objStart < 0 || objEnd < 0) break
            val obj = json.substring(objStart, objEnd + 1)
            val n = stringField(obj, "name") ?: ""
            if (n in BOT_NAMES) {
                val side = stringField(obj, "side") ?: "?"
                val short = stringField(obj, "shortName") ?: "?"
                val mid = stringField(obj, "mid")
                val midPart = if (mid != null) " · mid $mid" else ""
                out[n] = "$n · $side $short$midPart"
            }
            i = objEnd + 1
        }
        return out
    }

    private fun matchingBrace(json: String, start: Int): Int {
        if (start < 0 || start >= json.length || json[start] != '{') return -1
        var depth = 0
        var i = start
        var inStr = false
        var esc = false
        while (i < json.length) {
            val c = json[i]
            if (inStr) {
                if (esc) { esc = false }
                else if (c == '\\') { esc = true }
                else if (c == '"') { inStr = false }
            } else {
                when (c) {
                    '"' -> inStr = true
                    '{' -> depth++
                    '}' -> { depth--; if (depth == 0) return i }
                }
            }
            i++
        }
        return -1
    }

    /** Extract a JSON string-or-null field's value. Numbers are
     *  serialized to their textual form; nulls return null. */
    private fun stringField(json: String, key: String): String? {
        val pattern = "\"$key\"\\s*:".toRegex()
        val match = pattern.find(json) ?: return null
        var i = match.range.last + 1
        while (i < json.length && json[i].isWhitespace()) i++
        if (i >= json.length) return null
        return when (json[i]) {
            '"' -> {
                val sb = StringBuilder()
                var j = i + 1
                while (j < json.length) {
                    val c = json[j]
                    if (c == '\\' && j + 1 < json.length) {
                        when (val esc = json[j + 1]) {
                            '"' -> sb.append('"')
                            'n' -> sb.append('\n')
                            't' -> sb.append('\t')
                            '\\' -> sb.append('\\')
                            '/' -> sb.append('/')
                            'u' -> if (j + 5 < json.length) {
                                val hex = json.substring(j + 2, j + 6)
                                try { sb.append(hex.toInt(16).toChar()) } catch (_: Exception) {}
                                j += 4
                            }
                            else -> sb.append(esc)
                        }
                        j += 2
                    } else if (c == '"') {
                        return sb.toString()
                    } else {
                        sb.append(c); j++
                    }
                }
                null
            }
            'n' -> {
                if (json.startsWith("null", i)) null else null
            }
            else -> {
                var end = i
                while (end < json.length && json[end] != ',' && json[end] != '}' &&
                       json[end] != ']' && !json[end].isWhitespace()) end++
                json.substring(i, end)
            }
        }
    }

    /** Extract `field` from each object of an inner array, return list. */
    private fun stringFieldsInArray(json: String, arrayKey: String, field: String): List<String> {
        val out = mutableListOf<String>()
        val arrIdx = json.indexOf("\"$arrayKey\"")
        if (arrIdx < 0) return out
        val openIdx = json.indexOf('[', arrIdx)
        if (openIdx < 0) return out
        var depth = 1
        var i = openIdx + 1
        var objStart = -1
        var inStr = false
        var esc = false
        while (i < json.length && depth > 0) {
            val c = json[i]
            if (inStr) {
                if (esc) { esc = false }
                else if (c == '\\') { esc = true }
                else if (c == '"') { inStr = false }
            } else {
                when (c) {
                    '"' -> inStr = true
                    '{' -> if (depth == 1 && objStart < 0) objStart = i
                    '}' -> if (objStart >= 0) {
                        val obj = json.substring(objStart, i + 1)
                        stringField(obj, field)?.let { out.add(it) }
                        objStart = -1
                    }
                    '[' -> depth++
                    ']' -> depth--
                }
            }
            i++
        }
        return out
    }
}

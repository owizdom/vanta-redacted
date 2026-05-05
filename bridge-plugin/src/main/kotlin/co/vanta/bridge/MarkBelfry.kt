/**
 * VANTA — mark belfry feed (Slice 1 of /plan).
 *
 * Polls /bridge/mark/tick on the runtime every 30 seconds, updates
 * the hanging sign at the mark belfry with the current TWAP, and
 * rings the bell. Spike-rings (3×) when the tick-to-tick delta
 * exceeds 5%, per paper §7.5.
 *
 * Fire-and-forget: a missed tick or a transient runtime error never
 * blocks the world (invariant I5). Last-known price is preserved on
 * the sign so a network blip just stalls the display rather than
 * blanking it.
 */
package co.vanta.bridge

import net.kyori.adventure.text.Component
import net.kyori.adventure.text.format.NamedTextColor
import org.bukkit.Bukkit
import org.bukkit.Location
import org.bukkit.Sound
import org.bukkit.SoundCategory
import org.bukkit.block.Sign
import org.bukkit.plugin.java.JavaPlugin
import org.bukkit.scheduler.BukkitTask
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.atomic.AtomicReference

class MarkBelfry(private val plugin: JavaPlugin) {

    private val http = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        .build()

    private val runtimeUrl = System.getenv("VANTA_RUNTIME_URL") ?: "http://runtime:8787"

    // Belfry coords (matches WorldBuilder.buildMarkBelfry):
    //   spire base centred at world (0, _, -45) with baseY = plazaY + 1 = 64.
    //   Hanging sign placed at (cx, baseY+1, cz+2) → world (0, 65, -43).
    //   Bell at (cx, baseY+12, cz) = (0, 76, -45).
    private val signLoc by lazy { Location(Bukkit.getWorlds()[0], 0.0, 65.0, -43.0) }
    private val bellLoc by lazy { Location(Bukkit.getWorlds()[0], 0.0, 76.0, -45.0) }

    private val lastMidBps = AtomicReference<Int>(null)
    private var task: BukkitTask? = null

    fun start() {
        // 30s cadence (20 ticks/s × 30 = 600 ticks). Initial delay 100
        // ticks (5s) so we don't pound the runtime before it's listening.
        task = Bukkit.getScheduler().runTaskTimerAsynchronously(plugin, Runnable {
            try {
                tick()
            } catch (e: Exception) {
                plugin.logger.warning("vanta-belfry: tick failed: ${e.message}")
            }
        }, 100L, 600L)
        plugin.logger.info("vanta-belfry: feed started, 30s cadence")
    }

    fun stop() {
        task?.cancel()
        task = null
    }

    private fun tick() {
        val req = HttpRequest.newBuilder()
            .uri(URI.create("$runtimeUrl/bridge/mark/tick"))
            .timeout(Duration.ofSeconds(8))
            .GET()
            .build()
        val resp = http.send(req, HttpResponse.BodyHandlers.ofString())
        if (resp.statusCode() != 200) {
            plugin.logger.warning("vanta-belfry: runtime ${resp.statusCode()}: ${resp.body().take(120)}")
            return
        }
        val body = resp.body()
        val mid = extractField(body, "mid")
        val midBps = extractField(body, "mid_bps")?.toIntOrNull() ?: return

        val prev = lastMidBps.getAndSet(midBps)
        val deltaBps = if (prev != null) Math.abs(midBps - prev) else 0
        val isSpike = prev != null && deltaBps > 500 // >5%

        // Apply sign + bell on the main thread.
        Bukkit.getScheduler().runTask(plugin, Runnable {
            try {
                updateSign(mid ?: "—.——", midBps, isSpike)
                ringBell(if (isSpike) 3 else 1)
            } catch (e: Exception) {
                plugin.logger.warning("vanta-belfry: world apply failed: ${e.message}")
            }
        })
    }

    private fun updateSign(mid: String, midBps: Int, isSpike: Boolean) {
        val state = signLoc.block.state
        if (state !is Sign) return
        val side = state.getSide(org.bukkit.block.sign.Side.FRONT)
        side.line(0, Component.text("MARK").color(NamedTextColor.AQUA))
        side.line(1, Component.text("twap " + mid).color(NamedTextColor.WHITE))
        side.line(
            2,
            Component.text("$midBps bps").color(if (isSpike) NamedTextColor.RED else NamedTextColor.GRAY)
        )
        side.line(3, Component.text(java.time.LocalTime.now().withNano(0).toString()).color(NamedTextColor.DARK_GRAY))
        state.update(true, false)
    }

    private fun ringBell(times: Int) {
        repeat(times) { i ->
            Bukkit.getScheduler().runTaskLater(plugin, Runnable {
                bellLoc.world.playSound(bellLoc, Sound.BLOCK_BELL_USE, SoundCategory.MASTER, 1.5f, 1.0f)
            }, (i * 6L))
        }
    }

    // Tiny JSON field extractor — avoids a dep, since the response shape
    // is small and stable. Returns null if the key is absent.
    private fun extractField(json: String, key: String): String? {
        val pattern = "\"$key\":".toRegex()
        val match = pattern.find(json) ?: return null
        var i = match.range.last + 1
        while (i < json.length && json[i].isWhitespace()) i++
        if (i >= json.length) return null
        return if (json[i] == '"') {
            // string
            val end = json.indexOf('"', i + 1)
            if (end < 0) null else json.substring(i + 1, end)
        } else {
            // number / bool
            var end = i
            while (end < json.length && json[end] != ',' && json[end] != '}' && !json[end].isWhitespace()) end++
            json.substring(i, end)
        }
    }
}

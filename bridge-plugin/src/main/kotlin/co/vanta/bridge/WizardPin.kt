/**
 * VANTA — Wizard desk pin.
 *
 * Mineflayer's `walkToward` (in npcs/src/Wizard.js) uses
 * `setControlState("forward", true)` with a 1.5-block arrive radius.
 * Coming back from a break (mark_belfry at z=-45 → desk at z=-0.5)
 * the wizard regularly slips past the bookshelf wall via the half-
 * block gap between the bookshelves (z=-2, x=-2..2) and the corner
 * lantern posts (z=-3, x=±3) and ends up north of the dais on plaza
 * level — visible from any angle as "wizard standing behind the
 * desk facing nothing."
 *
 * This Bukkit task runs every 3 s. When the runtime reports the
 * wizard's mode is `at_desk` and the in-world Wizard player has
 * drifted more than 2 blocks from DESK_POS, we teleport him back
 * server-side. The on_break window leaves him alone so the break
 * walk to landmarks still reads naturally.
 *
 * Single source of truth for DESK_POS lives here AND in
 * `npcs/src/Wizard.js` — both must agree. If you move the desk in
 * `WorldBuilder.kt`, update both.
 */
package co.vanta.bridge

import org.bukkit.Bukkit
import org.bukkit.Location
import org.bukkit.plugin.java.JavaPlugin
import org.bukkit.scheduler.BukkitTask
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

class WizardPin(private val plugin: JavaPlugin) {

    private val http = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(3))
        .build()

    private val runtimeUrl = System.getenv("VANTA_RUNTIME_URL") ?: "http://runtime:8787"

    // Must match npcs/src/Wizard.js DESK_POS and PlayerListener's
    // join-time teleport. Lectern is at (0, 65, 0); wizard stands
    // behind it at (0.5, 65, -0.5), facing south (yaw 0 = +Z).
    private val deskX = 0.5
    private val deskY = 65.0
    private val deskZ = -0.5
    private val deskYaw = 0f
    private val deskPitch = 0f

    /** Squared distance threshold above which we teleport. 2 blocks → 4. */
    private val driftThresholdSq = 4.0

    private var task: BukkitTask? = null

    fun start() {
        // 3 s cadence (60 ticks). Async fetch → main-thread teleport.
        task = Bukkit.getScheduler().runTaskTimerAsynchronously(plugin, Runnable {
            try {
                tick()
            } catch (e: Exception) {
                plugin.logger.warning("vanta-pin: tick failed: ${e.message}")
            }
        }, 200L, 60L)
        plugin.logger.info("vanta-pin: wizard desk-pin started, 3s cadence")
    }

    fun stop() {
        task?.cancel()
        task = null
    }

    private fun tick() {
        val req = HttpRequest.newBuilder()
            .uri(URI.create("$runtimeUrl/bridge/wizard/mode"))
            .timeout(Duration.ofSeconds(3))
            .GET()
            .build()
        val resp = http.send(req, HttpResponse.BodyHandlers.ofString())
        if (resp.statusCode() != 200) return

        // Parse the simple {"mode":"at_desk", ...} JSON inline — no
        // dep on the same lightweight extractor MarkBelfry uses.
        val mode = extractField(resp.body(), "mode") ?: return
        if (mode != "at_desk") return

        // Pin runs on the main thread because Bukkit player API is not
        // thread-safe.
        Bukkit.getScheduler().runTask(plugin, Runnable {
            val wizard = Bukkit.getPlayerExact("vanta") ?: return@Runnable
            if (!wizard.isOnline) return@Runnable
            val pos = wizard.location
            val dx = pos.x - deskX
            val dy = pos.y - deskY
            val dz = pos.z - deskZ
            val distSq = dx * dx + dy * dy + dz * dz
            if (distSq > driftThresholdSq) {
                val dest = Location(wizard.world, deskX, deskY, deskZ, deskYaw, deskPitch)
                wizard.teleport(dest)
                plugin.logger.info(
                    "vanta-pin: pulled vanta back to desk from (${pos.x}, ${pos.y}, ${pos.z})"
                )
            }
        })
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
            while (end < json.length && json[end] != ',' && json[end] != '}' && !json[end].isWhitespace()) end++
            json.substring(i, end)
        }
    }
}

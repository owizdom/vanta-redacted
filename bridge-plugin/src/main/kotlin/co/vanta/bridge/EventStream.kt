/**
 * VANTA — runtime event stream consumer.
 *
 * Subscribes to runtime SSE at /api/events/stream and dispatches each
 * appended event to its animation. v0.1 dispatch table (vanta-watchable):
 *
 *   op.inference                → particle burst above the speaker
 *   loan.pledge                 → scroll-place anim at the pledge altar
 *   loan.origination            → wizard walks to chest, gold particles
 *   loan.mark                   → belfry update + bell
 *   loan.settlement             → graveyard plaque chisel + soul particles
 *   loan.liquidation            → graveyard, redder palette + harsher anvil
 *   loan.pledge_revoked         → scroll drops at altar, particles fade
 *   loop.credit_tick            → torch-color flicker by `flag` (ok/watch/freeze)
 *   loop.calibration_proposal   → verifier altar — calibration glow + chime
 *   op.treasury_alert           → treasury bell rings, alert particle column
 *   treasury.inflow             → gold sparkle at the treasury chest
 *   treasury.outflow            → blue sparkle at the treasury chest
 *   constitutional.genesis      → silent at boot, no animation
 *
 * Fire-and-forget: a missed animation never blocks event ingestion
 * (paper §3 invariant I5). All world mutation runs on the main
 * thread via BukkitScheduler; the SSE reader stays on its own
 * background thread.
 */
package co.vanta.bridge

import org.bukkit.Bukkit
import org.bukkit.Color
import org.bukkit.Location
import org.bukkit.Particle
import org.bukkit.Sound
import org.bukkit.SoundCategory
import org.bukkit.entity.Player
import org.bukkit.plugin.java.JavaPlugin
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.atomic.AtomicBoolean

class EventStream(private val plugin: JavaPlugin) {

    private val runtimeUrl = System.getenv("VANTA_RUNTIME_URL") ?: "http://runtime:8787"
    private val running = AtomicBoolean(false)
    private var thread: Thread? = null

    // Fan-out hook for in-process consumers (e.g. ReceiptPlaques).
    // Subscribers see every event; failures in callbacks are isolated.
    private val listenersLock = Any()
    private val listeners = mutableListOf<(type: String, json: String) -> Unit>()

    /** Register an in-process listener. Called on the SSE reader thread; */
    /** any Bukkit-world mutation must hop to the main thread itself. */
    fun addListener(cb: (type: String, json: String) -> Unit) {
        synchronized(listenersLock) { listeners.add(cb) }
    }

    // Anchor coords (matches WorldBuilder).
    private val pledgeAltar = Triple(25.0, 65.0, 0.0)
    private val markBelfry = Triple(0.0, 75.0, -45.0)
    private val verifierAltar = Triple(-25.0, 65.0, 0.0)
    private val graveyard = Triple(0.0, 65.0, 35.0)
    private val deskTop = Triple(0.0, 66.0, 0.0)
    // v2 additions — reuse existing structures rather than placing new ones
    // for v0.1; v0.2 introduces dedicated treasury + history-hall coords.
    private val treasuryChest = Triple(0.0, 65.0, -10.0)

    fun start() {
        if (!running.compareAndSet(false, true)) return
        thread = Thread({ readLoop() }, "vanta-event-stream").apply {
            isDaemon = true
            start()
        }
        plugin.logger.info("vanta-events: SSE consumer started, url=$runtimeUrl/api/events/stream")
    }

    fun stop() {
        running.set(false)
        thread?.interrupt()
        thread = null
    }

    private fun readLoop() {
        val client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build()
        while (running.get()) {
            try {
                val req = HttpRequest.newBuilder()
                    .uri(URI.create("$runtimeUrl/api/events/stream"))
                    .timeout(Duration.ofMinutes(60))
                    .header("accept", "text/event-stream")
                    .GET()
                    .build()
                val resp = client.send(req, HttpResponse.BodyHandlers.ofInputStream())
                if (resp.statusCode() != 200) {
                    plugin.logger.warning("vanta-events: SSE got HTTP ${resp.statusCode()}; sleeping 5s")
                    Thread.sleep(5000)
                    continue
                }
                BufferedReader(InputStreamReader(resp.body())).use { br ->
                    while (running.get()) {
                        val line = br.readLine() ?: break
                        if (line.startsWith("data: ")) {
                            val json = line.removePrefix("data: ")
                            handleEvent(json)
                        }
                    }
                }
            } catch (e: Exception) {
                if (running.get()) {
                    plugin.logger.warning("vanta-events: stream broke (${e.message}); reconnecting in 5s")
                    try { Thread.sleep(5000) } catch (_: InterruptedException) { return }
                }
            }
        }
    }

    private fun handleEvent(json: String) {
        val type = extractField(json, "type") ?: return
        // Fan out FIRST so receipt plaques and other passive consumers
        // see every event, including ones whose `when` branch is silent.
        val snapshot = synchronized(listenersLock) { listeners.toList() }
        for (cb in snapshot) {
            try {
                cb(type, json)
            } catch (e: Exception) {
                plugin.logger.warning("vanta-events: listener failed: ${e.message}")
            }
        }
        when (type) {
            "op.inference"              -> animateInference(json)
            "loan.pledge"               -> animatePledge(json)
            "loan.origination"          -> animateOrigination(json)
            "loan.mark"                 -> animateMark(json)
            "loan.settlement"           -> animateSettlement(json)
            "loan.liquidation"          -> animateLiquidation(json)
            "loan.pledge_revoked"       -> animatePledgeRevoked(json)
            "loop.credit_tick"          -> animateCreditTick(json)
            "loop.calibration_proposal" -> animateCalibrationProposal(json)
            "op.treasury_alert"         -> animateTreasuryAlert(json)
            "treasury.inflow"           -> animateTreasuryFlow(json, inflow = true)
            "treasury.outflow"          -> animateTreasuryFlow(json, inflow = false)
            "constitutional.genesis"    -> { /* silent */ }
            else -> { /* unknown event types ignored */ }
        }
    }

    // -----------------------------------------------------------------
    // Per-event animations
    // -----------------------------------------------------------------

    private fun animateInference(json: String) {
        // Speaker is whoever has the same lineage; we approximate with
        // the wizard's location for now (most op.inference comes from
        // the wizard's think loop).
        Bukkit.getScheduler().runTask(plugin, Runnable {
            val wizard = Bukkit.getPlayerExact("vanta") ?: return@Runnable
            val loc = wizard.location.add(0.0, 2.4, 0.0)
            wizard.world.spawnParticle(Particle.ENCHANT, loc, 30, 0.4, 0.4, 0.4, 0.5)
        })
    }

    private fun animatePledge(json: String) {
        Bukkit.getScheduler().runTask(plugin, Runnable {
            val world = Bukkit.getWorlds()[0]
            val (x, y, z) = pledgeAltar
            world.spawnParticle(Particle.WAX_ON, Location(world, x, y + 2, z), 50, 0.6, 0.6, 0.6, 0.05)
            world.playSound(Location(world, x, y, z), Sound.ITEM_BOOK_PAGE_TURN, 1.5f, 1.0f)
        })
    }

    private fun animateOrigination(json: String) {
        Bukkit.getScheduler().runTask(plugin, Runnable {
            val world = Bukkit.getWorlds()[0]
            val wizard = Bukkit.getPlayerExact("vanta")
            val (x, y, z) = deskTop
            // Gold particle burst above the desk
            world.spawnParticle(
                Particle.HAPPY_VILLAGER,
                Location(world, x, y + 2, z),
                40, 1.0, 1.0, 1.0, 0.0
            )
            world.spawnParticle(
                Particle.DUST,
                Location(world, x, y + 2, z),
                60, 1.0, 1.0, 1.0, 0.0,
                Particle.DustOptions(Color.fromRGB(255, 215, 0), 1.5f)
            )
            world.playSound(Location(world, x, y, z), Sound.ENTITY_PLAYER_LEVELUP, 1.0f, 1.5f)
            if (wizard != null) {
                wizard.world.spawnParticle(
                    Particle.DUST,
                    wizard.location.add(0.0, 2.0, 0.0),
                    60, 0.4, 0.4, 0.4, 0.0,
                    Particle.DustOptions(Color.fromRGB(120, 200, 255), 1.5f)
                )
            }
        })
    }

    private fun animateMark(json: String) {
        Bukkit.getScheduler().runTask(plugin, Runnable {
            val world = Bukkit.getWorlds()[0]
            val (x, y, z) = markBelfry
            world.playSound(Location(world, x, y, z), Sound.BLOCK_BELL_USE, SoundCategory.MASTER, 2.0f, 1.0f)
            world.spawnParticle(
                Particle.NOTE,
                Location(world, x, y, z),
                12, 1.5, 0.5, 1.5, 1.0
            )
        })
    }

    private fun animateSettlement(json: String) {
        Bukkit.getScheduler().runTask(plugin, Runnable {
            val world = Bukkit.getWorlds()[0]
            val (x, y, z) = graveyard
            // Body of the event might say REPAID vs LIQUIDATED; the
            // shape of `body.outcome` isn't formal yet so we color-
            // neutral for v1.
            world.spawnParticle(Particle.SOUL, Location(world, x, y + 1, z), 40, 1.5, 1.0, 1.5, 0.05)
            world.playSound(Location(world, x, y, z), Sound.BLOCK_ANVIL_LAND, 0.7f, 0.8f)
        })
    }

    private fun animatePledgeRevoked(json: String) {
        Bukkit.getScheduler().runTask(plugin, Runnable {
            val world = Bukkit.getWorlds()[0]
            val (x, y, z) = pledgeAltar
            world.spawnParticle(Particle.SMOKE, Location(world, x, y + 1, z), 40, 0.8, 0.8, 0.8, 0.04)
        })
    }

    private fun animateLiquidation(json: String) {
        // Same site as settlement (graveyard) but a redder, harsher palette
        // — the agent had to liquidate. v1's body lacked an outcome flag;
        // v2's body schema separates settlement vs liquidation as event types.
        Bukkit.getScheduler().runTask(plugin, Runnable {
            val world = Bukkit.getWorlds()[0]
            val (x, y, z) = graveyard
            world.spawnParticle(
                Particle.DUST,
                Location(world, x, y + 1, z),
                60, 1.5, 1.0, 1.5, 0.0,
                Particle.DustOptions(Color.fromRGB(180, 30, 30), 1.6f)
            )
            world.playSound(Location(world, x, y, z), Sound.BLOCK_ANVIL_LAND, 1.2f, 0.6f)
        })
    }

    private fun animateCreditTick(json: String) {
        // The flag is the load-bearing field — v0.1 surfaces it as a
        // particle-color cue at the pledge altar (the wizard's sightline).
        // v0.2's per-loan vault rendering will move the torch onto the
        // specific loan's chest.
        val flag = extractField(json, "flag") ?: "ok"
        val color = when (flag) {
            "freeze_request" -> Color.fromRGB(220, 40, 40)
            "watch"          -> Color.fromRGB(220, 200, 40)
            else             -> Color.fromRGB(60, 200, 80)
        }
        Bukkit.getScheduler().runTask(plugin, Runnable {
            val world = Bukkit.getWorlds()[0]
            val (x, y, z) = pledgeAltar
            world.spawnParticle(
                Particle.DUST,
                Location(world, x, y + 2, z),
                20, 0.4, 0.4, 0.4, 0.0,
                Particle.DustOptions(color, 1.2f)
            )
            // Soft chime for non-default flags so freeze_request is audible.
            if (flag != "ok") {
                world.playSound(
                    Location(world, x, y, z),
                    Sound.BLOCK_NOTE_BLOCK_PLING,
                    SoundCategory.MASTER,
                    0.6f,
                    if (flag == "freeze_request") 0.6f else 1.2f,
                )
            }
        })
    }

    private fun animateCalibrationProposal(json: String) {
        // Replayer's moment — the model loop has produced a multisig
        // proposal. v0.1 anchors at the verifier altar (existing v1
        // structure); v0.2 builds a dedicated history-hall podium.
        Bukkit.getScheduler().runTask(plugin, Runnable {
            val world = Bukkit.getWorlds()[0]
            val (x, y, z) = verifierAltar
            world.spawnParticle(
                Particle.DUST,
                Location(world, x, y + 2, z),
                80, 1.0, 1.5, 1.0, 0.0,
                Particle.DustOptions(Color.fromRGB(120, 200, 255), 1.4f)
            )
            world.playSound(Location(world, x, y, z), Sound.BLOCK_BEACON_ACTIVATE, 0.7f, 1.4f)
        })
    }

    private fun animateTreasuryAlert(json: String) {
        // Operational loop alert — bell + alert column. Severity could
        // modulate intensity in v0.2; v0.1 surfaces a uniform high-emphasis
        // animation regardless of warning vs critical.
        Bukkit.getScheduler().runTask(plugin, Runnable {
            val world = Bukkit.getWorlds()[0]
            val (bx, by, bz) = markBelfry
            world.playSound(Location(world, bx, by, bz), Sound.BLOCK_BELL_USE, SoundCategory.MASTER, 2.0f, 0.7f)
            // Alert column above the treasury chest.
            val (tx, ty, tz) = treasuryChest
            for (i in 0..6) {
                world.spawnParticle(
                    Particle.DUST,
                    Location(world, tx, ty + 1.0 + i * 0.5, tz),
                    8, 0.2, 0.1, 0.2, 0.0,
                    Particle.DustOptions(Color.fromRGB(220, 40, 40), 1.3f)
                )
            }
        })
    }

    private fun animateTreasuryFlow(json: String, inflow: Boolean) {
        Bukkit.getScheduler().runTask(plugin, Runnable {
            val world = Bukkit.getWorlds()[0]
            val (x, y, z) = treasuryChest
            val color = if (inflow) Color.fromRGB(255, 215, 0) else Color.fromRGB(80, 160, 230)
            world.spawnParticle(
                Particle.DUST,
                Location(world, x, y + 1.2, z),
                40, 0.6, 0.6, 0.6, 0.0,
                Particle.DustOptions(color, 1.3f)
            )
            world.playSound(
                Location(world, x, y, z),
                if (inflow) Sound.ENTITY_ITEM_PICKUP else Sound.BLOCK_AMETHYST_BLOCK_CHIME,
                0.8f,
                if (inflow) 1.4f else 0.9f,
            )
        })
    }

    // -----------------------------------------------------------------
    // Tiny JSON field grab — same shape as MarkBelfry's. Top-level only.
    // -----------------------------------------------------------------

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

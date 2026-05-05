/**
 * VANTA — receipt plaques (paper §3 invariant I2 + §7 verifier altar).
 *
 * Closes the productive↔visible loop. The world already animates events
 * via EventStream (particles, bell rings, gold ingots in chests). What
 * was missing: a way for a visitor standing in the world to *prove* the
 * animation reflects a signed, on-chain event. This class populates four
 * receipt surfaces on every event the runtime emits:
 *
 *   1. LP-vault sign at the desk     — last `treasury.inflow` (USDC + payer + tx)
 *   2. Mark belfry second sign       — issuer pubkey ("signed by VANTA")
 *   3. Graveyard plaque grid         — `loan.settlement` / `loan.liquidation` outcomes (round-robin)
 *   4. Verifier altar 4-sign ticker  — latest 4 events of any kind, with truncated ids
 *
 * Mechanics:
 *   - Subscribes to EventStream's listener fan-out (so every signed
 *     event the runtime emits is observed exactly once).
 *   - Per-type updates run synchronously inside the listener callback
 *     (LP vault, graveyard) — they hop to the main thread to mutate
 *     world state.
 *   - The verifier ticker is refreshed every 5s by polling
 *     /api/events?limit=4. Cheaper than holding a second SSE connection
 *     and the backfill on first paint is free.
 *   - Mark belfry second sign is updated once at start (and retried
 *     until the issuer pubkey is fetched), since it changes only on
 *     a TEE restart.
 *
 * Sign coordinates are duplicated in WorldBuilder.kt — keep both in
 * lockstep when moving anything.
 */
package co.vanta.bridge

import net.kyori.adventure.text.Component
import net.kyori.adventure.text.format.NamedTextColor
import org.bukkit.Bukkit
import org.bukkit.block.Sign
import org.bukkit.block.sign.Side
import org.bukkit.plugin.java.JavaPlugin
import org.bukkit.scheduler.BukkitTask
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.concurrent.atomic.AtomicReference

class ReceiptPlaques(
    private val plugin: JavaPlugin,
    private val eventStream: EventStream,
) {
    private val http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()
    private val runtimeUrl = System.getenv("VANTA_RUNTIME_URL") ?: "http://runtime:8787"

    // Sign coords (must match WorldBuilder placements). plazaY+1 = 64.
    private val lpVaultSign = Triple(4, 66, -2)
    private val belfrySecondSign = Triple(0, 64, -44)
    // The two empty hanging signs flanking VANTA's desk. These narrate
    // the TEE-as-credit-officer + TEE-as-contract-owner relationship in
    // the world the same way the launcher's owner banner does in the UI.
    private val deskLeftSign = Triple(-3, 66, 4)
    private val deskRightSign = Triple(3, 66, 4)
    private val verifierTickerSigns = listOf(
        Triple(-33, 66, 3),
        Triple(-31, 66, 3),
        Triple(-29, 66, 3),
        Triple(-27, 66, 3),
    )
    // 7 cols × 2 rows = 14 plaques. Order matches WorldBuilder loop:
    // for col in -3..3 (outer), for row in 0..1 (inner).
    private val graveyardPlaqueSigns: List<Triple<Int, Int, Int>> = run {
        val cx = 0; val cz = 45; val baseY = 64
        val out = mutableListOf<Triple<Int, Int, Int>>()
        for (col in -3..3) {
            for (row in 0..1) {
                val px = cx + col * 3
                val pz = cz + row * 3 - 2
                out.add(Triple(px, baseY + 1, pz - 1))
            }
        }
        out
    }

    private var plaqueIdx = 0
    private val issuerPubkey = AtomicReference<String?>(null)
    private val teeAddress = AtomicReference<String?>(null)
    private var tickerTask: BukkitTask? = null
    private var belfryRetryTask: BukkitTask? = null

    private val timeFmt: DateTimeFormatter =
        DateTimeFormatter.ofPattern("HH:mm:ss").withZone(ZoneOffset.UTC)

    fun start() {
        // Subscribe to EventStream's listener fan-out.
        eventStream.addListener { type, json -> onEvent(type, json) }

        // Fetch issuer pubkey + TEE EOA async; retry if either endpoint
        // isn't ready yet at boot. Both inform the desk + belfry signs.
        Bukkit.getScheduler().runTaskAsynchronously(plugin, Runnable {
            fetchIssuer(); fetchTeeAddress()
        })
        belfryRetryTask = Bukkit.getScheduler().runTaskTimerAsynchronously(plugin, Runnable {
            if (issuerPubkey.get() == null) fetchIssuer()
            if (teeAddress.get() == null) fetchTeeAddress()
        }, 600L, 600L) // every 30s until both succeed

        // Verifier-altar ticker: refreshes the latest 4 events every 5s.
        tickerTask = Bukkit.getScheduler().runTaskTimerAsynchronously(plugin, Runnable {
            try {
                tickVerifierTicker()
            } catch (e: Exception) {
                plugin.logger.warning("vanta-receipts: ticker failed: ${e.message}")
            }
        }, 200L, 100L)

        plugin.logger.info("vanta-receipts: started, 5s ticker cadence")
    }

    fun stop() {
        tickerTask?.cancel(); tickerTask = null
        belfryRetryTask?.cancel(); belfryRetryTask = null
    }

    // -----------------------------------------------------------------
    // Per-event hooks
    // -----------------------------------------------------------------

    private fun onEvent(type: String, json: String) {
        when (type) {
            "treasury.inflow" -> Bukkit.getScheduler().runTask(plugin, Runnable {
                try { updateLpVaultSign(json) }
                catch (e: Exception) { plugin.logger.warning("vanta-receipts: lp update failed: ${e.message}") }
            })
            "loan.settlement", "loan.liquidation" ->
                Bukkit.getScheduler().runTask(plugin, Runnable {
                    try { updateGraveyardPlaque(type, json) }
                    catch (e: Exception) { plugin.logger.warning("vanta-receipts: graveyard update failed: ${e.message}") }
                })
            else -> { /* verifier ticker handles everything else via the timer */ }
        }
    }

    private fun updateLpVaultSign(json: String) {
        // Body fields are nested under "body". The hand-rolled extractor
        // grabs the FIRST occurrence; for treasury.inflow the body has
        // unique key names ("amount", "fromAddr", "txHash") that don't
        // collide with top-level fields, so this is safe today.
        val amount = extractField(json, "amount") ?: "0"
        val from = extractField(json, "fromAddr") ?: "0x0000000000000000000000000000000000000000"
        val tx = extractField(json, "txHash") ?: ""
        val world = Bukkit.getWorlds().firstOrNull() ?: return
        val (x, y, z) = lpVaultSign
        val state = world.getBlockAt(x, y, z).state as? Sign ?: return
        val side = state.getSide(Side.FRONT)
        side.line(0, Component.text("LAST DEPOSIT").color(NamedTextColor.GOLD))
        side.line(1, Component.text("${HexUtil.formatUsdc6(amount)} USDC").color(NamedTextColor.WHITE))
        side.line(2, Component.text("from ${HexUtil.truncate(from)}").color(NamedTextColor.GRAY))
        side.line(3, Component.text("tx ${HexUtil.truncate(tx, 6, 4)}").color(NamedTextColor.AQUA))
        state.update(true, false)
    }

    private fun updateGraveyardPlaque(type: String, json: String) {
        val outcome: String
        val color: NamedTextColor
        if (type == "loan.settlement") {
            outcome = "REPAID"; color = NamedTextColor.GREEN
        } else {
            outcome = "LIQUIDATED"; color = NamedTextColor.RED
        }
        val borrower = extractField(json, "borrower") ?: extractField(json, "borrowerAddr") ?: "0x0…0"
        val amount = extractField(json, "amount") ?: extractField(json, "principal") ?: "0"
        val tx = extractField(json, "tx_hash") ?: extractField(json, "txHash") ?: ""
        val world = Bukkit.getWorlds().firstOrNull() ?: return
        val (x, y, z) = graveyardPlaqueSigns[plaqueIdx % graveyardPlaqueSigns.size]
        plaqueIdx = (plaqueIdx + 1) % graveyardPlaqueSigns.size
        val state = world.getBlockAt(x, y, z).state as? Sign ?: return
        val side = state.getSide(Side.FRONT)
        side.line(0, Component.text(outcome).color(color))
        side.line(1, Component.text("${HexUtil.formatUsdc6(amount)} USDC").color(NamedTextColor.WHITE))
        side.line(2, Component.text(HexUtil.truncate(borrower)).color(NamedTextColor.GRAY))
        side.line(3, Component.text(HexUtil.truncate(tx, 6, 4)).color(NamedTextColor.AQUA))
        state.update(true, false)
    }

    // -----------------------------------------------------------------
    // Belfry second sign — issuer pubkey, written once
    // -----------------------------------------------------------------

    private fun fetchIssuer() {
        try {
            val req = HttpRequest.newBuilder()
                .uri(URI.create("$runtimeUrl/.well-known/x402"))
                .timeout(Duration.ofSeconds(5))
                .GET().build()
            val resp = http.send(req, HttpResponse.BodyHandlers.ofString())
            if (resp.statusCode() != 200) return
            val key = extractField(resp.body(), "issuer_pubkey") ?: return
            issuerPubkey.set(key)
            Bukkit.getScheduler().runTask(plugin, Runnable {
                tryUpdateBelfrySecond()
                tryUpdateDeskSigns()
            })
        } catch (_: Exception) {
            // Silent; the periodic retry will try again.
        }
    }

    private fun fetchTeeAddress() {
        try {
            val req = HttpRequest.newBuilder()
                .uri(URI.create("$runtimeUrl/api/identity-pin"))
                .timeout(Duration.ofSeconds(5))
                .GET().build()
            val resp = http.send(req, HttpResponse.BodyHandlers.ofString())
            if (resp.statusCode() != 200) return
            val addr = extractField(resp.body(), "tee_address") ?: return
            teeAddress.set(addr)
            Bukkit.getScheduler().runTask(plugin, Runnable {
                tryUpdateDeskSigns()
                tryUpdateLpVaultBackFace()
            })
        } catch (_: Exception) {
            // Silent; the periodic retry will try again.
        }
    }

    private fun tryUpdateDeskSigns() {
        val world = Bukkit.getWorlds().firstOrNull() ?: return
        val addr = teeAddress.get()
        val truncated = if (addr != null) HexUtil.truncate(addr, 6, 4) else "0x????…????"

        // Left sign — VANTA as autonomous credit officer (the role).
        val (lx, ly, lz) = deskLeftSign
        val left = world.getBlockAt(lx, ly, lz).state as? Sign
        if (left != null) {
            val side = left.getSide(Side.FRONT)
            side.line(0, Component.text("VANTA").color(NamedTextColor.GOLD))
            side.line(1, Component.text("autonomous").color(NamedTextColor.WHITE))
            side.line(2, Component.text("credit officer").color(NamedTextColor.WHITE))
            side.line(3, Component.text("no human signs").color(NamedTextColor.GRAY))
            left.update(true, false)
        }

        // Right sign — TEE EOA as the contract owner (the credibility primitive).
        val (rx, ry, rz) = deskRightSign
        val right = world.getBlockAt(rx, ry, rz).state as? Sign
        if (right != null) {
            val side = right.getSide(Side.FRONT)
            side.line(0, Component.text("OWNER").color(NamedTextColor.GOLD))
            side.line(1, Component.text(truncated).color(NamedTextColor.AQUA))
            side.line(2, Component.text("enclave key").color(NamedTextColor.GRAY))
            side.line(3, Component.text("not a human").color(NamedTextColor.DARK_GRAY))
            right.update(true, false)
        }
    }

    private fun tryUpdateLpVaultBackFace() {
        // Bonus: paint the back of the LP-vault sign with a static
        // attribution so visitors approaching from the chest side see
        // "enclave-owned" without us touching the dynamic FRONT face.
        val world = Bukkit.getWorlds().firstOrNull() ?: return
        val addr = teeAddress.get() ?: return
        val (x, y, z) = lpVaultSign
        val state = world.getBlockAt(x, y, z).state as? Sign ?: return
        val truncated = HexUtil.truncate(addr, 6, 4)
        val side = state.getSide(Side.BACK)
        side.line(0, Component.text("ENCLAVE-OWNED").color(NamedTextColor.GOLD))
        side.line(1, Component.text(truncated).color(NamedTextColor.AQUA))
        side.line(2, Component.text("EigenCompute").color(NamedTextColor.GRAY))
        side.line(3, Component.text("not a human").color(NamedTextColor.DARK_GRAY))
        state.update(true, false)
    }

    private fun tryUpdateBelfrySecond() {
        val world = Bukkit.getWorlds().firstOrNull() ?: return
        val (x, y, z) = belfrySecondSign
        val state = world.getBlockAt(x, y, z).state as? Sign ?: return
        val key = issuerPubkey.get()
        val side = state.getSide(Side.FRONT)
        side.line(0, Component.text("SIGNED BY VANTA").color(NamedTextColor.GOLD))
        side.line(
            1,
            Component.text(if (key != null) "ed25…${key.takeLast(4)}" else "ed25…????").color(NamedTextColor.AQUA),
        )
        side.line(2, Component.text("pubkey from").color(NamedTextColor.GRAY))
        side.line(3, Component.text(".well-known/x402").color(NamedTextColor.DARK_GRAY))
        state.update(true, false)
    }

    // -----------------------------------------------------------------
    // Verifier altar ticker
    // -----------------------------------------------------------------

    private fun tickVerifierTicker() {
        val req = HttpRequest.newBuilder()
            .uri(URI.create("$runtimeUrl/api/events?limit=4"))
            .timeout(Duration.ofSeconds(3))
            .GET().build()
        val resp = http.send(req, HttpResponse.BodyHandlers.ofString())
        if (resp.statusCode() != 200) return
        val events = parseEventsArray(resp.body())
        if (events.isEmpty()) return
        Bukkit.getScheduler().runTask(plugin, Runnable {
            val world = Bukkit.getWorlds().firstOrNull() ?: return@Runnable
            verifierTickerSigns.forEachIndexed { idx, (x, y, z) ->
                val ev = events.getOrNull(idx)
                val state = world.getBlockAt(x, y, z).state as? Sign ?: return@forEachIndexed
                val side = state.getSide(Side.FRONT)
                if (ev == null) {
                    side.line(0, Component.text("—").color(NamedTextColor.DARK_GRAY))
                    side.line(1, Component.empty()); side.line(2, Component.empty()); side.line(3, Component.empty())
                } else {
                    val type = extractField(ev, "type") ?: "?"
                    val id = extractField(ev, "id") ?: ""
                    val tsRaw = extractField(ev, "timestamp")?.toLongOrNull()
                    val timeLabel = if (tsRaw != null) timeFmt.format(Instant.ofEpochSecond(tsRaw)) else ""
                    side.line(0, Component.text(type).color(NamedTextColor.GOLD))
                    side.line(1, Component.text(HexUtil.truncate("0x$id", 6, 4)).color(NamedTextColor.AQUA))
                    side.line(2, Component.text("$timeLabel UTC").color(NamedTextColor.GRAY))
                    side.line(3, Component.text("verify in console").color(NamedTextColor.DARK_GRAY))
                }
                state.update(true, false)
            }
        })
    }

    // -----------------------------------------------------------------
    // Tiny helpers — same regex JSON extractor as MarkBelfry / EventStream
    // -----------------------------------------------------------------

    private fun parseEventsArray(json: String): List<String> {
        val arrAt = json.indexOf("\"events\":[")
        if (arrAt < 0) return emptyList()
        val out = mutableListOf<String>()
        var depth = 0
        var start = -1
        var inString = false
        var i = arrAt + 10
        while (i < json.length) {
            val c = json[i]
            if (inString) {
                if (c == '\\' && i + 1 < json.length) { i += 2; continue }
                if (c == '"') inString = false
            } else {
                when (c) {
                    '"' -> inString = true
                    '{' -> { if (depth == 0) start = i; depth += 1 }
                    '}' -> {
                        depth -= 1
                        if (depth == 0 && start >= 0) {
                            out.add(json.substring(start, i + 1))
                            start = -1
                        }
                    }
                    ']' -> if (depth == 0) return out
                }
            }
            i += 1
        }
        return out
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

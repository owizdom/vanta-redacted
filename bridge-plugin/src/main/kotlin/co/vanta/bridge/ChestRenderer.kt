/**
 * VANTA — LP-vault chest renderer (paper §7.2).
 *
 * The wizard's tower has nine chests in a 3×3 wall behind the lectern.
 * Each is filled with gold ingots; the *total weight* is the visible
 * counterpart of `LpVault.totalAssets()` on Base Sepolia (paper says
 * "one ingot per 100 USDC"). When lenders deposit, the chests fill;
 * when borrowers redeem, they empty. From the visitor's POV the agent's
 * balance sheet is *physically present* in the world.
 *
 * This renderer polls the runtime's /api/state every 30s and sets the
 * contents of each chest to a number of gold ingots derived from
 * `treasury_balance_usdc` (decimal string, 6-decimal USDC wei) at
 * 1 ingot per 100 USDC. All inventory mutation runs on the main thread
 * (Bukkit inventories are not thread-safe); the HTTP fetch runs async.
 *
 * Chest order — from the wizard's POV, looking south:
 *
 *   row top  (y=baseY+3):  x=-1   x=0   x=1
 *   row mid  (y=baseY+2):  x=-1   x=0   x=1
 *   row bot  (y=baseY+1):  x=-1   x=0   x=1
 *
 * Bottom row fills first (eye-level for someone walking up to the desk),
 * then middle, then top. Within a row, left → centre → right.
 */
package co.vanta.bridge

import org.bukkit.Bukkit
import org.bukkit.Material
import org.bukkit.block.Chest
import org.bukkit.inventory.ItemStack
import org.bukkit.plugin.java.JavaPlugin
import org.bukkit.scheduler.BukkitTask
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

class ChestRenderer(private val plugin: JavaPlugin) {

    private val http = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(3))
        .build()

    private val runtimeUrl = System.getenv("VANTA_RUNTIME_URL") ?: "http://runtime:8787"

    /** Coordinates for the 9 LP-vault chests in fill order. Must
     *  agree with WorldBuilder.kt's chest placement (z=-2, x=-1..1,
     *  y=baseY+1..baseY+3 where baseY=64). */
    private val chestCoords: List<Triple<Int, Int, Int>> = run {
        val coords = mutableListOf<Triple<Int, Int, Int>>()
        for (y in 65..67) {
            for (x in -1..1) {
                coords.add(Triple(x, y, -2))
            }
        }
        coords
    }

    private val maxIngotsPerChest = 27 * 64        // 1728 per chest
    private val maxTotalIngots = chestCoords.size * maxIngotsPerChest

    private var task: BukkitTask? = null
    /** Last total we rendered. Skip the inventory mutation when nothing
     *  changed — the SetSlot packets are cheap individually but the
     *  full chest re-fill on every tick is wasteful. */
    private var lastRenderedTotal = -1

    fun start() {
        // Initial 5s grace so paper finishes loading + WorldBuilder
        // places the chests before we try to fill them; then 30s tick.
        task = Bukkit.getScheduler().runTaskTimerAsynchronously(plugin, Runnable {
            try {
                tick()
            } catch (e: Exception) {
                plugin.logger.warning("vanta-chests: tick failed: ${e.message}")
            }
        }, 100L, 600L)
        plugin.logger.info("vanta-chests: ChestRenderer started, 30s cadence (max=$maxTotalIngots ingots)")
    }

    fun stop() {
        task?.cancel()
        task = null
    }

    private fun tick() {
        val req = HttpRequest.newBuilder()
            .uri(URI.create("$runtimeUrl/api/state"))
            .timeout(Duration.ofSeconds(3))
            .GET()
            .build()
        val resp = http.send(req, HttpResponse.BodyHandlers.ofString())
        if (resp.statusCode() != 200) return

        // /api/state.treasury_balance_usdc is a decimal string in USDC
        // wei (6 decimals). 1 ingot = 100 USDC = 100_000_000 wei.
        val balanceRaw = extractField(resp.body(), "treasury_balance_usdc") ?: "0"
        val balanceWei = balanceRaw.toLongOrNull() ?: return
        val total = (balanceWei / 100_000_000L)
            .toInt()
            .coerceIn(0, maxTotalIngots)
        if (total == lastRenderedTotal) return
        lastRenderedTotal = total

        // Inventory mutation has to run on the main thread.
        Bukkit.getScheduler().runTask(plugin, Runnable {
            applyTotal(total)
        })
    }

    private fun applyTotal(total: Int) {
        val world = Bukkit.getWorlds().firstOrNull() ?: return
        var remaining = total
        for ((x, y, z) in chestCoords) {
            val block = world.getBlockAt(x, y, z)
            if (block.type != Material.CHEST) continue
            val state = block.state as? Chest ?: continue
            val take = remaining.coerceAtMost(maxIngotsPerChest)
            remaining -= take
            fillChestInventory(state, take)
        }
        plugin.logger.info("vanta-chests: rendered $total ingots across ${chestCoords.size} chests")
    }

    private fun fillChestInventory(state: Chest, ingots: Int) {
        val inv = state.inventory
        inv.clear()
        var left = ingots
        var slot = 0
        while (left > 0 && slot < inv.size) {
            val stack = left.coerceAtMost(64)
            inv.setItem(slot, ItemStack(Material.GOLD_INGOT, stack))
            left -= stack
            slot += 1
        }
        state.update(true, false)
    }

    /** Same shape as WizardPin's tiny extractor — top-level int field. */
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

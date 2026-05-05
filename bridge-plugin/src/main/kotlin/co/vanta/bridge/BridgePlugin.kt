/**
 * VANTA Minecraft bridge plugin — entry point.
 *
 * §1.1 scaffold: prove the Paper → plugin → runtime pipeline by
 * loading cleanly + exposing one diagnostic command. Chat commands,
 * SSE animation consumer, and rate limiting land in §1.1 follow-ups.
 *
 * All future plugin → runtime traffic is *outbound*; runtime never
 * reaches into the server (paper §1.1 invariant).
 */
package co.vanta.bridge

import org.bukkit.Bukkit
import org.bukkit.command.Command
import org.bukkit.command.CommandSender
import org.bukkit.plugin.java.JavaPlugin

class BridgePlugin : JavaPlugin() {
    override fun onEnable() {
        val runtimeUrl = System.getenv("VANTA_RUNTIME_URL") ?: "http://runtime:8787"
        logger.info("vanta-bridge enabled. runtime=$runtimeUrl")

        // §1.2 — place the VANTA structures into the world if they
        // aren't there yet. Idempotent via a persistent-data flag on
        // the world so we don't re-clear / re-place on every reload.
        val builder = WorldBuilder(this)
        for (world in Bukkit.getWorlds()) {
            try {
                builder.placeIfNeeded(world)
            } catch (e: Exception) {
                logger.warning("vanta-world: build failed in '${world.name}': ${e.message}")
            }
        }

        // Special-account hardening: the Wizard NPC walks through soul-
        // campfires at the tower doorway and was repeatedly dying;
        // make him invulnerable so his autonomous walk loop actually
        // gets him places.
        server.pluginManager.registerEvents(PlayerListener(this), this)

        // v0.1 slice set — see vanta-watchable plan. Slices that target
        // v1-only runtime endpoints (ChatBridge → /bridge/{quote,pledge,…},
        // OpenTowers → /open/town/state, BotInspect → bot reveal endpoints,
        // MarkBelfry → /bridge/mark/tick) are disabled here so the v0.1
        // stack boots clean against v2's `/api/*` + `/bridge/wizard/*` +
        // `/bridge/town/*` surface. v0.2+ adapts each one back on.

        // Live runtime event stream → in-world animations. Every signed
        // event the runtime appends now produces a visible reaction.
        eventStream = EventStream(this)
        eventStream?.start()

        // Wizard desk pin — keeps the Wizard NPC anchored to his desk
        // when in at_desk mode. Polls `/bridge/wizard/mode` (v0.1's
        // bridge.ts route) and teleports if drifted.
        wizardPin = WizardPin(this)
        wizardPin?.start()

        // LP-vault chest renderer — paints treasury balance onto the 3×3
        // chest wall behind the wizard. v0.1 reads `/api/state` directly
        // (1 ingot per 100 USDC of `treasury_balance_usdc`).
        chestRenderer = ChestRenderer(this)
        chestRenderer?.start()

        // On-chain receipt plaques. /api/events?limit=4 → wood signs.
        // Already 1:1 against v2's events route (no adapter needed).
        receiptPlaques = ReceiptPlaques(this, eventStream!!)
        receiptPlaques?.start()
    }

    private var eventStream: EventStream? = null
    private var wizardPin: WizardPin? = null
    private var chestRenderer: ChestRenderer? = null
    private var receiptPlaques: ReceiptPlaques? = null

    override fun onDisable() {
        eventStream?.stop()
        wizardPin?.stop()
        chestRenderer?.stop()
        receiptPlaques?.stop()
        logger.info("vanta-bridge disabled.")
    }

    override fun onCommand(
        sender: CommandSender,
        command: Command,
        label: String,
        args: Array<out String>,
    ): Boolean {
        if (command.name != "vanta") return false
        sender.sendMessage("vanta-bridge v${pluginMeta.version} — runtime=${System.getenv("VANTA_RUNTIME_URL") ?: "http://runtime:8787"}")
        return true
    }
}

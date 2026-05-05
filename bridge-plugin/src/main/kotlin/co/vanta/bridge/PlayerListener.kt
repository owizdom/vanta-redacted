/**
 * VANTA — Player join listener.
 *
 * Hardens NPC accounts (no-die mode) so soul-campfires, zombies,
 * skeletons, fall damage, drowning, void, etc. can't take them out.
 * Only NPC accounts get hardened; real human players (joining via
 * a Java client) stay fully vulnerable.
 *
 * The NPC username set is read from the env var VANTA_NPC_USERNAMES
 * (comma-separated). Defaults to the full Month-2 roster.
 *
 * Hardening is applied 1s after join via the BukkitScheduler so it
 * lands AFTER paper's own spawn-protection logic.
 */
package co.vanta.bridge

import net.kyori.adventure.text.format.NamedTextColor
import org.bukkit.Bukkit
import org.bukkit.Color
import org.bukkit.Location
import org.bukkit.Material
import org.bukkit.entity.Player
import org.bukkit.event.EventHandler
import org.bukkit.event.Listener
import org.bukkit.event.player.PlayerJoinEvent
import org.bukkit.inventory.ItemStack
import org.bukkit.inventory.meta.LeatherArmorMeta
import org.bukkit.plugin.java.JavaPlugin
import org.bukkit.potion.PotionEffect
import org.bukkit.potion.PotionEffectType
import org.bukkit.scoreboard.Team

class PlayerListener(private val plugin: JavaPlugin) : Listener {

    // Per-NPC nameplate colors (paper §7.1 + /plan). Reads "Alice"
    // as a whale (purple), Eve as adversary (red), etc.
    private val npcColors: Map<String, NamedTextColor> = mapOf(
        "vanta"        to NamedTextColor.LIGHT_PURPLE,
        "Alice"        to NamedTextColor.DARK_PURPLE,
        "Bob"          to NamedTextColor.GRAY,
        "Eve"          to NamedTextColor.RED,
        "Cynthia"      to NamedTextColor.GREEN,
        "Daniel"       to NamedTextColor.YELLOW,
        "TourGuide"    to NamedTextColor.WHITE,
        "Cartographer" to NamedTextColor.GOLD,
        "CameraBot"    to NamedTextColor.DARK_GRAY,
    )

    private val npcUsernames: Set<String> = run {
        val raw = System.getenv("VANTA_NPC_USERNAMES")
            ?: npcColors.keys.joinToString(",")
        raw.split(",")
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .toSet()
    }

    // Town gate — every joining player (NPCs except Wizard, plus any
    // human visitor) lands here. SE corner of the plaza, near the
    // perimeter ring; the arch frames a diagonal NW view of the desk.
    // Visitors walk diagonally across the plaza into town. Wizard is
    // special-cased to spawn behind the lectern (handled below).
    private val spawnX = 52.5
    private val spawnY = 65.0
    private val spawnZ = 52.5
    private val spawnYaw = 135f   // 135 = facing NW (toward world centre)
    private val spawnPitch = 0f

    init {
        plugin.logger.info("vanta-bridge: NPC roster (will be hardened on join): $npcUsernames")
        // Pre-create scoreboard teams so colored nameplates light up
        // the first time each NPC joins.
        val sb = Bukkit.getScoreboardManager()?.mainScoreboard
        if (sb != null) {
            for ((name, color) in npcColors) {
                val teamName = "vanta-${name.lowercase()}"
                val team = sb.getTeam(teamName) ?: sb.registerNewTeam(teamName)
                team.color(color)
                // Visible-by-default; we only override the color
                team.setOption(Team.Option.NAME_TAG_VISIBILITY, Team.OptionStatus.ALWAYS)
            }
            plugin.logger.info("vanta-bridge: registered ${npcColors.size} colored nameplate teams")
        }
        // Set the world spawn so human visitors also land at the gate.
        for (world in Bukkit.getWorlds()) {
            try {
                world.setSpawnLocation(spawnX.toInt(), spawnY.toInt(), spawnZ.toInt())
            } catch (e: Exception) {
                plugin.logger.warning("vanta-bridge: setSpawnLocation '${world.name}' failed: ${e.message}")
            }
        }
    }

    @EventHandler
    fun onJoin(event: PlayerJoinEvent) {
        val player = event.player
        if (player.name !in npcUsernames) return

        // Add to colored-nameplate team immediately (no scheduler delay
        // so the colored tag is visible on the very first frame).
        try {
            val sb = Bukkit.getScoreboardManager()?.mainScoreboard
            val teamName = "vanta-${player.name.lowercase()}"
            val team = sb?.getTeam(teamName)
            if (team != null && !team.hasEntry(player.name)) {
                team.addEntry(player.name)
            }
        } catch (e: Exception) {
            plugin.logger.warning("vanta-bridge: nameplate team for ${player.name} failed: ${e.message}")
        }

        Bukkit.getScheduler().runTaskLater(plugin, Runnable {
            if (!player.isOnline) return@Runnable
            try {
                player.isInvulnerable = true
                player.foodLevel = 20
                player.saturation = 20f
                player.health = player.maxHealth
                player.fireTicks = 0
                player.addPotionEffect(
                    PotionEffect(
                        PotionEffectType.FIRE_RESISTANCE,
                        PotionEffect.INFINITE_DURATION,
                        0,
                        false,
                        false,
                        false,
                    )
                )
                player.addPotionEffect(
                    PotionEffect(
                        PotionEffectType.REGENERATION,
                        PotionEffect.INFINITE_DURATION,
                        1,
                        false,
                        false,
                        false,
                    )
                )
                plugin.logger.info("vanta-bridge: ${player.name} hardened — invulnerable, fire-resist, regen")
                dressNpc(player)
                // Make the NPC glow in their team color. prismarine-viewer
                // renders the entity outline, and the team color picks up
                // automatically — so each NPC is visually distinct in the
                // browser from any distance, even though prismarine-viewer
                // can't render their leather armor or held items. Real Java
                // clients see both glow + outfit.
                player.isGlowing = true
                // The Wizard's home is on the dais behind the lectern.
                // Mineflayer's forward-press walk-up doesn't reliably
                // climb the andesite stairs onto the platform, so the
                // wizard kept ending up STUCK at plaza level beside the
                // desk. Teleport him exactly into position here, on the
                // server side, where the world has authority.
                if (player.name == "vanta") {
                    val world = player.world
                    // Lectern is at (0, 65, 0); wizard stands behind it
                    // at (0, 65, -1). yaw=0 = facing south = visitors.
                    val desk = Location(world, 0.5, 65.0, -0.5, 0f, 0f)
                    player.teleport(desk)
                } else if (player.name == "CameraBot") {
                    // SE-corner ground vantage on the plaza, facing NW
                    // toward the tower complex (centered at 0,65,0;
                    // landmarks span x:[-25..25], z:[-40..35]). Plaza
                    // floor is y=64, so feet at y=64 = standing.
                    val world = player.world
                    val cam = Location(world, 50.5, 64.0, 50.5, 135f, 0f)
                    player.teleport(cam)
                } else {
                    // Every other NPC (and any later human visitor)
                    // arrives at the southern town gate. The bot loop
                    // then walks them to their home zone, so visitors
                    // see the population *moving in* rather than
                    // teleporting to scattered points.
                    val world = player.world
                    val gate = Location(world, spawnX, spawnY, spawnZ, spawnYaw, spawnPitch)
                    player.teleport(gate)
                }
            } catch (e: Exception) {
                plugin.logger.warning("vanta-bridge: harden ${player.name} failed: ${e.message}")
            }
        }, 20L)
    }

    // -----------------------------------------------------------------
    // Outfits — paper §7.1 archetypes made visually distinct via dyed
    // leather armor + role-specific helmets + handheld props. Same
    // body underneath, very different silhouette.
    // -----------------------------------------------------------------

    private fun leather(material: Material, rgb: Int): ItemStack {
        val item = ItemStack(material)
        val meta = item.itemMeta as LeatherArmorMeta
        meta.setColor(Color.fromRGB(rgb))
        meta.isUnbreakable = true
        item.itemMeta = meta
        return item
    }

    private fun unbreakable(material: Material): ItemStack {
        val item = ItemStack(material)
        val meta = item.itemMeta
        if (meta != null) {
            meta.isUnbreakable = true
            item.itemMeta = meta
        }
        return item
    }

    private fun dressNpc(player: Player) {
        val inv = player.inventory
        // Common: clear any drift first
        inv.clear()
        when (player.name) {
            "vanta" -> {
                inv.helmet      = unbreakable(Material.TURTLE_HELMET)
                inv.chestplate  = leather(Material.LEATHER_CHESTPLATE, 0xB464DC)  // light purple
                inv.leggings    = leather(Material.LEATHER_LEGGINGS,   0xB464DC)
                inv.boots       = leather(Material.LEATHER_BOOTS,      0xB464DC)
                inv.setItemInMainHand(unbreakable(Material.ENCHANTED_BOOK))
            }
            "Alice" -> {
                // Whale — flashy: golden helmet + dark purple body
                inv.helmet      = unbreakable(Material.GOLDEN_HELMET)
                inv.chestplate  = leather(Material.LEATHER_CHESTPLATE, 0x6E1ED2)  // dark purple
                inv.leggings    = leather(Material.LEATHER_LEGGINGS,   0x6E1ED2)
                inv.boots       = leather(Material.LEATHER_BOOTS,      0x6E1ED2)
                inv.setItemInMainHand(ItemStack(Material.GOLD_INGOT))
            }
            "Bob" -> {
                // Hedger — defensive: shield offhand
                inv.helmet      = leather(Material.LEATHER_HELMET,     0x9A9A9A)
                inv.chestplate  = leather(Material.LEATHER_CHESTPLATE, 0x9A9A9A)
                inv.leggings    = leather(Material.LEATHER_LEGGINGS,   0x9A9A9A)
                inv.boots       = leather(Material.LEATHER_BOOTS,      0x9A9A9A)
                inv.setItemInOffHand(unbreakable(Material.SHIELD))
            }
            "Eve" -> {
                // Adversary — combat: iron helm + red body + sword
                inv.helmet      = unbreakable(Material.IRON_HELMET)
                inv.chestplate  = leather(Material.LEATHER_CHESTPLATE, 0xC53A3A)  // red
                inv.leggings    = leather(Material.LEATHER_LEGGINGS,   0xC53A3A)
                inv.boots       = leather(Material.LEATHER_BOOTS,      0xC53A3A)
                inv.setItemInMainHand(unbreakable(Material.IRON_SWORD))
            }
            "Cynthia" -> {
                // Curator — scholar: full green + book
                inv.helmet      = leather(Material.LEATHER_HELMET,     0x4FAE5A)
                inv.chestplate  = leather(Material.LEATHER_CHESTPLATE, 0x4FAE5A)
                inv.leggings    = leather(Material.LEATHER_LEGGINGS,   0x4FAE5A)
                inv.boots       = leather(Material.LEATHER_BOOTS,      0x4FAE5A)
                inv.setItemInMainHand(ItemStack(Material.WRITTEN_BOOK))
            }
            "Daniel" -> {
                // Retail — a coin in hand
                inv.helmet      = leather(Material.LEATHER_HELMET,     0xE8D04C)  // yellow
                inv.chestplate  = leather(Material.LEATHER_CHESTPLATE, 0xE8D04C)
                inv.leggings    = leather(Material.LEATHER_LEGGINGS,   0xE8D04C)
                inv.boots       = leather(Material.LEATHER_BOOTS,      0xE8D04C)
                inv.setItemInMainHand(ItemStack(Material.EMERALD))
            }
            "TourGuide" -> {
                inv.helmet      = leather(Material.LEATHER_HELMET,     0xF5F5F5)  // white
                inv.chestplate  = leather(Material.LEATHER_CHESTPLATE, 0xF5F5F5)
                inv.leggings    = leather(Material.LEATHER_LEGGINGS,   0xF5F5F5)
                inv.boots       = leather(Material.LEATHER_BOOTS,      0xF5F5F5)
                inv.setItemInMainHand(ItemStack(Material.LANTERN))
            }
            "Cartographer" -> {
                inv.helmet      = leather(Material.LEATHER_HELMET,     0xE07A2A)  // orange
                inv.chestplate  = leather(Material.LEATHER_CHESTPLATE, 0xE07A2A)
                inv.leggings    = leather(Material.LEATHER_LEGGINGS,   0xE07A2A)
                inv.boots       = leather(Material.LEATHER_BOOTS,      0xE07A2A)
                inv.setItemInMainHand(ItemStack(Material.FILLED_MAP))
            }
            "CameraBot" -> {
                // Camera bot stays plain — he's the audience's vessel,
                // shouldn't compete visually with the inhabitants.
            }
        }
    }
}

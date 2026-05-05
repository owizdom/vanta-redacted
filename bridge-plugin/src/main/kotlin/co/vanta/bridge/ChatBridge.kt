/**
 * VANTA — in-game chat command bridge (Slice 2 of /plan).
 *
 * Listens to AsyncChatEvent. If a player message starts with "/<cmd>"
 * and the command is one of the bridge surface (quote / pledge /
 * verify / tour / register-agent), parse args, POST to the runtime,
 * deliver the response back into the chat — and optionally as a
 * speech-bubble line from the wizard so it reads in-character.
 *
 * Per-player rate-limit (paper §11.1 anti-grief).
 *
 * Cancels the original chat broadcast for `/...` commands so it
 * doesn't render as the player typing in chat.
 */
package co.vanta.bridge

import io.papermc.paper.event.player.AsyncChatEvent
import net.kyori.adventure.text.Component
import net.kyori.adventure.text.format.NamedTextColor
import org.bukkit.Bukkit
import org.bukkit.entity.Player
import org.bukkit.event.EventHandler
import org.bukkit.event.EventPriority
import org.bukkit.event.Listener
import org.bukkit.plugin.java.JavaPlugin
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class ChatBridge(private val plugin: JavaPlugin) : Listener {

    private val http = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        .build()

    private val runtimeUrl = System.getenv("VANTA_RUNTIME_URL") ?: "http://runtime:8787"

    // Per-player rate-limiting: 8 cmds per 10s window, paper §11.1.
    private data class Window(val started: Long, var count: Int)
    private val windows = ConcurrentHashMap<UUID, Window>()
    private val WINDOW_MS = 10_000L
    private val WINDOW_MAX = 8

    private val SUPPORTED = setOf("quote", "pledge", "verify", "tour", "register-agent")

    @EventHandler(priority = EventPriority.HIGH, ignoreCancelled = true)
    fun onChat(event: AsyncChatEvent) {
        val player = event.player
        val raw = plainText(event.message()).trim()
        if (!raw.startsWith("/")) return

        val parts = raw.removePrefix("/").split(Regex("\\s+"))
        if (parts.isEmpty()) return
        val cmd = parts[0].lowercase()
        if (cmd !in SUPPORTED) return

        // Eat the original broadcast — chat shouldn't show "/quote 0xab…"
        // as the player's literal message; we'll inject a clean line.
        event.isCancelled = true

        if (!checkRate(player.uniqueId)) {
            sendSystem(player, "(rate limited — slow down for a few seconds)")
            return
        }

        val args = parts.drop(1)
        val payload = buildPayload(cmd, args, player.name)
        if (payload == null) {
            sendSystem(player, usageFor(cmd))
            return
        }

        // Echo the player's request as a styled line so observers see
        // who asked what; runtime call happens off-thread.
        val asked = Component.text("[$cmd] ").color(NamedTextColor.AQUA)
            .append(Component.text(args.joinToString(" ")).color(NamedTextColor.WHITE))
        Bukkit.getServer().broadcast(
            Component.text("<${player.name}> ").color(NamedTextColor.GRAY).append(asked)
        )

        Bukkit.getScheduler().runTaskAsynchronously(plugin, Runnable {
            try {
                val resp = postBridge(cmd, payload)
                val text = extractField(resp, "response_text") ?: "(no response)"
                Bukkit.getScheduler().runTask(plugin, Runnable {
                    val wizard = Bukkit.getPlayerExact("vanta")
                    val line = Component.text("the wizard: ").color(NamedTextColor.LIGHT_PURPLE)
                        .append(Component.text(text).color(NamedTextColor.WHITE))
                    Bukkit.getServer().broadcast(line)
                    if (wizard != null && wizard.isOnline) {
                        // Have the wizard "say" it via the runtime's
                        // log voice as well — the chat panel at :8081
                        // will render this as <vanta> ...
                        try {
                            wizard.chat(text)
                        } catch (_: Exception) { /* fine */ }
                    }
                })
            } catch (e: Exception) {
                Bukkit.getScheduler().runTask(plugin, Runnable {
                    sendSystem(player, "(runtime error: ${e.message?.take(80)})")
                })
            }
        })
    }

    private fun buildPayload(cmd: String, args: List<String>, playerName: String): String? {
        return when (cmd) {
            "quote" -> {
                if (args.isEmpty()) return null
                val cid = args[0]
                if (!cid.matches(Regex("^0x[0-9a-fA-F]{64}$"))) return null
                """{"conditionId":"$cid","playerHandle":${jq(playerName)}}"""
            }
            "pledge" -> {
                if (args.size < 2) return null
                val cid = args[0]
                val amt = args[1]
                if (!cid.matches(Regex("^0x[0-9a-fA-F]{64}$"))) return null
                if (!amt.matches(Regex("^\\d+$"))) return null
                """{"conditionId":"$cid","amount":"$amt","playerHandle":${jq(playerName)}}"""
            }
            "verify" -> {
                if (args.isEmpty()) return null
                val ev = args[0]
                if (!ev.matches(Regex("^[0-9a-fA-F]{64}$"))) return null
                """{"eventId":"$ev","playerHandle":${jq(playerName)}}"""
            }
            "tour" -> {
                """{"playerHandle":${jq(playerName)}}"""
            }
            "register-agent" -> {
                if (args.isEmpty()) return null
                val handle = args[0]
                if (!handle.matches(Regex("^[A-Za-z0-9_-]{1,32}$"))) return null
                """{"handle":"$handle","playerHandle":${jq(playerName)}}"""
            }
            else -> null
        }
    }

    private fun usageFor(cmd: String): String = when (cmd) {
        "quote"           -> "usage: /quote <0x…64-hex conditionId>"
        "pledge"          -> "usage: /pledge <0x…64-hex conditionId> <amount-usdc-6dec>"
        "verify"          -> "usage: /verify <64-hex eventId>"
        "tour"            -> "usage: /tour"
        "register-agent"  -> "usage: /register-agent <handle>"
        else              -> "unknown command"
    }

    private fun postBridge(cmd: String, jsonBody: String): String {
        val req = HttpRequest.newBuilder()
            .uri(URI.create("$runtimeUrl/bridge/$cmd"))
            .timeout(Duration.ofSeconds(15))
            .header("content-type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(jsonBody))
            .build()
        val resp = http.send(req, HttpResponse.BodyHandlers.ofString())
        if (resp.statusCode() != 200) {
            throw RuntimeException("runtime ${resp.statusCode()}: ${resp.body().take(120)}")
        }
        return resp.body()
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

    private fun sendSystem(player: Player, msg: String) {
        player.sendMessage(Component.text(msg).color(NamedTextColor.GRAY))
    }

    private fun plainText(component: Component): String {
        return net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer.plainText().serialize(component)
    }

    private fun jq(s: String): String = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    private fun extractField(json: String, key: String): String? {
        val pattern = "\"$key\":".toRegex()
        val match = pattern.find(json) ?: return null
        var i = match.range.last + 1
        while (i < json.length && json[i].isWhitespace()) i++
        if (i >= json.length) return null
        return if (json[i] == '"') {
            // string — handle escape sequences
            val sb = StringBuilder()
            var j = i + 1
            while (j < json.length) {
                val c = json[j]
                if (c == '\\' && j + 1 < json.length) {
                    val esc = json[j + 1]
                    when (esc) {
                        '"' -> sb.append('"')
                        'n' -> sb.append('\n')
                        't' -> sb.append('\t')
                        '\\' -> sb.append('\\')
                        '/' -> sb.append('/')
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
        } else {
            var end = i
            while (end < json.length && json[end] != ',' && json[end] != '}' && !json[end].isWhitespace()) end++
            json.substring(i, end)
        }
    }
}

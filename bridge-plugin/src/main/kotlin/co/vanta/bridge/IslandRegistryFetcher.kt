/**
 * Synchronous HTTP fetch of the runtime's `/api/agents` endpoint.
 *
 * Called from BridgePlugin.onEnable so the world builder has the
 * registered VANTA list before placing islands. Plugin enable is on
 * the main thread; we use a 3s connect timeout + 3s request timeout
 * so a missing runtime degrades to "no islands placed" rather than
 * hanging server boot.
 *
 * The JSON parser here is a tiny hand-rolled extractor: the agents
 * payload is a flat array of objects with `agent_id` (int), `name`
 * (string), and `color_rgb` (int). Pulling in Jackson / Gson would
 * pull in a 6MB dep into a plugin JAR that ideally stays under 1MB.
 */
package co.vanta.bridge

import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

class IslandRegistryFetcher(private val runtimeUrl: String) {

    private val http: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(3))
        .build()

    fun fetch(): List<IslandAgent> {
        val req = HttpRequest.newBuilder()
            .uri(URI.create("$runtimeUrl/api/agents"))
            .timeout(Duration.ofSeconds(3))
            .GET()
            .build()
        val resp = http.send(req, HttpResponse.BodyHandlers.ofString())
        if (resp.statusCode() != 200) return emptyList()
        return parseAgents(resp.body())
    }

    /** Extract `agents: [{agent_id, name, color_rgb, paused}, …]`. */
    internal fun parseAgents(json: String): List<IslandAgent> {
        val out = mutableListOf<IslandAgent>()
        // Find every `{...}` object — we don't need a real JSON parser
        // because the shape is flat. We DO need to handle string
        // escaping (the thesis field can contain `}` characters), but
        // we only extract three primitive fields and skip strings
        // unless they're our `name` value.
        var i = json.indexOf("\"agents\"")
        if (i < 0) return out
        i = json.indexOf('[', i)
        if (i < 0) return out
        var depth = 0
        var objStart = -1
        while (i < json.length) {
            val c = json[i]
            when (c) {
                '"' -> {
                    // skip string
                    i = skipString(json, i)
                    continue
                }
                '{' -> {
                    if (depth == 0) objStart = i
                    depth++
                }
                '}' -> {
                    depth--
                    if (depth == 0 && objStart >= 0) {
                        val obj = json.substring(objStart, i + 1)
                        val a = parseOne(obj)
                        if (a != null) out.add(a)
                        objStart = -1
                    }
                }
                ']' -> if (depth == 0) return out
            }
            i++
        }
        return out
    }

    private fun parseOne(obj: String): IslandAgent? {
        val agentId = extractInt(obj, "agent_id") ?: return null
        val name = extractString(obj, "name") ?: return null
        val color = extractInt(obj, "color_rgb") ?: 0xFFFFFF
        val paused = extractBool(obj, "paused") ?: false
        if (paused) return null
        return IslandAgent(agentId = agentId, name = name, colorRgb = color)
    }

    private fun extractInt(obj: String, key: String): Int? {
        val v = extractRaw(obj, key) ?: return null
        return v.trim().trimEnd(',').toIntOrNull()
    }

    private fun extractBool(obj: String, key: String): Boolean? {
        val v = extractRaw(obj, key) ?: return null
        return when (v.trim().trimEnd(',')) {
            "true" -> true
            "false" -> false
            else -> null
        }
    }

    private fun extractString(obj: String, key: String): String? {
        val pat = "\"$key\"\\s*:\\s*\"".toRegex()
        val match = pat.find(obj) ?: return null
        var i = match.range.last + 1
        val sb = StringBuilder()
        while (i < obj.length) {
            val c = obj[i]
            if (c == '\\' && i + 1 < obj.length) {
                sb.append(obj[i + 1])
                i += 2
                continue
            }
            if (c == '"') return sb.toString()
            sb.append(c)
            i++
        }
        return null
    }

    private fun extractRaw(obj: String, key: String): String? {
        val pat = "\"$key\"\\s*:\\s*".toRegex()
        val match = pat.find(obj) ?: return null
        var i = match.range.last + 1
        val start = i
        while (i < obj.length && obj[i] != ',' && obj[i] != '}' && !obj[i].isWhitespace()) i++
        return obj.substring(start, i)
    }

    private fun skipString(s: String, start: Int): Int {
        // s[start] == '"'; advance past the matching close quote.
        var i = start + 1
        while (i < s.length) {
            if (s[i] == '\\') { i += 2; continue }
            if (s[i] == '"') return i + 1
            i++
        }
        return i
    }
}

package app.vela.mobile.net

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Build
import android.util.Base64
import app.vela.mobile.data.Computer
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException
import java.net.URLDecoder
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

class PairingError(message: String) : Exception(message)

/** What the pairing QR code on the computer carries. */
data class QrPairing(val hosts: List<String>, val port: Int, val fingerprint: String, val secret: String, val name: String)

/** A computer that answered the broadcast, or was typed in. */
data class FoundComputer(val name: String, val host: String, val port: Int, val fingerprint: String)

private fun b64(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.NO_WRAP)
private fun unb64(text: String) = Base64.decode(text, Base64.NO_WRAP)

object Pairing {
    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        // The computer is on this Wi-Fi: never through a proxy the phone may have set.
        .proxy(java.net.Proxy.NO_PROXY)
        .build()
    private val json = "application/json".toMediaType()

    /** http://<ip>:<port>/pair#v=1&h=<ips>&f=<fingerprint>&s=<secret>&n=<name>, or null when it is not one. */
    fun parseQr(text: String): QrPairing? = try {
        val url = java.net.URI(text.trim())
        if (url.scheme != "http" || url.path != "/pair" || url.port <= 0) null
        else {
            val fields = (url.rawFragment ?: "").split("&").mapNotNull { part ->
                val index = part.indexOf('=')
                if (index <= 0) null else part.substring(0, index) to URLDecoder.decode(part.substring(index + 1), "UTF-8")
            }.toMap()
            val hosts = (listOf(url.host) + (fields["h"] ?: "").split(",")).map { it.trim() }.filter { it.isNotEmpty() }.distinct()
            val fingerprint = fields["f"] ?: ""
            val secret = fields["s"] ?: ""
            if (fields["v"] != "1" || !Regex("^[a-f0-9]{32}$").matches(fingerprint) || !Regex("^[a-f0-9]{32}$").matches(secret)) null
            else QrPairing(hosts, url.port, fingerprint, secret, fields["n"] ?: "")
        }
    } catch (_: Exception) { null }

    private suspend fun get(url: String): JSONObject = withContext(Dispatchers.IO) {
        http.newCall(Request.Builder().url(url).build()).execute().use { response ->
            JSONObject(response.body?.string() ?: "{}").also { it.put("_status", response.code) }
        }
    }

    private suspend fun post(url: String, body: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        http.newCall(Request.Builder().url(url).post(body.toString().toRequestBody(json)).build()).execute().use { response ->
            JSONObject(response.body?.string() ?: "{}").also { it.put("_status", response.code) }
        }
    }

    internal data class Hello(val host: String, val name: String, val key: ByteArray, val fingerprint: String)

    private suspend fun hello(host: String, port: Int): Hello {
        val body = get("http://$host:$port/app/hello")
        if (body.optString("app") != "vela-browser") throw PairingError("Not a Vela Browser computer")
        val key = unb64(body.getString("key"))
        return Hello(host, body.optString("name"), key, VelaCrypto.fingerprint(key))
    }

    internal class Keys(val phoneKey: ByteArray, val pairKey: ByteArray, val deviceKey: ByteArray)

    private fun keys(computerKey: ByteArray): Keys {
        val pair = VelaCrypto.newKeyPair()
        val phoneKey = pair.public.encoded
        val shared = VelaCrypto.ecdh(pair.private, VelaCrypto.publicKey(computerKey))
        val info = phoneKey + computerKey
        return Keys(phoneKey, VelaCrypto.hkdf(shared, "vela-pair-v1".utf8(), info), VelaCrypto.hkdf(shared, "vela-device-v1".utf8(), info))
    }

    private fun deviceName(): String = listOf(Build.MANUFACTURER, Build.MODEL).filter { it.isNotBlank() }
        .joinToString(" ") { it.replaceFirstChar(Char::uppercase) }.let { if (it.length > 40) Build.MODEL else it }.ifBlank { "Android" }

    private fun finish(body: JSONObject, keys: Keys, hello: Hello, hosts: List<String>, port: Int): Computer {
        val deviceId = body.getString("deviceId")
        val mac = unb64(body.getString("mac"))
        // The computer proves it made the same key: only the computer that holds its private key can.
        if (!VelaCrypto.same(mac, VelaCrypto.hmac(keys.deviceKey, "paired".utf8(), deviceId.utf8()))) throw PairingError("The computer's answer did not check out")
        return Computer(deviceId, body.optString("name").ifBlank { hello.name }, hosts, port, hello.fingerprint, keys.deviceKey)
    }

    /** Pairs with the scanned code: no PIN, no confirmation on the computer. */
    suspend fun pairWithQr(qr: QrPairing): Computer {
        var lastError: Exception = PairingError("The computer did not answer")
        for (host in qr.hosts) {
            val hello = try { hello(host, qr.port) } catch (error: Exception) { lastError = error; continue }
            // The code was read off the computer's own screen: a different key means someone in between.
            if (hello.fingerprint != qr.fingerprint) throw PairingError("This computer's key does not match the code. Pair again from the computer's screen.")
            val keys = keys(hello.key)
            val body = post("http://$host:${qr.port}/app/pair", JSONObject()
                .put("via", "qr").put("name", deviceName()).put("key", b64(keys.phoneKey))
                .put("proof", b64(VelaCrypto.hmac(keys.pairKey, "pair".utf8(), "qr".utf8(), qr.secret.utf8()))))
            if (body.optInt("_status") != 200 || body.optString("status") != "allowed") throw PairingError(body.optString("error").ifBlank { "Pairing was refused" })
            return finish(body, keys, hello, listOf(host) + qr.hosts.filter { it != host }, qr.port)
        }
        throw lastError
    }

    /** A PIN pairing waits for a yes on the computer; both screens show [code]. */
    class Waiting internal constructor(val code: String, internal val pending: String, internal val keys: Keys, internal val hello: Hello, internal val port: Int)

    suspend fun pairWithPin(host: String, port: Int, pin: String): Waiting {
        val hello = hello(host, port)
        val keys = keys(hello.key)
        val body = post("http://$host:$port/app/pair", JSONObject()
            .put("via", "pin").put("pin", pin).put("name", deviceName()).put("key", b64(keys.phoneKey))
            .put("proof", b64(VelaCrypto.hmac(keys.pairKey, "pair".utf8(), "pin".utf8(), pin.utf8()))))
        when (body.optInt("_status")) {
            202 -> {}
            401 -> throw PairingError("wrong-pin")
            429 -> throw PairingError("too-many")
            else -> throw PairingError(body.optString("error").ifBlank { "Pairing was refused" })
        }
        // Our own digits, from the key we actually received: if someone stood in between, they differ from the computer's.
        return Waiting(VelaCrypto.pairCode(hello.key, keys.phoneKey), body.getString("pending"), keys, hello, port)
    }

    /** Waits up to two minutes for the yes or no on the computer. */
    suspend fun awaitDecision(waiting: Waiting): Computer {
        val until = System.currentTimeMillis() + 125_000
        while (System.currentTimeMillis() < until) {
            delay(1200)
            val body = try { get("http://${waiting.hello.host}:${waiting.port}/app/pair/${waiting.pending}") } catch (_: Exception) { continue }
            when (body.optString("status")) {
                "allowed" -> return finish(body, waiting.keys, waiting.hello, listOf(waiting.hello.host), waiting.port)
                "denied" -> throw PairingError("denied")
                "expired" -> throw PairingError("expired")
            }
        }
        throw PairingError("expired")
    }

    /** Asks the local network who runs Vela Browser with the phone app turned on. */
    suspend fun discover(context: Context, waitMs: Long = 1600): List<FoundComputer> = withContext(Dispatchers.IO) {
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        val lock = wifi?.createMulticastLock("vela-discovery")?.apply { setReferenceCounted(false); acquire() }
        val found = linkedMapOf<String, FoundComputer>()
        try {
            DatagramSocket().use { socket ->
                socket.broadcast = true
                socket.soTimeout = 250
                val message = "VELA?".utf8()
                val targets = mutableSetOf<InetAddress>(InetAddress.getByName("255.255.255.255"))
                NetworkInterface.getNetworkInterfaces()?.toList()?.filter { it.isUp && !it.isLoopback }?.forEach { nif ->
                    nif.interfaceAddresses.filter { it.address is Inet4Address }.mapNotNull { it.broadcast }.forEach { targets += it }
                }
                val until = System.currentTimeMillis() + waitMs
                var nextSend = 0L
                val buffer = ByteArray(2048)
                while (System.currentTimeMillis() < until) {
                    if (System.currentTimeMillis() >= nextSend) {
                        targets.forEach { runCatching { socket.send(DatagramPacket(message, message.size, it, 50481)) } }
                        nextSend = System.currentTimeMillis() + 500
                    }
                    val packet = DatagramPacket(buffer, buffer.size)
                    try { socket.receive(packet) } catch (_: SocketTimeoutException) { continue }
                    runCatching {
                        val body = JSONObject(String(packet.data, 0, packet.length, Charsets.UTF_8))
                        if (body.optString("app") == "vela-browser") {
                            val fingerprint = body.getString("fingerprint")
                            found.putIfAbsent(fingerprint, FoundComputer(body.optString("name"), packet.address.hostAddress ?: "", body.getInt("port"), fingerprint))
                        }
                    }
                }
            }
        } catch (_: Exception) { /* no network */ } finally { lock?.release() }
        found.values.toList()
    }

    /** A typed address: "192.168.1.5" or "192.168.1.5:50480". */
    suspend fun probe(address: String): FoundComputer {
        val trimmed = address.trim().removePrefix("http://").trimEnd('/')
        val host = trimmed.substringBefore(':')
        val port = trimmed.substringAfter(':', "50480").toIntOrNull() ?: 50480
        val hello = try { hello(host, port) } catch (_: Exception) { throw PairingError("unreachable") }
        return FoundComputer(hello.name, host, port, hello.fingerprint)
    }
}

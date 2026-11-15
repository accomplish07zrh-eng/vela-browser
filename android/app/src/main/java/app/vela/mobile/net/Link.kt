package app.vela.mobile.net

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import app.vela.mobile.data.Computer
import java.nio.ByteBuffer
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject

class LinkError(message: String) : Exception(message)

sealed interface LinkStatus {
    data object Connecting : LinkStatus
    data class Ready(val name: String) : LinkStatus
    /** Lost the computer: trying again on its own. */
    data class Lost(val attempt: Int) : LinkStatus
    /** The computer forgot this phone: it has to pair again. */
    data object Unpaired : LinkStatus
    data object Stopped : LinkStatus
}

/** A picture of the browser being used, decoded and ready to draw. */
class Frame(val bitmap: Bitmap, val profileId: String, val targetId: String, val generation: String)

/**
 * The one sealed connection to the paired computer. Calls are answered in order of their ids;
 * pictures of the watched browser arrive as frames, and everything else (workbench news,
 * approvals, finished scripts) as events. It keeps reconnecting until stopped.
 */
class Link(
    val computer: Computer,
    private val scope: CoroutineScope,
    private val onHostAnswered: (String) -> Unit,
) {
    private val client = OkHttpClient.Builder()
        .proxy(java.net.Proxy.NO_PROXY)
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(15, TimeUnit.SECONDS)
        .build()
    private val random = SecureRandom()
    private val _status = MutableStateFlow<LinkStatus>(LinkStatus.Connecting)
    val status: StateFlow<LinkStatus> = _status
    private val _frames = MutableStateFlow<Frame?>(null)
    val frames: StateFlow<Frame?> = _frames
    private val _events = MutableSharedFlow<JSONObject>(extraBufferCapacity = 256)
    val events: SharedFlow<JSONObject> = _events

    private var socket: WebSocket? = null
    @Volatile private var channel: SealedChannel? = null
    private val pending = ConcurrentHashMap<Int, CompletableDeferred<JSONObject>>()
    private val ids = AtomicInteger(0)
    @Volatile private var running = false
    private var attempt = 0
    private var hostIndex = 0
    private var retry: Job? = null
    private var generation = 0

    fun start() {
        if (running) return
        running = true
        attempt = 0
        open()
    }

    fun stop() {
        running = false
        retry?.cancel()
        socket?.close(1000, "bye")
        socket = null
        channel = null
        failPending("Disconnected")
        _status.value = LinkStatus.Stopped
    }

    /** Connect again now (after the network came back, or the app came to the front). */
    fun nudge() {
        if (!running || _status.value is LinkStatus.Ready || _status.value is LinkStatus.Unpaired) return
        retry?.cancel()
        socket?.cancel()
        open()
    }

    private fun failPending(reason: String) {
        pending.values.forEach { it.completeExceptionally(LinkError(reason)) }
        pending.clear()
    }

    private fun open() {
        val host = computer.hosts[hostIndex % computer.hosts.size]
        val mine = ++generation
        _status.value = if (attempt == 0) LinkStatus.Connecting else LinkStatus.Lost(attempt)
        channel = null
        socket = client.newWebSocket(Request.Builder().url("ws://$host:${computer.port}/app/ws").build(), object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (mine != generation) return
                // The only unsealed message: the computer's challenge.
                try {
                    val challenge = JSONObject(text)
                    if (challenge.optString("t") != "challenge") return
                    val serverNonce = Base64.decode(challenge.getString("n"), Base64.NO_WRAP)
                    val clientNonce = ByteArray(32).also { random.nextBytes(it) }
                    val mac = VelaCrypto.hmac(computer.key, "auth".utf8(), serverNonce, clientNonce, computer.deviceId.utf8())
                    channel = SealedChannel.forClient(computer.key, serverNonce, clientNonce)
                    webSocket.send(JSONObject()
                        .put("d", computer.deviceId)
                        .put("n", Base64.encodeToString(clientNonce, Base64.NO_WRAP))
                        .put("mac", Base64.encodeToString(mac, Base64.NO_WRAP)).toString())
                } catch (_: Exception) { webSocket.cancel() }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (mine != generation) return
                val plain = channel?.open(bytes.toByteArray()) ?: run { webSocket.close(4400, "bad message"); return }
                if (plain.isEmpty()) return
                if (plain[0].toInt() == 1) { frame(plain); return }
                val message = try { JSONObject(String(plain, 1, plain.size - 1, Charsets.UTF_8)) } catch (_: Exception) { return }
                when (message.optString("t")) {
                    "ready" -> {
                        attempt = 0
                        _status.value = LinkStatus.Ready(message.optString("name").ifBlank { computer.name })
                        onHostAnswered(host)
                    }
                    "res" -> pending.remove(message.optInt("id"))?.complete(message)
                    else -> _events.tryEmit(message)
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { if (mine == generation) lost(code) }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { if (mine == generation) lost(-1) }
        })
    }

    // Pictures are decoded away from the socket's thread, newest only: answers to calls never wait behind them.
    private val pictures = kotlinx.coroutines.channels.Channel<ByteArray>(kotlinx.coroutines.channels.Channel.CONFLATED)
    init { scope.launch(kotlinx.coroutines.Dispatchers.Default) { for (plain in pictures) decode(plain) } }

    private fun frame(plain: ByteArray) { pictures.trySend(plain) }

    private fun decode(plain: ByteArray) {
        try {
            val size = ByteBuffer.wrap(plain, 1, 2).short.toInt() and 0xffff
            val header = JSONObject(String(plain, 3, size, Charsets.UTF_8))
            val start = 3 + size
            val bitmap = BitmapFactory.decodeByteArray(plain, start, plain.size - start) ?: return
            _frames.value = Frame(bitmap, header.optString("profileId"), header.optString("targetId"), header.optString("generation"))
        } catch (_: Exception) { /* a broken picture is skipped */ }
    }

    private fun lost(code: Int) {
        channel = null
        socket = null
        failPending("Disconnected")
        if (!running) return
        if (code == 4401) { running = false; _status.value = LinkStatus.Unpaired; return }
        attempt++
        hostIndex++
        _status.value = LinkStatus.Lost(attempt)
        retry?.cancel()
        retry = scope.launch {
            delay(minOf(8_000L, 600L * attempt))
            if (running) open()
        }
    }

    private fun send(message: JSONObject): Boolean {
        val sealed = channel ?: return false
        return socket?.send(sealed.seal(byteArrayOf(0) + message.toString().utf8()).toByteString()) ?: false
    }

    /** A request to the computer; returns its answer's data, or throws with its error. */
    suspend fun call(method: String, params: JSONObject = JSONObject(), timeoutMs: Long = 30_000): Any? {
        val id = ids.incrementAndGet()
        val answer = CompletableDeferred<JSONObject>()
        pending[id] = answer
        if (!send(JSONObject().put("t", "call").put("id", id).put("m", method).put("p", params))) {
            pending.remove(id)
            throw LinkError("Not connected")
        }
        val response = try { withTimeout(timeoutMs) { answer.await() } } finally { pending.remove(id) }
        if (!response.optBoolean("ok")) throw LinkError(response.optString("error").ifBlank { "Failed" })
        return response.opt("data")
    }

    /** A message for the browser being used (input, tabs, visibility). */
    fun workbench(message: JSONObject) { send(JSONObject().put("t", "wb").put("msg", message)) }

    fun clearFrame() { _frames.value = null }
}

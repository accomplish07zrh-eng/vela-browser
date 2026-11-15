package app.vela.mobile

import app.vela.mobile.data.Computer
import app.vela.mobile.data.ComputerStore
import app.vela.mobile.net.Link
import app.vela.mobile.net.LinkStatus
import java.util.Locale
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/** Chinese where the phone speaks it, English elsewhere. */
fun tr(zh: String, en: String): String = if (Locale.getDefault().language == "zh") zh else en

data class Profile(val id: String, val name: String, val group: String, val running: Boolean, val engine: String)
data class ScriptProgress(val name: String, val status: String, val total: Int, val done: Int, val failed: Int)
data class DeskState(val name: String, val profiles: List<Profile>, val script: ScriptProgress?, val task: String?, val approvals: Int) {
    val running: List<Profile> get() = profiles.filter { it.running }
}
data class Tab(val id: String, val title: String, val url: String)
enum class ViewStatus { Starting, Loading, Live, Ended, Failed }
data class Viewer(
    val profileId: String,
    val generation: String = "",
    val targetId: String = "",
    val tabs: List<Tab> = emptyList(),
    val viewportW: Int = 0,
    val viewportH: Int = 0,
    val status: ViewStatus = ViewStatus.Loading,
    val error: String? = null,
)
data class Notice(val id: Long, val kind: String, val title: String, val detail: String, val approvalKind: String? = null, val approvalId: String? = null)

/**
 * Everything the screens show about the paired computer: the browsers, the one being used,
 * and notices. Lives as long as the app process; screens only read it and call its actions.
 */
class Desk(private val scope: CoroutineScope, private val store: ComputerStore) {
    private val _computer = MutableStateFlow<Computer?>(null)
    val computer: StateFlow<Computer?> = _computer
    /** False until the paired computer has been read from storage (the Keystore is slow to open). */
    private val _loaded = MutableStateFlow(false)
    val loaded: StateFlow<Boolean> = _loaded
    private val _link = MutableStateFlow<Link?>(null)
    val link: StateFlow<Link?> = _link
    private val _state = MutableStateFlow<DeskState?>(null)
    val state: StateFlow<DeskState?> = _state
    private val _viewer = MutableStateFlow<Viewer?>(null)
    val viewer: StateFlow<Viewer?> = _viewer
    private val _notices = MutableStateFlow<List<Notice>>(emptyList())
    val notices: StateFlow<List<Notice>> = _notices
    /** Notices that arrived while the app was in the background, for the system notification. */
    var onBackgroundNotice: ((Notice) -> Unit)? = null

    private var polling: Job? = null
    private var listening: Job? = null
    private var foreground = false
    private var noticeIds = 0L

    init {
        scope.launch {
            val saved = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { store.load() }
            _computer.value = saved
            _loaded.value = true
            saved?.let { connect(it) }
        }
    }

    fun paired(computer: Computer) {
        store.save(computer)
        _computer.value = computer
        connect(computer)
    }

    fun unpair() {
        _link.value?.stop()
        _link.value = null
        store.forget()
        _computer.value = null
        _state.value = null
        _viewer.value = null
    }

    private fun connect(computer: Computer) {
        _link.value?.stop()
        val link = Link(computer, scope) { host -> _computer.value?.let { store.remember(it, host) } }
        _link.value = link
        listening?.cancel()
        listening = scope.launch {
            launch { link.events.collect { event(it) } }
            launch {
                link.status.collect { status ->
                    if (status is LinkStatus.Ready) { refresh(); _viewer.value?.let { if (foreground) watch(it.profileId) } }
                }
            }
        }
        link.start()
        startPolling()
    }

    fun setForeground(value: Boolean) {
        foreground = value
        val link = _link.value ?: return
        if (value) {
            link.start(); link.nudge()
            startPolling()
            _viewer.value?.let { watch(it.profileId) }
        } else {
            polling?.cancel()
            // Nothing to draw in the background: stop the pictures, keep the connection for notices.
            scope.launch { runCatching { link.call("unwatch") } }
        }
    }

    fun stopLink() { _link.value?.stop() }

    private fun startPolling() {
        polling?.cancel()
        polling = scope.launch {
            while (isActive) {
                if (_link.value?.status?.value is LinkStatus.Ready) refresh()
                delay(2000)
            }
        }
    }

    suspend fun refresh() {
        val link = _link.value ?: return
        val data = runCatching { link.call("state") as? JSONObject }.getOrNull() ?: return
        val profiles = data.optJSONArray("profiles").objects().map {
            Profile(it.getString("id"), it.optString("name"), it.optString("group"), it.optBoolean("running"), it.optString("engine", "chromium"))
        }
        val script = data.optJSONObject("script")?.let { ScriptProgress(it.optString("name"), it.optString("status"), it.optInt("total"), it.optInt("done"), it.optInt("failed")) }
        val next = DeskState(data.optString("name"), profiles, script, data.optJSONObject("task")?.optString("name"), data.optInt("approvals"))
        _state.value = next
        // First look, or the browser in use was closed: show a running one.
        val current = _viewer.value
        if (current == null || (current.status == ViewStatus.Ended && next.running.none { it.id == current.profileId })) {
            val last = if (current == null) store.lastProfile else null
            (next.running.firstOrNull { it.id == last } ?: next.running.firstOrNull())?.let { select(it.id) } ?: run { if (current != null) _viewer.value = null }
        }
    }

    /** Use a browser: start it first if it is closed. */
    fun select(profileId: String) {
        val link = _link.value ?: return
        val profile = _state.value?.profiles?.firstOrNull { it.id == profileId }
        _viewer.value = Viewer(profileId, status = if (profile?.running == false) ViewStatus.Starting else ViewStatus.Loading)
        store.lastProfile = profileId
        link.clearFrame()
        scope.launch {
            if (profile?.running == false) {
                try { link.call("profile.open", JSONObject().put("id", profileId), timeoutMs = 120_000) }
                catch (error: Exception) {
                    if (_viewer.value?.profileId == profileId) _viewer.value = Viewer(profileId, status = ViewStatus.Failed, error = error.message)
                    return@launch
                }
                refresh()
            }
            if (_viewer.value?.profileId == profileId) watch(profileId)
        }
    }

    private fun watch(profileId: String) {
        val link = _link.value ?: return
        scope.launch {
            try {
                val data = link.call("watch", JSONObject().put("id", profileId)) as? JSONObject
                val generation = data?.optString("generation") ?: ""
                _viewer.update { if (it?.profileId == profileId) it.copy(generation = generation, status = if (it.status == ViewStatus.Live) it.status else ViewStatus.Loading) else it }
                visibility()
            } catch (error: Exception) {
                _viewer.update { if (it?.profileId == profileId) it.copy(status = ViewStatus.Failed, error = error.message) else it }
            }
        }
    }

    /** The phone's screen size, so pictures arrive sharp but no bigger than needed. */
    var frameWidth = 1280

    private fun visibility() {
        _link.value?.workbench(JSONObject().put("action", "visibility").put("visible", true).put("focused", true).put("tier", "interactive").put("width", frameWidth))
    }

    fun closeBrowser(profileId: String) {
        val link = _link.value ?: return
        scope.launch {
            runCatching { link.call("profile.close", JSONObject().put("id", profileId), timeoutMs = 60_000) }
                .onFailure { notify("error", tr("没能关闭", "Could not close"), it.message ?: "") }
            if (_viewer.value?.profileId == profileId) _viewer.update { it?.copy(status = ViewStatus.Ended) }
            refresh()
        }
    }

    private fun event(message: JSONObject) {
        when (message.optString("t")) {
            "wb" -> workbenchEvent(message)
            "notify" -> {
                val notice = when (message.optString("kind")) {
                    "approval" -> {
                        val who = message.optString("client").ifBlank { "AI" }
                        Notice(++noticeIds, "approval",
                            if (message.optString("approval") == "code") tr("$who 想保存脚本或插件", "$who wants to save code") else tr("$who 想换代理", "$who wants to change a proxy"),
                            message.optString("detail"), message.optString("approval"), message.optString("id"))
                    }
                    "script" -> {
                        val failed = message.optInt("failed")
                        Notice(++noticeIds, if (failed > 0) "error" else "done",
                            tr("脚本跑完了", "Script finished") + " · " + message.optString("name"),
                            if (failed > 0) tr("${message.optInt("total")} 个里失败 $failed 个", "$failed of ${message.optInt("total")} failed") else tr("${message.optInt("total")} 个全部成功", "All ${message.optInt("total")} succeeded"))
                    }
                    else -> return
                }
                _notices.update { (it + notice).takeLast(4) }
                if (!foreground) onBackgroundNotice?.invoke(notice)
                scope.launch { refresh() }
            }
        }
    }

    private fun workbenchEvent(message: JSONObject) {
        val current = _viewer.value ?: return
        if (message.optString("profileId") != current.profileId) return
        val tabs = message.optJSONArray("tabs")?.objects()?.map { Tab(it.optString("id"), it.optString("title"), it.optString("url")) }
        val viewport = message.optJSONObject("viewport")
        when (message.optString("type")) {
            "ready", "tabs" -> _viewer.update {
                it?.copy(
                    generation = message.optString("generation", it.generation),
                    targetId = message.optString("targetId", it.targetId),
                    tabs = tabs ?: it.tabs,
                    viewportW = viewport?.optInt("width") ?: it.viewportW,
                    viewportH = viewport?.optInt("height") ?: it.viewportH,
                    status = if (it.status == ViewStatus.Starting) ViewStatus.Loading else it.status,
                )
            }
            "frame-error" -> {}
            "ended" -> { _viewer.update { it?.copy(status = ViewStatus.Ended) }; scope.launch { refresh() } }
            "error" -> _viewer.update { it?.copy(status = ViewStatus.Failed, error = message.optString("error")) }
        }
    }

    /** The first picture arrived. */
    fun live() { _viewer.update { if (it != null && it.status != ViewStatus.Live && it.status != ViewStatus.Ended) it.copy(status = ViewStatus.Live) else it } }

    fun dismiss(id: Long) { _notices.update { list -> list.filter { it.id != id } } }

    fun notify(kind: String, title: String, detail: String) { _notices.update { (it + Notice(++noticeIds, kind, title, detail)).takeLast(4) } }

    // ---- Using the browser ----

    private fun input(input: JSONObject) {
        val viewer = _viewer.value ?: return
        if (viewer.targetId.isEmpty()) return
        _link.value?.workbench(JSONObject().put("action", "input").put("targetId", viewer.targetId).put("input", input))
    }

    private fun pointer(event: String, x: Float, y: Float, button: String, buttons: Int, clicks: Int) =
        input(JSONObject().put("kind", "pointer").put("event", event).put("x", x.toDouble()).put("y", y.toDouble())
            .put("button", button).put("buttons", buttons).put("clicks", clicks).put("modifiers", 0))

    fun tap(x: Float, y: Float, button: String = "left") {
        val mask = if (button == "right") 2 else 1
        pointer("move", x, y, "left", 0, 0)
        pointer("down", x, y, button, mask, 1)
        pointer("up", x, y, button, 0, 1)
    }

    fun press(x: Float, y: Float) { pointer("move", x, y, "left", 0, 0); pointer("down", x, y, "left", 1, 1) }
    fun drag(x: Float, y: Float) = pointer("move", x, y, "left", 1, 0)
    fun release(x: Float, y: Float) = pointer("up", x, y, "left", 0, 1)

    fun scroll(x: Float, y: Float, dx: Float, dy: Float) =
        input(JSONObject().put("kind", "wheel").put("x", x.toDouble()).put("y", y.toDouble()).put("dx", dx.toDouble()).put("dy", dy.toDouble()).put("modifiers", 0))

    fun type(text: String) { if (text.isNotEmpty()) input(JSONObject().put("kind", "text").put("text", text)) }

    /** A key by its name in KeyboardEvent terms; modifiers: Alt 1, Ctrl 2, Meta 4, Shift 8. */
    fun key(key: String, code: String, keyCode: Int, modifiers: Int = 0) {
        for (phase in listOf("down", "up")) input(JSONObject().put("kind", "key").put("event", phase).put("key", key).put("code", code).put("keyCode", keyCode).put("modifiers", modifiers))
    }

    fun back() = key("ArrowLeft", "ArrowLeft", 37, 1)
    fun forward() = key("ArrowRight", "ArrowRight", 39, 1)
    fun reload() = key("F5", "F5", 116)

    fun tabCommand(action: String, targetId: String? = null) {
        val message = JSONObject().put("action", action)
        if (targetId != null) message.put("targetId", targetId)
        _link.value?.workbench(message)
    }

    /**
     * Opens what was typed in a new tab of the browser shown, and shows that tab: an address as
     * it is (https:// added when missing), anything else as a search.
     */
    fun visit(text: String) {
        val viewer = _viewer.value ?: return
        val typed = text.trim()
        if (typed.isEmpty()) return
        val url = when {
            Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(typed) -> typed
            !typed.contains(' ') && Regex("^[^\\s/]+\\.[a-z]{2,}([:/?#].*)?$", RegexOption.IGNORE_CASE).matches(typed) -> "https://$typed"
            else -> "https://www.google.com/search?q=" + java.net.URLEncoder.encode(typed, "UTF-8")
        }
        val before = viewer.tabs.map { it.id }.toSet()
        scope.launch {
            try { call("profile.visit", JSONObject().put("id", viewer.profileId).put("url", url), timeoutMs = 60_000) }
            catch (error: Exception) { notify("error", tr("没能打开", "Could not open"), error.message ?: ""); return@launch }
            // The new tab shows up in the next tab list; switch to it.
            repeat(20) {
                tabCommand("refresh")
                delay(300)
                val fresh = _viewer.value?.tabs?.firstOrNull { it.id !in before }
                if (fresh != null) { tabCommand("select", fresh.id); return@launch }
            }
        }
    }

    // ---- Calls the sheets make ----

    suspend fun call(method: String, params: JSONObject = JSONObject(), timeoutMs: Long = 30_000): Any? =
        (_link.value ?: throw IllegalStateException(tr("没有连上电脑", "Not connected"))).call(method, params, timeoutMs)
}

fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else List(length()) { getJSONObject(it) }

package app.vela.mobile.ui.main

import app.vela.mobile.ui.theme.filledField
import app.vela.mobile.ui.theme.TitleSerif
import app.vela.mobile.ui.theme.LocalStatus
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.ArrowForward
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Code
import androidx.compose.material.icons.rounded.Event
import androidx.compose.material.icons.rounded.PowerSettingsNew
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Shield
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.vela.mobile.Desk
import app.vela.mobile.DeskState
import app.vela.mobile.Viewer
import app.vela.mobile.app
import app.vela.mobile.objects
import app.vela.mobile.tr
import app.vela.mobile.ui.theme.LocalDarkTheme
import app.vela.mobile.ui.theme.VelaSwitch
import app.vela.mobile.ui.theme.floatingCard
import app.vela.mobile.ui.theme.springClickable
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

enum class Page { Home, Scripts, Tasks, Approvals, Settings }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VelaSheet(onDismiss: () -> Unit, content: @Composable () -> Unit) {
    val dark = LocalDarkTheme.current
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
        containerColor = if (dark) Color(0xFF121216) else Color(0xFFF6F6F8),
        dragHandle = { Box(Modifier.padding(top = 10.dp, bottom = 6.dp).size(38.dp, 5.dp).clip(CircleShape).background(MaterialTheme.colorScheme.outline.copy(alpha = 0.5f))) },
    ) {
        // Never taller than the screen below the status bar, so a long page scrolls instead of sliding under it.
        val maxHeight = androidx.compose.ui.platform.LocalConfiguration.current.screenHeightDp.dp - 36.dp
        Box(Modifier.navigationBarsPadding().heightIn(max = maxHeight)) { content() }
    }
}

@Composable
private fun SheetTitle(title: String, onBack: (() -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        if (onBack != null) {
            Icon(Icons.AutoMirrored.Rounded.ArrowBack, tr("返回", "Back"), tint = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.size(36.dp).clip(CircleShape).springClickable(onClick = onBack).padding(6.dp))
            Spacer(Modifier.width(6.dp))
        }
        Text(title, fontSize = 26.sp, fontWeight = FontWeight.Bold, fontFamily = TitleSerif, letterSpacing = 0.5.sp, color = MaterialTheme.colorScheme.onBackground)
    }
}

@Composable
private fun Group(content: @Composable () -> Unit) {
    Column(Modifier.padding(horizontal = 16.dp).fillMaxWidth().floatingCard(RoundedCornerShape(20.dp))) { content() }
}

@Composable
private fun Divider() = Box(Modifier.padding(start = 18.dp, end = 18.dp).fillMaxWidth().height(1.dp).background(MaterialTheme.colorScheme.outlineVariant))

@Composable
private fun Pill(text: String, dark: Boolean = true, enabled: Boolean = true, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Text(text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
        color = if (dark) colors.background else colors.onSurface,
        modifier = Modifier.clip(CircleShape)
            .background(if (dark) colors.onSurface.copy(alpha = if (enabled) 1f else 0.35f) else colors.surfaceVariant)
            .springClickable(enabled = enabled, pressedScale = 0.94f, onClick = onClick).padding(horizontal = 16.dp, vertical = 9.dp))
}

/** The control centre: four tiles, each opening its page inside the same sheet. */
@Composable
fun ControlCenter(desk: Desk, state: DeskState?, viewer: Viewer?, start: Page, onDismiss: () -> Unit) {
    var page by remember { mutableStateOf(start) }
    VelaSheet(onDismiss) {
        AnimatedContent(page, label = "page", transitionSpec = {
            val forward = targetState != Page.Home
            (slideInHorizontally(spring(0.9f, 420f)) { if (forward) it / 4 else -it / 4 } + fadeIn(tween(220))) togetherWith
                (slideOutHorizontally(spring(0.9f, 420f)) { if (forward) -it / 6 else it / 6 } + fadeOut(tween(160)))
        }) { current ->
            Column(Modifier.heightIn(min = 420.dp).verticalScroll(rememberScrollState()).padding(bottom = 18.dp)) {
                when (current) {
                    Page.Home -> Home(state) { page = it }
                    Page.Scripts -> Scripts(desk, state, viewer) { page = Page.Home }
                    Page.Tasks -> Tasks(desk) { page = Page.Home }
                    Page.Approvals -> Approvals(desk) { page = Page.Home }
                    Page.Settings -> SettingsPage(desk, state, { page = Page.Home }, onDismiss)
                }
            }
        }
    }
}

@Composable
private fun Home(state: DeskState?, go: (Page) -> Unit) {
    val colors = MaterialTheme.colorScheme
    SheetTitle(state?.name ?: tr("电脑", "Computer"))
    Text(
        tr("${state?.running?.size ?: 0} 个浏览器在运行，共 ${state?.profiles?.size ?: 0} 个环境", "${state?.running?.size ?: 0} running of ${state?.profiles?.size ?: 0} profiles"),
        fontSize = 14.sp, color = colors.onSurfaceVariant, modifier = Modifier.padding(start = 20.dp, bottom = 16.dp, top = 0.dp),
    )
    state?.script?.let { run ->
        Column(Modifier.padding(horizontal = 16.dp).fillMaxWidth().floatingCard(RoundedCornerShape(20.dp)).springClickable(pressedScale = 0.98f) { go(Page.Scripts) }.padding(16.dp)) {
            Text(tr("脚本运行中 · ${run.name}", "Script running · ${run.name}"), fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = colors.onSurface)
            Spacer(Modifier.height(10.dp))
            LinearProgressIndicator({ if (run.total > 0) run.done / run.total.toFloat() else 0f }, Modifier.fillMaxWidth().height(6.dp).clip(CircleShape), color = colors.onSurface, trackColor = colors.surfaceVariant, gapSize = 0.dp, drawStopIndicator = {})
            Spacer(Modifier.height(6.dp))
            Text(tr("${run.done}/${run.total}" + if (run.failed > 0) "，失败 ${run.failed}" else "", "${run.done}/${run.total}" + if (run.failed > 0) ", ${run.failed} failed" else ""), fontSize = 12.sp, color = colors.onSurfaceVariant)
        }
        Spacer(Modifier.height(12.dp))
    }
    val tiles = listOf(
        Triple(Page.Scripts, Icons.Rounded.Code, tr("脚本", "Scripts")),
        Triple(Page.Tasks, Icons.Rounded.Event, tr("自动任务", "Tasks")),
        Triple(Page.Approvals, Icons.Rounded.Shield, tr("审批", "Approvals")),
        Triple(Page.Settings, Icons.Rounded.Settings, tr("设置", "Settings")),
    )
    tiles.chunked(2).forEach { row ->
        Row(Modifier.padding(horizontal = 16.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            row.forEach { (target, icon, label) ->
                Tile(icon, label, if (target == Page.Approvals && (state?.approvals ?: 0) > 0) state!!.approvals else 0,
                    sub = when (target) {
                        Page.Approvals -> if ((state?.approvals ?: 0) > 0) tr("${state!!.approvals} 个等你决定", "${state!!.approvals} waiting") else tr("没有待处理", "Nothing waiting")
                        Page.Tasks -> state?.task?.let { tr("进行中 · $it", "Running · $it") } ?: tr("按计划自动运行", "Run on a schedule")
                        Page.Scripts -> tr("在浏览器里跑脚本", "Run in browsers")
                        else -> tr("连接与外观", "Connection, look")
                    }, modifier = Modifier.weight(1f)) { go(target) }
            }
        }
    }
}

@Composable
private fun Tile(icon: ImageVector, label: String, badge: Int, sub: String, modifier: Modifier, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Column(modifier.floatingCard(RoundedCornerShape(20.dp)).springClickable(pressedScale = 0.95f, onClick = onClick).padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(38.dp).clip(CircleShape).background(colors.surfaceVariant), contentAlignment = Alignment.Center) {
                Icon(icon, null, tint = colors.onSurface, modifier = Modifier.size(21.dp))
            }
            Spacer(Modifier.weight(1f))
            if (badge > 0) Box(Modifier.size(22.dp).clip(CircleShape).background(colors.onSurface), contentAlignment = Alignment.Center) {
                Text(badge.coerceAtMost(99).toString(), color = colors.background, fontSize = 11.sp, fontWeight = FontWeight.Bold)
            }
        }
        Spacer(Modifier.height(18.dp))
        Text(label, fontSize = 17.sp, fontWeight = FontWeight.Bold, color = colors.onSurface)
        Text(sub, fontSize = 12.sp, color = colors.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun Loading() = Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) {
    CircularProgressIndicator(Modifier.size(28.dp), color = MaterialTheme.colorScheme.onSurface, strokeWidth = 2.5.dp)
}

@Composable
private fun Empty(text: String) = Text(text, fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(20.dp))

@Composable
private fun Scripts(desk: Desk, state: DeskState?, viewer: Viewer?, onBack: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val scope = rememberCoroutineScope()
    var scripts by remember { mutableStateOf<List<JSONObject>?>(null) }
    var chosen by remember { mutableStateOf<String?>(null) }
    var target by remember { mutableStateOf(if (viewer != null) "current" else "running") }
    var message by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { scripts = runCatching { (desk.call("scripts.list") as? JSONArray).objects() }.getOrElse { message = it.message; emptyList() } }
    SheetTitle(tr("脚本", "Scripts"), onBack)
    state?.script?.let { run ->
        Group {
            Column(Modifier.padding(16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(run.name, fontSize = 16.sp, fontWeight = FontWeight.Bold, color = colors.onSurface, modifier = Modifier.weight(1f))
                    Pill(tr("停止", "Stop"), dark = false) { scope.launch { runCatching { desk.call("script.stop") }; desk.refresh() } }
                }
                Spacer(Modifier.height(10.dp))
                LinearProgressIndicator({ if (run.total > 0) run.done / run.total.toFloat() else 0f }, Modifier.fillMaxWidth().height(6.dp).clip(CircleShape), color = colors.onSurface, trackColor = colors.surfaceVariant, gapSize = 0.dp, drawStopIndicator = {})
                Spacer(Modifier.height(6.dp))
                Text(tr("完成 ${run.done}/${run.total}" + if (run.failed > 0) "，失败 ${run.failed}" else "", "${run.done}/${run.total} done" + if (run.failed > 0) ", ${run.failed} failed" else ""), fontSize = 12.sp, color = colors.onSurfaceVariant)
            }
        }
        Spacer(Modifier.height(14.dp))
    }
    val list = scripts ?: return Loading()
    if (list.isEmpty()) { Empty(message ?: tr("还没有脚本。在电脑上的「脚本」里写一个。", "No scripts yet. Write one in Scripts on the computer.")); return }
    // Which browsers it runs in.
    Row(Modifier.padding(horizontal = 16.dp).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        val running = state?.running?.size ?: 0
        listOfNotNull(
            if (viewer != null) "current" to tr("当前浏览器", "This browser") else null,
            "running" to tr("全部运行中（$running）", "All running ($running)"),
        ).forEach { (value, label) -> Pill(label, dark = target == value) { target = value } }
    }
    Spacer(Modifier.height(12.dp))
    Group {
        list.forEachIndexed { i, script ->
            if (i > 0) Divider()
            val id = script.optString("id")
            val on = chosen == id
            Row(Modifier.fillMaxWidth().springClickable(pressedScale = 0.98f) { chosen = if (on) null else id }.padding(horizontal = 18.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(script.optString("name"), fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = colors.onSurface)
                    val description = script.optString("description")
                    if (description.isNotBlank()) Text(description, fontSize = 12.5.sp, color = colors.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
                Text(if (script.optString("language") == "python") "Py" else "JS", fontSize = 11.sp, fontWeight = FontWeight.Bold, color = colors.onSurfaceVariant,
                    modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(colors.surfaceVariant).padding(horizontal = 7.dp, vertical = 3.dp))
                if (on) {
                    Spacer(Modifier.width(10.dp))
                    val ids = if (target == "current") listOfNotNull(viewer?.profileId) else state?.running?.map { it.id } ?: emptyList()
                    Pill(tr("运行", "Run"), enabled = ids.isNotEmpty() && state?.script == null) {
                        scope.launch {
                            message = runCatching { desk.call("script.run", JSONObject().put("scriptId", id).put("profileIds", JSONArray(ids))); null }.getOrElse { it.message }
                            desk.refresh()
                        }
                    }
                }
            }
        }
    }
    message?.let { Text(it, color = colors.error, fontSize = 13.sp, modifier = Modifier.padding(20.dp)) }
    if (state?.script != null) Text(tr("一次只能跑一个脚本，等这个跑完或停止它。", "One script at a time: wait for this one or stop it."), fontSize = 12.sp, color = colors.onSurfaceVariant, modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp))
}

@Composable
private fun Tasks(desk: Desk, onBack: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val scope = rememberCoroutineScope()
    var data by remember { mutableStateOf<JSONObject?>(null) }
    LaunchedEffect(Unit) { while (isActive) { data = runCatching { desk.call("tasks.list") as? JSONObject }.getOrNull() ?: data; delay(2500) } }
    SheetTitle(tr("自动任务", "Tasks"), onBack)
    val listing = data ?: return Loading()
    val tasks = listing.optJSONArray("tasks").objects()
    val runningId = listing.optString("runningTaskId", "")
    if (tasks.isEmpty()) { Empty(tr("还没有任务。在电脑上的「自动任务」里建一个。", "No tasks yet. Make one in Tasks on the computer.")); return }
    Group {
        tasks.forEachIndexed { i, task ->
            if (i > 0) Divider()
            val id = task.optString("id")
            Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(task.optString("name"), fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = colors.onSurface)
                    val next = task.optLong("nextRunAt", 0L)
                    Text(
                        when {
                            id == runningId -> tr("正在运行", "Running now")
                            !task.optBoolean("enabled") -> tr("已暂停", "Paused")
                            next > 0 -> tr("下次 ", "Next ") + java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT, java.text.DateFormat.SHORT).format(java.util.Date(next))
                            else -> tr("手动运行", "Run by hand")
                        }, fontSize = 12.5.sp, color = if (id == runningId) LocalStatus.current.runningInk else colors.onSurfaceVariant,
                    )
                }
                if (id == runningId) CircularProgressIndicator(Modifier.size(20.dp), color = colors.onSurface, strokeWidth = 2.dp)
                else Pill(tr("立即运行", "Run now"), enabled = runningId.isEmpty()) {
                    scope.launch { runCatching { desk.call("task.run", JSONObject().put("id", id)) }.onFailure { desk.notify("error", tr("没能运行", "Could not run"), it.message ?: "") }; data = runCatching { desk.call("tasks.list") as? JSONObject }.getOrNull() ?: data }
                }
            }
        }
    }
    val history = listing.optJSONArray("history").objects().take(6)
    if (history.isNotEmpty()) {
        Text(tr("最近", "Recent"), fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = colors.onSurfaceVariant, modifier = Modifier.padding(start = 20.dp, top = 20.dp, bottom = 8.dp))
        Group {
            history.forEachIndexed { i, run ->
                if (i > 0) Divider()
                val outcome = run.optString("outcome")
                Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(8.dp).clip(CircleShape).background(when (outcome) { "succeeded" -> LocalStatus.current.running; "partial" -> LocalStatus.current.warning; "running" -> colors.onSurfaceVariant; else -> LocalStatus.current.error }))
                    Spacer(Modifier.width(12.dp))
                    Text(run.optString("taskName"), fontSize = 14.sp, color = colors.onSurface, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(java.util.Date(run.optLong("startedAt"))), fontSize = 12.sp, color = colors.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
private fun Approvals(desk: Desk, onBack: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val scope = rememberCoroutineScope()
    var data by remember { mutableStateOf<JSONObject?>(null) }
    var open by remember { mutableStateOf<String?>(null) }
    suspend fun load() { data = runCatching { desk.call("approvals.list") as? JSONObject }.getOrNull() ?: data }
    LaunchedEffect(Unit) { while (isActive) { load(); delay(3000) } }
    SheetTitle(tr("审批", "Approvals"), onBack)
    val listing = data ?: return Loading()
    val proxy = listing.optJSONArray("proxy").objects()
    val code = listing.optJSONArray("code").objects()
    if (proxy.isEmpty() && code.isEmpty()) { Empty(tr("没有等你决定的请求。AI 想换代理、保存脚本或插件时会出现在这里。", "Nothing waiting. When an AI wants to change a proxy or save a script or plugin, it shows up here.")); return }
    fun answer(kind: String, id: String, allow: Boolean) = scope.launch {
        runCatching { desk.call("approval.answer", JSONObject().put("kind", kind).put("id", id).put("allow", allow)) }.onFailure { desk.notify("error", tr("没能提交", "Could not answer"), it.message ?: "") }
        load(); desk.refresh()
    }
    proxy.forEach { item ->
        Group {
            Column(Modifier.padding(16.dp)) {
                Text(tr("${item.optString("client")} 想换代理", "${item.optString("client")} wants to change a proxy"), fontSize = 13.sp, color = colors.onSurfaceVariant)
                Text(item.optString("profileName"), fontSize = 17.sp, fontWeight = FontWeight.Bold, color = colors.onSurface)
                Spacer(Modifier.height(10.dp))
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(colors.surfaceVariant.copy(alpha = 0.6f)).padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf(tr("现在", "Now") to item.optString("from"), tr("换成", "New") to item.optString("to")).forEach { (label, value) ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(label, fontSize = 12.sp, color = colors.onSurfaceVariant, modifier = Modifier.width(40.dp))
                            Text(value, fontSize = 13.sp, fontFamily = FontFamily.Monospace, color = colors.onSurface, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
                if (item.optBoolean("reopens")) Text(tr("浏览器会重新打开", "The browser will reopen"), fontSize = 12.sp, color = colors.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
                Spacer(Modifier.height(14.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Pill(tr("允许", "Allow")) { answer("proxy", item.optString("id"), true) }
                    Pill(tr("拒绝", "Refuse"), dark = false) { answer("proxy", item.optString("id"), false) }
                }
            }
        }
        Spacer(Modifier.height(12.dp))
    }
    code.forEach { item ->
        val id = item.optString("id")
        Group {
            Column(Modifier.padding(16.dp)) {
                Text(tr("${item.optString("client")} 想${if (item.optString("action") == "update") "修改" else "新建"}${if (item.optString("kind") == "plugin") "插件" else "脚本"}",
                    "${item.optString("client")} wants to ${item.optString("action")} a ${item.optString("kind")}"), fontSize = 13.sp, color = colors.onSurfaceVariant)
                Text(item.optString("title"), fontSize = 17.sp, fontWeight = FontWeight.Bold, color = colors.onSurface)
                val detail = item.optString("detail")
                if (detail.isNotBlank()) Text(detail, fontSize = 13.sp, color = colors.onSurface, modifier = Modifier.padding(top = 6.dp))
                val files = item.optJSONArray("files").objects()
                Text(if (open == id) tr("收起代码", "Hide the code") else tr("看代码（${files.size} 个文件）", "Read the code (${files.size} files)"), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                    color = colors.onSurface, modifier = Modifier.padding(top = 10.dp).springClickable { open = if (open == id) null else id })
                if (open == id) files.forEach { file ->
                    Text(file.optString("name"), fontSize = 12.sp, fontWeight = FontWeight.Bold, color = colors.onSurfaceVariant, modifier = Modifier.padding(top = 10.dp, bottom = 4.dp))
                    Text(file.optString("content") + if (file.optBoolean("cut")) "\n…" else "", fontSize = 11.5.sp, lineHeight = 16.sp, fontFamily = FontFamily.Monospace, color = colors.onSurface,
                        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(colors.surfaceVariant).heightIn(max = 320.dp).verticalScroll(rememberScrollState()).padding(10.dp))
                }
                Spacer(Modifier.height(14.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Pill(tr("允许", "Allow")) { answer("code", id, true) }
                    Pill(tr("拒绝", "Refuse"), dark = false) { answer("code", id, false) }
                }
            }
        }
        Spacer(Modifier.height(12.dp))
    }
}

@Composable
private fun SettingsPage(desk: Desk, state: DeskState?, onBack: () -> Unit, onClose: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val context = LocalContext.current
    val settings = context.app.settings
    val computer by desk.computer.collectAsState()
    var theme by remember { mutableStateOf(settings.theme) }
    var alerts by remember { mutableStateOf(settings.backgroundAlerts) }
    var haptics by remember { mutableStateOf(settings.haptics) }
    var confirm by remember { mutableStateOf(false) }
    val notifications = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.RequestPermission()) { }
    SheetTitle(tr("设置", "Settings"), onBack)
    Group {
        Row(Modifier.padding(18.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(state?.name ?: computer?.name ?: "", fontSize = 16.sp, fontWeight = FontWeight.Bold, color = colors.onSurface)
                Text(computer?.hosts?.firstOrNull()?.let { "$it:${computer?.port}" } ?: "", fontSize = 12.5.sp, fontFamily = FontFamily.Monospace, color = colors.onSurfaceVariant)
            }
            Text(if (state != null) tr("已连接", "Connected") else tr("连接中", "Connecting"), fontSize = 13.sp, color = if (state != null) LocalStatus.current.runningInk else colors.onSurfaceVariant)
        }
    }
    Text(tr("外观", "Look"), fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = colors.onSurfaceVariant, modifier = Modifier.padding(start = 20.dp, top = 20.dp, bottom = 8.dp))
    Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        listOf("system" to tr("跟随系统", "System"), "light" to tr("浅色", "Light"), "dark" to tr("深色", "Dark")).forEach { (value, label) ->
            Pill(label, dark = theme == value) { theme = value; settings.theme = value; context.app.themeChanged() }
        }
    }
    val mode by desk.mode.collectAsState()
    Text(tr("观看模式", "View"), fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = colors.onSurfaceVariant, modifier = Modifier.padding(start = 20.dp, top = 20.dp, bottom = 8.dp))
    Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        listOf("phone" to tr("手机模式", "Phone"), "pc" to tr("PC 模式", "PC")).forEach { (value, label) ->
            Pill(label, dark = mode == value) { desk.setViewMode(value) }
        }
    }
    Text(
        if (mode == "phone") tr("把电脑上这个浏览器的窗口收窄到手机宽度，网页按手机排版，看起来就是手机网页。不改视口和 UA，离开时窗口恢复原来的大小。", "Narrows the browser's window on the computer to a phone's width, so pages lay out for a phone. The viewport and user agent stay the same, and the window gets its size back afterwards.")
        else tr("保持电脑上的排版，整页缩放到手机屏幕，双指可以放大。", "Keeps the desktop layout, scaled to the phone's screen; pinch to zoom."),
        fontSize = 12.sp, lineHeight = 17.sp, color = colors.onSurfaceVariant, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
    )
    Spacer(Modifier.height(12.dp))
    Group {
        Row(Modifier.padding(horizontal = 18.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(tr("在后台接收提醒", "Alerts in the background"), fontSize = 15.sp, color = colors.onSurface)
                Text(tr("切到别的 App 时也保持连接，AI 审批和脚本结束会发通知。", "Stays connected while you use other apps, to notify approvals and finished scripts."), fontSize = 12.sp, lineHeight = 17.sp, color = colors.onSurfaceVariant)
            }
            Spacer(Modifier.width(12.dp))
            VelaSwitch(alerts, {
                alerts = it; settings.backgroundAlerts = it
                if (it && android.os.Build.VERSION.SDK_INT >= 33) notifications.launch(android.Manifest.permission.POST_NOTIFICATIONS)
            })
        }
        Divider()
        Row(Modifier.padding(horizontal = 18.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(tr("触感反馈", "Haptics"), fontSize = 15.sp, color = colors.onSurface, modifier = Modifier.weight(1f))
            VelaSwitch(haptics, { haptics = it; settings.haptics = it })
        }
    }
    Spacer(Modifier.height(20.dp))
    Group {
        Row(Modifier.fillMaxWidth().springClickable(pressedScale = 0.98f) { if (confirm) { desk.unpair(); onClose() } else confirm = true }.padding(18.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Rounded.PowerSettingsNew, null, tint = colors.error, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(12.dp))
            Text(if (confirm) tr("再点一次确认取消配对", "Tap again to unpair") else tr("取消配对", "Unpair"), fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = colors.error)
        }
    }
    Text(tr("取消配对后，这台手机上的密钥会被删除。电脑上「设置 → 手机端」里也能移除它。", "Unpairing deletes the key on this phone. You can also remove it in Settings → Phone app on the computer."),
        fontSize = 12.sp, lineHeight = 17.sp, color = colors.onSurfaceVariant, modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp))
    Text("Vela ${app.vela.mobile.BuildConfig.VERSION_NAME}", fontSize = 12.sp, color = colors.onSurfaceVariant.copy(alpha = 0.7f), modifier = Modifier.padding(horizontal = 20.dp))
}

/** The browser's own controls: back, forward, reload, its tabs, and closing it. */
@Composable
fun BrowserSheet(desk: Desk, viewer: Viewer, name: String, onDismiss: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    VelaSheet(onDismiss) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(bottom = 18.dp)) {
            SheetTitle(name)
            // Where to go: an address or words to search, opened in a new tab of this browser.
            var address by remember { mutableStateOf("") }
            val focus = remember { androidx.compose.ui.focus.FocusRequester() }
            val ime = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
            val go = { if (address.isNotBlank()) { ime?.hide(); desk.visit(address); onDismiss() } }
            Row(
                Modifier.padding(horizontal = 16.dp).fillMaxWidth().height(52.dp).filledField(CircleShape).padding(start = 18.dp, end = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                    if (address.isEmpty()) Text(tr("输入网址或搜索", "Address or search"), fontSize = 15.sp, color = colors.onSurfaceVariant)
                    androidx.compose.foundation.text.BasicTextField(
                        address, { address = it }, singleLine = true,
                        textStyle = androidx.compose.ui.text.TextStyle(fontSize = 15.sp, color = colors.onSurface),
                        cursorBrush = androidx.compose.ui.graphics.SolidColor(colors.onSurface),
                        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Uri, imeAction = androidx.compose.ui.text.input.ImeAction.Go, autoCorrectEnabled = false),
                        keyboardActions = androidx.compose.foundation.text.KeyboardActions(onGo = { go() }),
                        modifier = Modifier.fillMaxWidth().focusRequester(focus),
                    )
                }
                if (address.isNotBlank()) Icon(Icons.AutoMirrored.Rounded.ArrowForward, tr("打开", "Open"), tint = colors.background,
                    modifier = Modifier.size(40.dp).clip(CircleShape).background(colors.onSurface).springClickable { go() }.padding(9.dp))
            }
            Spacer(Modifier.height(12.dp))
            Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                listOf(
                    Triple(Icons.AutoMirrored.Rounded.ArrowBack, tr("后退", "Back")) { desk.back() },
                    Triple(Icons.AutoMirrored.Rounded.ArrowForward, tr("前进", "Forward")) { desk.forward() },
                    Triple(Icons.Rounded.Refresh, tr("刷新", "Reload")) { desk.reload() },
                    Triple(Icons.Rounded.Add, tr("新标签", "New tab")) { runCatching { focus.requestFocus() } },
                ).forEach { (icon, label, action) ->
                    Column(Modifier.weight(1f).floatingCard(RoundedCornerShape(20.dp)).springClickable(pressedScale = 0.93f) { action() }.padding(vertical = 14.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Icon(icon, null, tint = colors.onSurface, modifier = Modifier.size(22.dp))
                        Spacer(Modifier.height(6.dp))
                        Text(label, fontSize = 12.sp, color = colors.onSurfaceVariant)
                    }
                }
            }
            Text(tr("标签页 · ${viewer.tabs.size}", "Tabs · ${viewer.tabs.size}"), fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = colors.onSurfaceVariant, modifier = Modifier.padding(start = 20.dp, top = 22.dp, bottom = 8.dp))
            Group {
                viewer.tabs.forEachIndexed { i, tab ->
                    if (i > 0) Divider()
                    val active = tab.id == viewer.targetId
                    Row(Modifier.fillMaxWidth().springClickable(pressedScale = 0.98f) { desk.tabCommand("select", tab.id); onDismiss() }.padding(start = 18.dp, end = 8.dp, top = 12.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(8.dp).clip(CircleShape).background(if (active) colors.onSurface else Color.Transparent))
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text(tab.title.ifBlank { tr("新标签页", "New tab") }, fontSize = 14.5.sp, fontWeight = if (active) FontWeight.Bold else FontWeight.Medium, color = colors.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(tab.url.removePrefix("https://").removePrefix("http://"), fontSize = 12.sp, color = colors.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        if (viewer.tabs.size > 1) Icon(Icons.Rounded.Close, tr("关闭标签", "Close tab"), tint = colors.onSurfaceVariant,
                            modifier = Modifier.size(40.dp).clip(CircleShape).springClickable { desk.tabCommand("close", tab.id) }.padding(10.dp))
                    }
                }
            }
            Spacer(Modifier.height(18.dp))
            var confirm by remember { mutableStateOf(false) }
            Group {
                Row(Modifier.fillMaxWidth().springClickable(pressedScale = 0.98f) { if (confirm) { desk.closeBrowser(viewer.profileId); onDismiss() } else confirm = true }.padding(18.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Rounded.Stop, null, tint = colors.error, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.width(12.dp))
                    Text(if (confirm) tr("再点一次关闭这个浏览器", "Tap again to close this browser") else tr("关闭浏览器", "Close the browser"), fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = colors.error)
                }
            }
        }
    }
}

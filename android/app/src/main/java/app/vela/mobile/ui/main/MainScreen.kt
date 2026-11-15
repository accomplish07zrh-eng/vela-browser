package app.vela.mobile.ui.main

import androidx.compose.material.icons.rounded.DesktopWindows
import androidx.compose.material.icons.rounded.Smartphone
import app.vela.mobile.ui.theme.TitleSerif
import app.vela.mobile.ui.theme.LocalStatus
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.Shield
import androidx.compose.material.icons.rounded.ScreenRotation
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.vela.mobile.Notice
import app.vela.mobile.ViewStatus
import app.vela.mobile.app
import app.vela.mobile.net.LinkStatus
import app.vela.mobile.tr
import app.vela.mobile.ui.theme.WordmarkFont
import app.vela.mobile.ui.theme.glassSurface
import app.vela.mobile.ui.theme.springClickable
import dev.chrisbanes.haze.HazeState
import dev.chrisbanes.haze.haze
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * One browser at a time, edge to edge. Glass floats over it: its name and tabs at the top,
 * the dock at the bottom (swipe it to change browser), the dial behind the right edge (every
 * profile), and notices that slide in from the top.
 */
@Composable
fun MainScreen() {
    val context = LocalContext.current
    val desk = context.app.desk
    val link by desk.link.collectAsState()
    val status by (link?.status ?: remember { kotlinx.coroutines.flow.MutableStateFlow<LinkStatus>(LinkStatus.Connecting) }).collectAsState()
    val state by desk.state.collectAsState()
    val viewer by desk.viewer.collectAsState()
    val frame by (link?.frames ?: remember { kotlinx.coroutines.flow.MutableStateFlow(null) }).collectAsState()
    val notices by desk.notices.collectAsState()
    val mode by desk.mode.collectAsState()
    val hazeState = remember { HazeState() }
    var keyboard by remember { mutableStateOf(false) }
    var control by remember { mutableStateOf<Page?>(null) }
    var browserSheet by remember { mutableStateOf(false) }
    val density = LocalDensity.current
    val configuration = LocalConfiguration.current

    // Pictures as wide as the screen's longer side, so they stay sharp when zoomed or turned sideways.
    LaunchedEffect(configuration.screenWidthDp, configuration.screenHeightDp) {
        desk.frameWidth = with(density) { (maxOf(configuration.screenWidthDp, configuration.screenHeightDp).dp.toPx() * 1.25f).toInt() }.coerceIn(640, 2560)
    }
    val current = viewer
    val shown = frame?.takeIf { current != null && it.profileId == current.profileId }
    LaunchedEffect(shown) { if (shown != null) desk.live() }
    val profile = state?.profiles?.firstOrNull { it.id == current?.profileId }
    val running = state?.running ?: emptyList()

    val landscape = configuration.screenWidthDp > configuration.screenHeightDp
    val activity = context as? android.app.Activity
    // Sideways, the page gets the whole screen: system bars hide and the glass floats over it.
    LaunchedEffect(landscape) {
        val window = activity?.window ?: return@LaunchedEffect
        val controller = androidx.core.view.WindowCompat.getInsetsController(window, window.decorView)
        if (landscape) {
            controller.systemBarsBehavior = androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(androidx.core.view.WindowInsetsCompat.Type.systemBars())
        } else controller.show(androidx.core.view.WindowInsetsCompat.Type.systemBars())
    }

    BoxWithConstraints(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        val top = if (landscape) 0f else with(density) { WindowInsets.statusBars.getTop(this).toFloat() + 64.dp.toPx() }
        val bottom = if (landscape) 0f else with(density) { WindowInsets.navigationBars.getBottom(this).toFloat() + 84.dp.toPx() }
        // The browser, the source the glass blurs.
        Box(Modifier.fillMaxSize().haze(hazeState)) {
            Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background))
            if (current != null) BrowserSurface(desk, shown, current.viewportW, keyboard, { keyboard = false }, top, bottom, Modifier.imePadding())
            if (current == null || shown == null) Placeholder(current?.status, current?.error, profile?.name, running.isEmpty() && state != null, top, bottom)
        }

        // Top: which browser, and its page; tap for its tabs and controls.
        Row(
            Modifier.align(Alignment.TopCenter).fillMaxWidth().statusBarsPadding().padding(horizontal = 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(
                Modifier.weight(1f, fill = false).height(48.dp).glassSurface(hazeState, RoundedCornerShape(24.dp))
                    .springClickable(enabled = current != null, pressedScale = 0.97f) { browserSheet = true }.padding(start = 8.dp, end = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (profile != null) Avatar(profile, 32.dp) else Box(Modifier.size(32.dp))
                Spacer(Modifier.width(10.dp))
                Column(Modifier.widthIn(max = 230.dp)) {
                    Text(profile?.name ?: state?.name ?: "Vela", fontSize = 14.5.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    val tab = current?.tabs?.firstOrNull { it.id == current.targetId }
                    Text(
                        tab?.let { it.url.removePrefix("https://").removePrefix("http://").substringBefore('/') }?.ifBlank { tab.title } ?: statusLine(status),
                        fontSize = 11.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            Spacer(Modifier.weight(0.001f).width(10.dp))
            ConnectionDot(status, hazeState)
            if (current != null) {
                Spacer(Modifier.width(8.dp))
                ModeSwitch(mode, hazeState) { desk.setViewMode(it) }
            }
            if (current != null && mode == "pc") {
                Spacer(Modifier.width(8.dp))
                Box(
                    Modifier.size(48.dp).glassSurface(hazeState, CircleShape).springClickable(pressedScale = 0.88f) {
                        activity?.requestedOrientation = if (landscape) android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT else android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                    },
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Rounded.ScreenRotation, tr("横屏", "Rotate"), tint = MaterialTheme.colorScheme.onSurface, modifier = Modifier.size(22.dp)) }
            }
            if (current != null && current.tabs.size > 1) {
                Spacer(Modifier.width(8.dp))
                Box(Modifier.size(48.dp).glassSurface(hazeState, CircleShape).springClickable(pressedScale = 0.88f) { browserSheet = true }, contentAlignment = Alignment.Center) {
                    Box(Modifier.size(22.dp).clip(RoundedCornerShape(6.dp)).background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f)), contentAlignment = Alignment.Center) {
                        Text(current.tabs.size.coerceAtMost(99).toString(), fontSize = 12.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurface)
                    }
                }
            }
        }

        // Notices: approvals wait for an answer; the rest leave on their own.
        Column(Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = 66.dp, start = 14.dp, end = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            notices.takeLast(2).forEach { notice -> NoticeCard(notice, hazeState, onOpen = { control = Page.Approvals; desk.dismiss(notice.id) }) }
        }

        BrowserDock(
            running = running,
            currentId = current?.profileId,
            approvals = state?.approvals ?: 0,
            keyboard = keyboard,
            hazeState = hazeState,
            onSelect = { keyboard = false; desk.select(it) },
            onMenu = { control = Page.Home },
            onKeyboard = { keyboard = !keyboard },
            onCurrent = { if (current != null) browserSheet = true },
            modifier = Modifier.align(Alignment.BottomCenter).navigationBarsPadding().imePadding().padding(start = 14.dp, end = 14.dp, bottom = if (landscape) 8.dp else 12.dp).widthIn(max = 560.dp),
        )

        FanWheel(state?.profiles ?: emptyList(), current?.profileId, hazeState, hint = running.isEmpty() && state != null, onPick = { keyboard = false; desk.select(it) })
    }

    control?.let { start -> ControlCenter(desk, state, viewer, start) { control = null } }
    if (browserSheet && current != null) BrowserSheet(desk, current, profile?.name ?: "", onDismiss = { browserSheet = false })
}

/**
 * Phone or PC: a small glass capsule, the active side filled ink. Phone mode lays pages out at a
 * phone's width by narrowing the real browser window; PC mode keeps the desktop page, scaled.
 */
@Composable
private fun ModeSwitch(mode: String, hazeState: HazeState, onChange: (String) -> Unit) {
    val colors = MaterialTheme.colorScheme
    Row(Modifier.height(48.dp).glassSurface(hazeState, CircleShape).padding(4.dp), horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
        listOf("phone" to (Icons.Rounded.Smartphone to tr("手机模式", "Phone mode")), "pc" to (Icons.Rounded.DesktopWindows to tr("PC 模式", "PC mode"))).forEach { (value, look) ->
            val on = mode == value
            val fill by androidx.compose.animation.animateColorAsState(if (on) colors.onSurface else Color.Transparent, label = "mode")
            val tint by androidx.compose.animation.animateColorAsState(if (on) colors.background else colors.onSurfaceVariant, label = "modeTint")
            Box(Modifier.size(40.dp).clip(CircleShape).background(fill).springClickable(pressedScale = 0.88f) { onChange(value) }, contentAlignment = Alignment.Center) {
                Icon(look.first, look.second, tint = tint, modifier = Modifier.size(20.dp))
            }
        }
    }
}

private fun statusLine(status: LinkStatus): String = when (status) {
    is LinkStatus.Ready -> tr("已连接", "Connected")
    is LinkStatus.Lost -> tr("连接断了，正在重连…", "Reconnecting…")
    LinkStatus.Connecting -> tr("正在连接…", "Connecting…")
    else -> ""
}

@Composable
private fun ConnectionDot(status: LinkStatus, hazeState: HazeState) {
    if (status is LinkStatus.Ready) return
    val pulse = rememberInfiniteTransition(label = "conn").animateFloat(0.35f, 1f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "a")
    Row(Modifier.height(48.dp).glassSurface(hazeState, RoundedCornerShape(24.dp)).padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).graphicsLayer { alpha = pulse.value }.clip(CircleShape).background(LocalStatus.current.warning))
        Spacer(Modifier.width(8.dp))
        Text(tr("重连中", "Reconnecting"), fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface)
    }
}

/** What fills the screen before there is a picture: starting, connecting, or nothing open yet. */
@Composable
private fun Placeholder(status: ViewStatus?, error: String?, name: String?, nothingRunning: Boolean, top: Float, bottom: Float) {
    val colors = MaterialTheme.colorScheme
    val density = LocalDensity.current
    Column(
        Modifier.fillMaxSize().padding(top = with(density) { top.toDp() }, bottom = with(density) { bottom.toDp() }).padding(horizontal = 40.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        when {
            status == ViewStatus.Failed -> {
                Icon(Icons.Rounded.ErrorOutline, null, tint = colors.error, modifier = Modifier.size(36.dp))
                Spacer(Modifier.height(14.dp))
                Text(tr("打不开这个浏览器", "Could not show this browser"), fontSize = 20.sp, fontWeight = FontWeight.Bold, fontFamily = TitleSerif, color = colors.onBackground)
                Spacer(Modifier.height(6.dp))
                Text(error ?: "", fontSize = 13.sp, color = colors.onSurfaceVariant, textAlign = TextAlign.Center)
            }
            status == ViewStatus.Starting || status == ViewStatus.Loading -> {
                CircularProgressIndicator(Modifier.size(30.dp), color = colors.onBackground, strokeWidth = 2.5.dp)
                Spacer(Modifier.height(18.dp))
                Text(if (status == ViewStatus.Starting) tr("正在启动 ${name ?: ""}", "Starting ${name ?: ""}") else tr("正在连接 ${name ?: ""}", "Connecting to ${name ?: ""}"), fontSize = 15.sp, color = colors.onSurfaceVariant, textAlign = TextAlign.Center)
            }
            status == ViewStatus.Ended -> Text(tr("这个浏览器已经关了", "This browser was closed"), fontSize = 15.sp, color = colors.onSurfaceVariant)
            nothingRunning -> {
                Text("Vela", fontFamily = WordmarkFont, fontSize = 56.sp, color = colors.onBackground.copy(alpha = 0.9f))
                Spacer(Modifier.height(16.dp))
                Text(tr("还没有打开的浏览器", "No browser is open"), fontSize = 20.sp, fontWeight = FontWeight.Bold, fontFamily = TitleSerif, color = colors.onBackground)
                Spacer(Modifier.height(8.dp))
                Text(tr("从屏幕右边缘往左拉，转动轮盘，点一个环境就会打开它。", "Pull from the right edge, turn the dial, and tap a profile to open it."), fontSize = 14.sp, lineHeight = 21.sp, color = colors.onSurfaceVariant, textAlign = TextAlign.Center)
            }
            else -> CircularProgressIndicator(Modifier.size(30.dp), color = colors.onBackground, strokeWidth = 2.5.dp)
        }
    }
}

@Composable
private fun NoticeCard(notice: Notice, hazeState: HazeState, onOpen: () -> Unit) {
    val context = LocalContext.current
    val desk = context.app.desk
    val scope = rememberCoroutineScope()
    val colors = MaterialTheme.colorScheme
    var visible by remember(notice.id) { mutableStateOf(false) }
    LaunchedEffect(notice.id) {
        visible = true
        if (notice.kind != "approval") { delay(5200); visible = false; delay(300); desk.dismiss(notice.id) }
    }
    AnimatedVisibility(visible, enter = slideInVertically(spring(0.78f, 380f)) { -it } + fadeIn(), exit = slideOutVertically { -it / 2 } + fadeOut()) {
        Column(Modifier.fillMaxWidth().glassSurface(hazeState, RoundedCornerShape(22.dp)).springClickable(pressedScale = 0.98f) { if (notice.kind == "approval") onOpen() else desk.dismiss(notice.id) }.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    when (notice.kind) { "approval" -> Icons.Rounded.Shield; "error" -> Icons.Rounded.ErrorOutline; else -> Icons.Rounded.CheckCircle },
                    null, tint = when (notice.kind) { "approval" -> LocalStatus.current.warning; "error" -> colors.error; else -> LocalStatus.current.running }, modifier = Modifier.size(22.dp),
                )
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(notice.title, fontSize = 14.5.sp, fontWeight = FontWeight.Bold, color = colors.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (notice.detail.isNotBlank()) Text(notice.detail, fontSize = 12.5.sp, color = colors.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
            if (notice.kind == "approval" && notice.approvalId != null) {
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(true to tr("允许", "Allow"), false to tr("拒绝", "Refuse")).forEach { (allow, label) ->
                        Text(label, fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold, color = if (allow) colors.background else colors.onSurface,
                            modifier = Modifier.clip(RoundedCornerShape(16.dp)).background(if (allow) colors.onSurface else colors.onSurface.copy(alpha = 0.08f))
                                .springClickable(pressedScale = 0.94f) {
                                    scope.launch {
                                        runCatching { desk.call("approval.answer", JSONObject().put("kind", notice.approvalKind).put("id", notice.approvalId).put("allow", allow)) }
                                            .onFailure { desk.notify("error", tr("没能提交", "Could not answer"), it.message ?: "") }
                                        desk.dismiss(notice.id); desk.refresh()
                                    }
                                }.padding(horizontal = 16.dp, vertical = 8.dp))
                    }
                    Spacer(Modifier.weight(1f))
                    Text(tr("详情", "Details"), fontSize = 13.sp, color = colors.onSurfaceVariant, modifier = Modifier.springClickable(onClick = onOpen).padding(8.dp))
                }
            }
        }
    }
}

package app.vela.mobile.ui.main

import app.vela.mobile.ui.theme.TitleSerif
import app.vela.mobile.ui.theme.LocalStatus
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.ui.layout.layout
import androidx.compose.foundation.systemGestureExclusion
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.vela.mobile.Profile
import app.vela.mobile.tr
import app.vela.mobile.ui.theme.glassSurface
import app.vela.mobile.ui.theme.springClickable
import dev.chrisbanes.haze.HazeState
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlinx.coroutines.launch

private const val STEP = 0.24f // radians between two profiles on the dial

/**
 * Every profile on a dial that slides out of the right edge. Pull the thin handle at the edge
 * to open it; drag up and down to turn it; the profile pointing left (the largest one) is named
 * beside it, and a tap on it opens that browser (starting it when closed).
 */
@Composable
fun FanWheel(
    profiles: List<Profile>,
    currentId: String?,
    hazeState: HazeState,
    hint: Boolean,
    onPick: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = MaterialTheme.colorScheme
    val density = LocalDensity.current
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val open = remember { Animatable(0f) }
    var runningOnly by remember { mutableStateOf(false) }
    // Running ones first, then the rest by group.
    val ordered = remember(profiles, runningOnly) {
        profiles.filter { !runningOnly || it.running }.sortedWith(compareByDescending<Profile> { it.running }.thenBy { it.group }.thenBy { it.name })
    }
    val rotation = remember { Animatable(0f) }
    val latest by rememberUpdatedState(ordered)
    var lastCell by remember { mutableIntStateOf(0) }
    LaunchedEffect(open.targetValue == 1f) {
        if (open.targetValue == 1f) rotation.snapTo(ordered.indexOfFirst { it.id == currentId }.coerceAtLeast(0).toFloat())
    }
    fun close() = scope.launch { open.animateTo(0f, spring(0.9f, 420f)) }
    BackHandler(open.value > 0.01f) { close() }

    BoxWithConstraints(modifier.fillMaxSize()) {
        val w = constraints.maxWidth.toFloat()
        val h = constraints.maxHeight.toFloat()
        val radius = min(w * 0.94f, with(density) { 480.dp.toPx() })
        val center = Offset(w + radius * 0.2f, h * 0.5f)
        val itemRadius = radius * 0.80f
        val p = open.value

        if (p > 0.001f) {
            // Scrim: tap anywhere outside to close.
            Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.32f * p)).pointerInput(Unit) { detectTapGestures { close() } })
            val slide = (1f - p) * radius * 0.95f
            // The dial: a disc of glass, mostly beyond the right edge.
            Box(
                Modifier
                    // Wider than the screen on purpose: measured at its own size, not squeezed to the screen's width.
                    .layout { measurable, constraints ->
                        val side = (radius * 2).roundToInt()
                        val placeable = measurable.measure(androidx.compose.ui.unit.Constraints.fixed(side, side))
                        layout(constraints.maxWidth, constraints.maxHeight) { placeable.place((center.x - radius + slide).roundToInt(), (center.y - radius).roundToInt()) }
                    }
                    .glassSurface(hazeState, CircleShape)
                    .pointerInput(Unit) {
                        val tracker = VelocityTracker()
                        detectVerticalDragGestures(
                            onDragStart = { tracker.resetTracking(); lastCell = rotation.value.roundToInt() },
                            onDragEnd = {
                                val v = tracker.calculateVelocity().y / (itemRadius * STEP)
                                val target = (rotation.value + v * 0.18f).roundToInt().coerceIn(0, (latest.size - 1).coerceAtLeast(0))
                                scope.launch { rotation.animateTo(target.toFloat(), spring(0.8f, 220f)) }
                            },
                            onVerticalDrag = { change, dy ->
                                change.consume()
                                tracker.addPosition(change.uptimeMillis, change.position)
                                val next = (rotation.value + dy / (itemRadius * STEP)).coerceIn(-0.4f, latest.size - 0.6f)
                                scope.launch { rotation.snapTo(next) }
                                val cell = next.roundToInt().coerceIn(0, (latest.size - 1).coerceAtLeast(0))
                                if (cell != lastCell) { lastCell = cell; haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove) }
                            },
                        )
                    }
                    .pointerInput(Unit) {
                        detectTapGestures { tap ->
                            // Which profile is under the finger, measured in the disc's own coordinates.
                            val local = Offset(tap.x - radius, tap.y - radius)
                            val angle = kotlin.math.atan2(local.y, local.x).let { if (it < 0) it + 2 * PI.toFloat() else it }
                            val dist = kotlin.math.hypot(local.x, local.y)
                            if (abs(dist - itemRadius) < with(density) { 34.dp.toPx() }) {
                                val index = (rotation.value + (angle - PI.toFloat()) / STEP).roundToInt()
                                val profile = latest.getOrNull(index) ?: return@detectTapGestures
                                if (index == rotation.value.roundToInt()) { onPick(profile.id); close() }
                                else scope.launch { rotation.animateTo(index.toFloat(), spring(0.8f, 300f)) }
                            } else if (dist < itemRadius) {
                                latest.getOrNull(rotation.value.roundToInt())?.let { onPick(it.id); close() }
                            }
                        }
                    },
            ) {
                val base = with(density) { 48.dp.toPx() }
                latest.forEachIndexed { i, profile ->
                    val d = i - rotation.value
                    if (abs(d) > 6.5f) return@forEachIndexed
                    val angle = PI.toFloat() + d * STEP
                    val x = radius + itemRadius * cos(angle)
                    val y = radius + itemRadius * sin(angle)
                    val focus = (1f - abs(d)).coerceIn(0f, 1f)
                    val scale = (1.25f - 0.11f * abs(d)).coerceAtLeast(0.55f) + 0.15f * focus
                    Box(
                        Modifier
                            .offset { IntOffset((x - base / 2).roundToInt(), (y - base / 2).roundToInt()) }
                            .size(48.dp)
                            .graphicsLayer { scaleX = scale; scaleY = scale; alpha = (1.1f - abs(d) * 0.16f).coerceIn(0.15f, 1f) },
                    ) {
                        Avatar(profile, 48.dp, ring = profile.id == currentId)
                        if (profile.running) Box(
                            Modifier.align(Alignment.BottomEnd).size(13.dp).clip(CircleShape).background(colors.surface).padding(2.dp).clip(CircleShape).background(LocalStatus.current.running),
                        )
                    }
                }
                // The name of the profile pointing left, beside it inside the disc.
                latest.getOrNull(rotation.value.roundToInt().coerceIn(0, (latest.size - 1).coerceAtLeast(0)))?.let { focused ->
                    Column(
                        Modifier
                            .offset { IntOffset((radius - itemRadius + base * 0.95f).roundToInt(), (radius - with(density) { 46.dp.toPx() }).roundToInt()) }
                            .width(with(density) { (w - (center.x - itemRadius + base * 0.95f) - 22.dp.toPx()).coerceAtLeast(60f).toDp() }),
                    ) {
                        Text(focused.name, color = colors.onSurface, fontSize = 22.sp, fontWeight = FontWeight.Bold, fontFamily = TitleSerif, maxLines = 2, overflow = TextOverflow.Ellipsis, lineHeight = 26.sp)
                        Spacer(Modifier.height(4.dp))
                        Text(focused.group.ifBlank { tr("未分组", "No group") }, color = colors.onSurfaceVariant, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Spacer(Modifier.height(10.dp))
                        Text(
                            when {
                                focused.id == currentId -> tr("正在看", "Showing now")
                                focused.running -> tr("运行中 · 点按切换", "Running · tap to switch")
                                else -> tr("已关闭 · 点按打开", "Closed · tap to open")
                            },
                            color = if (focused.running) LocalStatus.current.runningInk else colors.onSurfaceVariant, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                        )
                    }
                }
                if (latest.isEmpty()) Text(tr("没有运行中的环境", "Nothing running"), color = colors.onSurfaceVariant, fontSize = 15.sp, textAlign = TextAlign.Center,
                    modifier = Modifier.offset { IntOffset((radius - itemRadius).roundToInt(), (radius - 20.dp.toPx()).roundToInt()) })
            }
            // All, or only the running ones.
            Row(
                Modifier.align(Alignment.BottomEnd).navigationBarsPadding().padding(bottom = 96.dp, end = 18.dp).graphicsLayer { alpha = p; translationX = slide * 0.3f }
                    .glassSurface(hazeState, RoundedCornerShape(20.dp)).padding(4.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                listOf(false to tr("全部 ${profiles.size}", "All ${profiles.size}"), true to tr("运行中 ${profiles.count { it.running }}", "Running ${profiles.count { it.running }}")).forEach { (value, label) ->
                    val on = runningOnly == value
                    Text(label, fontSize = 13.sp, fontWeight = if (on) FontWeight.Bold else FontWeight.Medium,
                        color = if (on) colors.background else colors.onSurface,
                        modifier = Modifier.clip(RoundedCornerShape(16.dp)).background(if (on) colors.onSurface else Color.Transparent)
                            .springClickable(pressedScale = 0.94f) { runningOnly = value; scope.launch { rotation.snapTo(0f) } }.padding(horizontal = 12.dp, vertical = 7.dp))
                }
            }
        }

        // The handle: a thin sliver of glass on the right edge; pull it to bring the dial out.
        val pulse = rememberInfiniteTransition(label = "hint").animateFloat(0f, 1f, infiniteRepeatable(tween(1300), RepeatMode.Reverse), label = "nudge")
        if (p < 0.99f) Box(
            // Android lets an app take the edge back from the back gesture for 200 dp; the handle stays inside that.
            Modifier.align(Alignment.CenterEnd).width(32.dp).height(190.dp).systemGestureExclusion()
                .pointerInput(Unit) {
                    var pulled = 0f
                    detectHorizontalDragGestures(
                        onDragStart = { pulled = 0f },
                        onDragEnd = { scope.launch { open.animateTo(if (open.value > 0.28f) 1f else 0f, spring(0.78f, 300f)) }; if (open.value > 0.28f) haptics.performHapticFeedback(HapticFeedbackType.LongPress) },
                        onDragCancel = { scope.launch { open.animateTo(0f) } },
                        onHorizontalDrag = { change, dx -> change.consume(); pulled -= dx; scope.launch { open.snapTo((pulled / (radius * 0.55f)).coerceIn(0f, 1f)) } },
                    )
                }
                .pointerInput(Unit) { detectTapGestures { scope.launch { open.animateTo(1f, spring(0.78f, 300f)) } } },
            contentAlignment = Alignment.CenterEnd,
        ) {
            Box(
                Modifier.padding(end = 3.dp).size(6.dp, 58.dp)
                    .graphicsLayer { translationX = if (hint) -6.dp.toPx() * pulse.value else 0f; alpha = 1f - p }
                    .glassSurface(hazeState, RoundedCornerShape(3.dp)),
            )
        }
    }
}

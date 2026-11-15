package app.vela.mobile.ui.main

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.GridView
import androidx.compose.material.icons.rounded.Keyboard
import androidx.compose.material.icons.rounded.KeyboardHide
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.vela.mobile.Profile
import app.vela.mobile.tr
import app.vela.mobile.ui.theme.LocalDarkTheme
import app.vela.mobile.ui.theme.glassSurface
import app.vela.mobile.ui.theme.springClickable
import dev.chrisbanes.haze.HazeState
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlinx.coroutines.launch

val DockHeight = 60.dp

/** A profile's mark: its first letter on a soft colour picked from its group, the same on every screen. */
@Composable
fun Avatar(profile: Profile, size: androidx.compose.ui.unit.Dp, modifier: Modifier = Modifier, ring: Boolean = false) {
    val dark = LocalDarkTheme.current
    val hue = (abs((profile.group.ifBlank { profile.name }).hashCode()) % 360).toFloat()
    val fill = Color.hsl(hue, if (dark) 0.32f else 0.45f, if (dark) 0.32f else 0.88f)
    val ink = Color.hsl(hue, 0.5f, if (dark) 0.86f else 0.26f)
    Box(
        modifier.size(size).clip(CircleShape).background(fill)
            .then(if (ring) Modifier.border(2.dp, MaterialTheme.colorScheme.onBackground, CircleShape) else Modifier),
        contentAlignment = Alignment.Center,
    ) {
        Text(profile.name.trim().take(1).uppercase().ifBlank { "·" }, color = ink, fontWeight = FontWeight.Bold, fontSize = (size.value * 0.42f).sp)
    }
}

/**
 * The bottom dock: the control centre on the left, the keyboard on the right, and between them
 * the running browsers on a strip of glass. Swipe the strip to move to the next browser; the one
 * in the middle is the one shown. Neighbours peek in at the edges, smaller and fainter.
 */
@Composable
fun BrowserDock(
    running: List<Profile>,
    currentId: String?,
    approvals: Int,
    keyboard: Boolean,
    hazeState: HazeState,
    onSelect: (String) -> Unit,
    onMenu: () -> Unit,
    onKeyboard: () -> Unit,
    onCurrent: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = MaterialTheme.colorScheme
    Row(modifier.fillMaxWidth().height(DockHeight), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        Box {
            Box(Modifier.size(DockHeight).glassSurface(hazeState, CircleShape).springClickable(pressedScale = 0.88f, onClick = onMenu), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.GridView, tr("控制中心", "Control centre"), tint = colors.onSurface, modifier = Modifier.size(24.dp))
            }
            if (approvals > 0) Box(
                Modifier.align(Alignment.TopEnd).offset(2.dp, (-2).dp).size(20.dp).clip(CircleShape).background(MaterialTheme.colorScheme.onSurface),
                contentAlignment = Alignment.Center,
            ) { Text(approvals.coerceAtMost(9).toString(), color = MaterialTheme.colorScheme.background, fontSize = 11.sp, fontWeight = FontWeight.Bold) }
        }
        BrowserStrip(running, currentId, hazeState, onSelect, onCurrent, Modifier.weight(1f))
        Box(Modifier.size(DockHeight).glassSurface(hazeState, CircleShape).springClickable(pressedScale = 0.88f, onClick = onKeyboard), contentAlignment = Alignment.Center) {
            Icon(if (keyboard) Icons.Rounded.KeyboardHide else Icons.Rounded.Keyboard, tr("键盘", "Keyboard"), tint = colors.onSurface, modifier = Modifier.size(24.dp))
        }
    }
}

@Composable
private fun BrowserStrip(running: List<Profile>, currentId: String?, hazeState: HazeState, onSelect: (String) -> Unit, onCurrent: () -> Unit, modifier: Modifier) {
    val colors = MaterialTheme.colorScheme
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    val index = running.indexOfFirst { it.id == currentId }.coerceAtLeast(0)
    // Position on the strip in items; follows the finger, then springs to a whole item.
    val position = remember { Animatable(index.toFloat()) }
    val latestRunning by rememberUpdatedState(running)
    val latestSelect by rememberUpdatedState(onSelect)
    var dragging by remember { androidx.compose.runtime.mutableStateOf(false) }
    LaunchedEffect(index, running.size) { if (!dragging) position.animateTo(index.toFloat(), spring(0.78f, 380f)) }
    val shape = androidx.compose.foundation.shape.RoundedCornerShape(DockHeight / 2)

    BoxWithConstraints(modifier.fillMaxHeight().glassSurface(hazeState, shape).clip(shape)) {
        val widthPx = constraints.maxWidth.toFloat()
        val itemPx = widthPx * 0.74f
        if (running.isEmpty()) {
            Text(tr("没有打开的浏览器", "No browser open"), color = colors.onSurfaceVariant, fontSize = 14.sp, modifier = Modifier.align(Alignment.Center))
            return@BoxWithConstraints
        }
        var lastCell by remember { mutableIntStateOf(index) }
        Box(
            Modifier.fillMaxWidth().fillMaxHeight()
                .pointerInput(running.map { it.id }) {
                    var velocity = 0f
                    var startCell = 0
                    detectHorizontalDragGestures(
                        onDragStart = { dragging = true; velocity = 0f; lastCell = position.value.roundToInt(); startCell = lastCell },
                        onDragEnd = {
                            dragging = false
                            val list = latestRunning
                            // Where the finger left it; a quick flick that did not get there still moves one browser on.
                            var target = position.value.roundToInt()
                            if (target == startCell && abs(velocity) > 1.2f) target = startCell + if (velocity < 0) 1 else -1
                            target = target.coerceIn(0, list.lastIndex)
                            scope.launch { position.animateTo(target.toFloat(), spring(0.72f, 360f)) }
                            list.getOrNull(target)?.let { if (it.id != currentId) latestSelect(it.id) }
                        },
                        onDragCancel = { dragging = false; scope.launch { position.animateTo(position.value.roundToInt().toFloat(), spring(0.72f, 360f)) } },
                        onHorizontalDrag = { change, dx ->
                            change.consume()
                            val step = -dx / itemPx
                            velocity = velocity * 0.5f + (dx / itemPx) * 0.5f * 60f
                            // A little give past the ends.
                            val raw = position.value + step
                            val bounded = if (raw < 0f) raw * 0.35f else if (raw > latestRunning.lastIndex) latestRunning.lastIndex + (raw - latestRunning.lastIndex) * 0.35f else raw
                            scope.launch { position.snapTo(bounded) }
                            val cell = bounded.roundToInt().coerceIn(0, latestRunning.lastIndex)
                            if (cell != lastCell) { lastCell = cell; haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove) }
                        },
                    )
                }
                .pointerInput(running.map { it.id }) {
                    detectTapGestures { tap ->
                        val offset = (tap.x - widthPx / 2f) / itemPx
                        val tapped = (position.value + offset).roundToInt().coerceIn(0, latestRunning.lastIndex)
                        if (abs(offset) < 0.4f) onCurrent()
                        else latestRunning.getOrNull(tapped)?.let { latestSelect(it.id) }
                    }
                },
        ) {
            running.forEachIndexed { i, profile ->
                val distance = i - position.value
                if (abs(distance) > 1.6f) return@forEachIndexed
                val near = (1f - abs(distance).coerceAtMost(1f))
                Row(
                    Modifier
                        .align(Alignment.Center)
                        .widthIn(max = with(density) { itemPx.toDp() })
                        .graphicsLayer {
                            translationX = distance * itemPx
                            val s = 0.82f + 0.18f * near
                            scaleX = s; scaleY = s
                            alpha = 0.35f + 0.65f * near
                        }
                        .padding(horizontal = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Avatar(profile, 34.dp)
                    Spacer(Modifier.width(10.dp))
                    Column {
                        Text(profile.name, color = colors.onSurface, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(profile.group.ifBlank { tr("未分组", "No group") }, color = colors.onSurfaceVariant, fontSize = 11.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            // Where you are among the open browsers.
            if (running.size > 1) Row(Modifier.align(Alignment.BottomCenter).padding(bottom = 5.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                val shown = running.size.coerceAtMost(9)
                repeat(shown) { dot ->
                    val active = (position.value.roundToInt().coerceIn(0, running.lastIndex) * shown / running.size) == dot
                    Box(Modifier.size(if (active) 12.dp else 4.dp, 4.dp).clip(CircleShape).background(colors.onSurface.copy(alpha = if (active) 0.7f else 0.22f)))
                }
            }
        }
    }
}

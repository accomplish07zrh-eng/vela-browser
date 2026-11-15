package app.vela.mobile.ui.main

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import app.vela.mobile.Desk
import app.vela.mobile.net.Frame
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * The browser in use, drawn edge to edge, and touch turned into its mouse:
 * tap = click; drag = scroll; hold = right-click, or hold then move = drag with the button down
 * (sliders, drag-and-drop); two fingers zoom and move the picture here without touching the page.
 */
@Composable
fun BrowserSurface(
    desk: Desk,
    frame: Frame?,
    viewportW: Int,
    keyboard: Boolean,
    onKeyboardClosed: () -> Unit,
    topInset: Float,
    bottomInset: Float,
    modifier: Modifier = Modifier,
) {
    val haptics = LocalHapticFeedback.current
    val slop = LocalViewConfiguration.current.touchSlop
    val scope = rememberCoroutineScope()
    val zoom = remember { Animatable(1f) }
    var pan by remember { mutableStateOf(Offset.Zero) }
    val currentFrame by rememberUpdatedState(frame)
    val cssWidth by rememberUpdatedState(viewportW)

    BoxWithConstraints(modifier.fillMaxSize()) {
        val boxW = constraints.maxWidth.toFloat()
        val boxH = constraints.maxHeight.toFloat()
        val usableH = (boxH - topInset - bottomInset).coerceAtLeast(1f)

        // Where the picture sits at zoom 1: fit to width, or to the free height for tall (phone-shaped) pages.
        fun layout(f: Frame): Triple<Float, Float, Float> {
            val w = f.bitmap.width.toFloat(); val h = f.bitmap.height.toFloat()
            val scale = min(boxW / w, usableH / h).let { fit -> if (h * (boxW / w) <= usableH) boxW / w else fit }
            val left = (boxW - w * scale) / 2f
            val top = topInset + (usableH - h * scale) / 2f
            return Triple(scale, left, top)
        }

        /** A point on the screen to the page's own coordinates (CSS pixels). */
        fun toPage(p: Offset): Offset? {
            val f = currentFrame ?: return null
            val (scale, left, top) = layout(f)
            val z = zoom.value
            val cx = boxW / 2f; val cy = topInset + usableH / 2f
            // Undo the local zoom (about the centre of the free area) and pan.
            val sx = (p.x - pan.x - cx) / z + cx
            val sy = (p.y - pan.y - cy) / z + cy
            val fx = (sx - left) / scale; val fy = (sy - top) / scale
            if (fx < 0 || fy < 0 || fx > f.bitmap.width || fy > f.bitmap.height) return null
            val ratio = if (cssWidth > 0) cssWidth.toFloat() / f.bitmap.width else 1f
            return Offset(fx * ratio, fy * ratio)
        }

        fun pixelsToPage(): Float {
            val f = currentFrame ?: return 1f
            val ratio = if (cssWidth > 0) cssWidth.toFloat() / f.bitmap.width else 1f
            return ratio / (layout(f).first * zoom.value)
        }

        fun clampPan(value: Offset, z: Float): Offset {
            val maxX = boxW * (z - 1f) / 2f
            val maxY = usableH * (z - 1f) / 2f
            return Offset(value.x.coerceIn(-maxX, maxX), value.y.coerceIn(-maxY, maxY))
        }

        // Touch is read on an untransformed layer; only the picture below is zoomed and moved.
        Box(
            Modifier.fillMaxSize()
                .pointerInput(Unit) {
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false)
                        val start = down.position
                        val holdAt = System.currentTimeMillis() + 480L
                        var mode = "tap" // tap, scroll, pinch, hold, drag
                        var last = start
                        var holdPage: Offset? = null
                        while (true) {
                            val event = withTimeoutOrNull(if (mode == "tap") max(1L, holdAt - System.currentTimeMillis()) else Long.MAX_VALUE) {
                                awaitPointerEvent(PointerEventPass.Main)
                            }
                            if (event == null) {
                                // Held still: right-click when let go, or a drag if the finger moves.
                                if (mode == "tap") {
                                    mode = "hold"
                                    holdPage = toPage(start)
                                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                }
                                continue
                            }
                            val pressed = event.changes.filter { it.pressed }
                            if (pressed.size >= 2 && mode in setOf("tap", "scroll", "hold")) mode = "pinch"
                            if (mode == "pinch") {
                                if (pressed.size < 2) { if (pressed.isEmpty()) break else continue }
                                val factor = event.calculateZoom()
                                val centroid = event.calculateCentroid()
                                val next = (zoom.value * factor).coerceIn(1f, 5f)
                                val applied = next / zoom.value
                                val cx = boxW / 2f; val cy = topInset + usableH / 2f
                                // Zoom about the fingers: keep the point under them still.
                                val newPan = (pan + event.calculatePan()) * 1f + (Offset(centroid.x - cx, centroid.y - cy) - pan) * (1 - applied)
                                scope.launch { zoom.snapTo(next) }
                                pan = clampPan(newPan, next)
                                event.changes.forEach { if (it.positionChanged()) it.consume() }
                                continue
                            }
                            val change = event.changes.firstOrNull { it.id == down.id } ?: break
                            if (!change.pressed) {
                                when (mode) {
                                    "tap" -> toPage(start)?.let { desk.tap(it.x, it.y) }
                                    "hold" -> holdPage?.let { desk.tap(it.x, it.y, "right") }
                                    "drag" -> toPage(change.position)?.let { desk.release(it.x, it.y) } ?: holdPage?.let { desk.release(it.x, it.y) }
                                }
                                change.consume()
                                break
                            }
                            val moved = change.position - start
                            if (mode == "tap" && (abs(moved.x) > slop || abs(moved.y) > slop)) mode = "scroll"
                            if (mode == "hold" && (abs(moved.x) > slop || abs(moved.y) > slop)) {
                                mode = "drag"
                                holdPage?.let { desk.press(it.x, it.y) }
                            }
                            if (mode == "scroll") {
                                val delta = change.position - last
                                val at = toPage(change.position) ?: toPage(start)
                                if (at != null && (delta.x != 0f || delta.y != 0f)) {
                                    val k = pixelsToPage()
                                    desk.scroll(at.x, at.y, -delta.x * k, -delta.y * k)
                                }
                            }
                            if (mode == "drag") toPage(change.position)?.let { desk.drag(it.x, it.y) }
                            last = change.position
                            change.consume()
                        }
                        // Let go of a zoom close to 1: snap back to the fitted picture.
                        if (mode == "pinch" && zoom.value < 1.12f) scope.launch {
                            zoom.animateTo(1f, spring(0.8f, 380f)); pan = Offset.Zero
                        }
                    }
                },
        )
        Canvas(
            Modifier.fillMaxSize().graphicsLayer {
                scaleX = zoom.value; scaleY = zoom.value
                translationX = pan.x; translationY = pan.y
                transformOrigin = androidx.compose.ui.graphics.TransformOrigin(0.5f, (topInset + usableH / 2f) / boxH.coerceAtLeast(1f))
            },
        ) {
            val f = frame ?: return@Canvas
            val (scale, left, top) = layout(f)
            drawImage(
                f.bitmap.asImageBitmap(),
                dstOffset = IntOffset(left.roundToInt(), top.roundToInt()),
                dstSize = IntSize((f.bitmap.width * scale).roundToInt(), (f.bitmap.height * scale).roundToInt()),
                filterQuality = FilterQuality.Medium,
            )
        }
        KeyboardBridge(desk, keyboard, onKeyboardClosed)
    }
}

private const val SENTINEL = "​​​​"

/**
 * An invisible text field that the phone's keyboard types into. What is typed (after the input
 * method commits it, so pinyin works) is sent as text; deleting sends Backspace, a new line Enter.
 */
@Composable
private fun KeyboardBridge(desk: Desk, open: Boolean, onClosed: () -> Unit) {
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    var value by remember { mutableStateOf(TextFieldValue(SENTINEL, TextRange(SENTINEL.length))) }
    var focused by remember { mutableStateOf(false) }
    LaunchedEffect(open) {
        if (open) { focus.requestFocus(); keyboard?.show() } else if (focused) { keyboard?.hide(); focus.freeFocus() }
    }
    BasicTextField(
        value = value,
        onValueChange = { next ->
            if (next.composition != null) { value = next; return@BasicTextField }
            val text = next.text
            when {
                text.startsWith(SENTINEL) -> {
                    val added = text.removePrefix(SENTINEL)
                    added.split('\n').forEachIndexed { i, part ->
                        if (i > 0) desk.key("Enter", "Enter", 13)
                        desk.type(part)
                    }
                }
                text.length < SENTINEL.length && SENTINEL.startsWith(text) -> repeat(SENTINEL.length - text.length) { desk.key("Backspace", "Backspace", 8) }
                else -> desk.type(text.replace("​", ""))
            }
            value = TextFieldValue(SENTINEL, TextRange(SENTINEL.length))
        },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text, imeAction = ImeAction.Go, autoCorrectEnabled = false),
        keyboardActions = KeyboardActions(onGo = { desk.key("Enter", "Enter", 13) }),
        modifier = Modifier.size(1.dp).graphicsLayer { alpha = 0f }.focusRequester(focus)
            // A hardware keyboard's keys that type nothing: Enter, Tab, Escape and the arrows.
            .onPreviewKeyEvent { event ->
                val native = event.nativeKeyEvent
                if (native.action != android.view.KeyEvent.ACTION_DOWN) return@onPreviewKeyEvent false
                val mapped = when (native.keyCode) {
                    android.view.KeyEvent.KEYCODE_ENTER, android.view.KeyEvent.KEYCODE_NUMPAD_ENTER -> Triple("Enter", "Enter", 13)
                    android.view.KeyEvent.KEYCODE_TAB -> Triple("Tab", "Tab", 9)
                    android.view.KeyEvent.KEYCODE_ESCAPE -> Triple("Escape", "Escape", 27)
                    android.view.KeyEvent.KEYCODE_DPAD_UP -> Triple("ArrowUp", "ArrowUp", 38)
                    android.view.KeyEvent.KEYCODE_DPAD_DOWN -> Triple("ArrowDown", "ArrowDown", 40)
                    android.view.KeyEvent.KEYCODE_DPAD_LEFT -> Triple("ArrowLeft", "ArrowLeft", 37)
                    android.view.KeyEvent.KEYCODE_DPAD_RIGHT -> Triple("ArrowRight", "ArrowRight", 39)
                    else -> null
                } ?: return@onPreviewKeyEvent false
                desk.key(mapped.first, mapped.second, mapped.third, if (native.isShiftPressed) 8 else 0)
                true
            }
            .onFocusChanged {
            if (focused && !it.isFocused) onClosed()
            focused = it.isFocused
        },
        cursorBrush = androidx.compose.ui.graphics.SolidColor(Color.Transparent),
    )
}

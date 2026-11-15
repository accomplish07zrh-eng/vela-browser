package app.vela.mobile.ui.pair

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Backspace
import androidx.compose.material.icons.rounded.Computer
import androidx.compose.material.icons.rounded.QrCodeScanner
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.vela.mobile.app
import app.vela.mobile.net.FoundComputer
import app.vela.mobile.net.Pairing
import app.vela.mobile.net.PairingError
import app.vela.mobile.tr
import app.vela.mobile.ui.theme.GlassCircleButton
import app.vela.mobile.ui.theme.LocalDarkTheme
import app.vela.mobile.ui.theme.TitleSerif
import app.vela.mobile.ui.theme.filledField
import app.vela.mobile.ui.theme.WordmarkFont
import app.vela.mobile.ui.theme.enterRise
import app.vela.mobile.ui.theme.floatingCard
import app.vela.mobile.ui.theme.springClickable
import kotlinx.coroutines.launch

private sealed interface Step {
    data object Home : Step
    data object Scan : Step
    data class Pin(val computer: FoundComputer) : Step
    data class Waiting(val code: String, val computer: FoundComputer) : Step
    data class Busy(val text: String) : Step
}

private fun pairingMessage(error: Throwable): String = when (error.message) {
    "wrong-pin" -> tr("PIN 不对，再看一眼电脑上的数字", "Wrong PIN: check the digits on the computer")
    "too-many" -> tr("试太多次了，稍等一分钟，或在电脑上换一个码", "Too many tries: wait a minute, or show a new code on the computer")
    "denied" -> tr("电脑上点了拒绝", "Refused on the computer")
    "expired" -> tr("等太久了，请重新配对", "That took too long: pair again")
    "unreachable" -> tr("连不上这个地址。确认电脑开着「允许手机连接」，并且和手机在同一个 Wi-Fi", "Can't reach that address. Check that phones may connect on the computer, on the same Wi-Fi")
    else -> if (error is java.io.IOException) tr("连不上电脑。确认电脑上开着「允许手机连接」，并且和手机在同一个 Wi-Fi。", "Can't reach the computer. Check that phones may connect, on the same Wi-Fi.")
        else error.message ?: tr("配对失败", "Pairing failed")
}

@Composable
fun PairScreen(notice: String? = null, debugQr: String? = null) {
    val context = LocalContext.current
    val desk = context.app.desk
    val scope = rememberCoroutineScope()
    var step by remember { mutableStateOf<Step>(Step.Home) }
    var error by remember { mutableStateOf(notice) }
    BackHandler(step !is Step.Home) { step = Step.Home }

    fun scanned(text: String) {
        val qr = Pairing.parseQr(text)
        if (qr == null) { error = tr("这不是 Vela Browser 的配对码", "That is not a Vela Browser pairing code"); step = Step.Home; return }
        step = Step.Busy(tr("正在和 ${qr.name.ifBlank { "电脑" }} 配对…", "Pairing with ${qr.name.ifBlank { "the computer" }}…"))
        scope.launch {
            try { desk.paired(Pairing.pairWithQr(qr)) }
            catch (e: Exception) { error = pairingMessage(e); step = Step.Home }
        }
    }

    // Debug builds only: a pairing link handed in by adb stands in for the camera.
    LaunchedEffect(debugQr) { if (debugQr != null) scanned(debugQr) }

    AnimatedContent(step, label = "pair", transitionSpec = { (fadeIn(tween(240)) + scaleIn(spring(0.85f, 380f), 0.97f)) togetherWith fadeOut(tween(160)) }) { current ->
        when (current) {
            Step.Home -> PairHome(error, onScan = { error = null; step = Step.Scan }, onPick = { error = null; step = Step.Pin(it) }, onError = { error = it })
            Step.Scan -> Scanner(onCode = ::scanned, onClose = { step = Step.Home })
            is Step.Pin -> PinEntry(current.computer, error, onBack = { step = Step.Home }) { pin ->
                step = Step.Busy(tr("正在连接…", "Connecting…"))
                scope.launch {
                    try {
                        val waiting = Pairing.pairWithPin(current.computer.host, current.computer.port, pin)
                        step = Step.Waiting(waiting.code, current.computer)
                        desk.paired(Pairing.awaitDecision(waiting))
                    } catch (e: Exception) {
                        error = pairingMessage(e)
                        step = if (e is PairingError && (e.message == "wrong-pin" || e.message == "too-many")) Step.Pin(current.computer) else Step.Home
                    }
                }
            }
            is Step.Waiting -> WaitingForYes(current.code, current.computer.name)
            is Step.Busy -> Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    CircularProgressIndicator(Modifier.size(34.dp), color = MaterialTheme.colorScheme.onBackground, strokeWidth = 3.dp)
                    Spacer(Modifier.height(18.dp))
                    Text(current.text, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 15.sp)
                }
            }
        }
    }
}

@Composable
private fun PairHome(error: String?, onScan: () -> Unit, onPick: (FoundComputer) -> Unit, onError: (String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var found by remember { mutableStateOf<List<FoundComputer>>(emptyList()) }
    var searching by remember { mutableStateOf(true) }
    var typing by remember { mutableStateOf(false) }
    var address by remember { mutableStateOf("") }
    fun search() {
        searching = true
        scope.launch { found = Pairing.discover(context); searching = false }
    }
    LaunchedEffect(Unit) { search() }
    val colors = MaterialTheme.colorScheme
    Column(
        Modifier.fillMaxSize().background(colors.background).verticalScroll(rememberScrollState())
            .statusBarsPadding().navigationBarsPadding().padding(horizontal = 24.dp),
    ) {
        Spacer(Modifier.height(64.dp))
        Text("Vela", fontFamily = WordmarkFont, fontSize = 72.sp, color = colors.onBackground, modifier = Modifier.enterRise(0, true))
        Text(tr("在手机上用你的指纹浏览器", "Your fingerprint browsers, in your hand"), fontSize = 17.sp, fontFamily = TitleSerif, color = colors.onSurfaceVariant, modifier = Modifier.enterRise(1, true))
        Spacer(Modifier.height(44.dp))

        // The main way in: a dark, raised pill.
        Row(
            Modifier.enterRise(2, true).fillMaxWidth().height(64.dp)
                .floatingCard(RoundedCornerShape(32.dp)).background(colors.onBackground).springClickable(pressedScale = 0.96f, onClick = onScan)
                .padding(horizontal = 24.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Rounded.QrCodeScanner, null, tint = colors.background, modifier = Modifier.size(26.dp))
            Spacer(Modifier.width(14.dp))
            Text(tr("扫码配对", "Scan to pair"), color = colors.background, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        }
        if (error != null) {
            Spacer(Modifier.height(14.dp))
            Text(error, color = colors.error, fontSize = 14.sp, lineHeight = 20.sp)
        }

        Spacer(Modifier.height(36.dp))
        Row(Modifier.enterRise(3, true).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(tr("附近的电脑", "Computers nearby"), fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = colors.onSurfaceVariant, modifier = Modifier.weight(1f))
            if (searching) SearchingDots() else Icon(Icons.Rounded.Refresh, tr("重新搜索", "Search again"), tint = colors.onSurfaceVariant, modifier = Modifier.size(20.dp).springClickable { search() })
        }
        Spacer(Modifier.height(10.dp))
        Column(Modifier.enterRise(4, true).fillMaxWidth().floatingCard(RoundedCornerShape(20.dp))) {
            if (found.isEmpty()) {
                Text(
                    if (searching) tr("正在找…", "Looking…") else tr("没找到。在电脑上打开 Vela Browser → 设置 → 手机端，打开「允许手机连接」。", "None found. On the computer, open Vela Browser → Settings → Phone app and turn on Let phones connect."),
                    fontSize = 14.sp, lineHeight = 21.sp, color = colors.onSurfaceVariant, modifier = Modifier.padding(18.dp),
                )
            }
            found.forEachIndexed { index, computer ->
                if (index > 0) Box(Modifier.padding(start = 64.dp).fillMaxWidth().height(1.dp).background(colors.outlineVariant))
                Row(Modifier.fillMaxWidth().springClickable(pressedScale = 0.98f) { onPick(computer) }.padding(horizontal = 18.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(34.dp).clip(CircleShape).background(colors.surfaceVariant), contentAlignment = Alignment.Center) {
                        Icon(Icons.Rounded.Computer, null, tint = colors.onSurface, modifier = Modifier.size(19.dp))
                    }
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(computer.name, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = colors.onSurface)
                        Text("${computer.host}:${computer.port}", fontSize = 12.5.sp, color = colors.onSurfaceVariant, fontFamily = FontFamily.Monospace)
                    }
                    Text(tr("用 PIN", "Use PIN"), fontSize = 13.sp, color = colors.onSurfaceVariant)
                }
            }
        }
        Spacer(Modifier.height(18.dp))
        if (!typing) {
            Text(tr("手动输入电脑地址", "Type the computer's address"), fontSize = 14.sp, color = colors.onSurfaceVariant,
                modifier = Modifier.enterRise(5, true).springClickable { typing = true }.padding(vertical = 6.dp))
        } else {
            Row(verticalAlignment = Alignment.CenterVertically) {
                // A borderless filled field, like the desktop's inputs.
                Box(Modifier.weight(1f).height(52.dp).filledField(RoundedCornerShape(14.dp)).padding(horizontal = 16.dp), contentAlignment = Alignment.CenterStart) {
                    if (address.isEmpty()) Text("192.168.1.5:50480", fontSize = 16.sp, color = colors.onSurfaceVariant, fontFamily = FontFamily.Monospace)
                    androidx.compose.foundation.text.BasicTextField(
                        address, { address = it.trim() }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                        textStyle = androidx.compose.ui.text.TextStyle(fontSize = 16.sp, color = colors.onSurface, fontFamily = FontFamily.Monospace),
                        cursorBrush = androidx.compose.ui.graphics.SolidColor(colors.onSurface),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    )
                }
                Spacer(Modifier.width(10.dp))
                GlassCircleButton(Icons.AutoMirrored.Rounded.ArrowBack, tr("连接", "Connect"), {
                    scope.launch {
                        try { onPick(Pairing.probe(address)) } catch (e: Exception) { onError(pairingMessage(e)) }
                    }
                }, modifier = Modifier.graphicsLayer { rotationZ = 180f })
            }
        }
        Spacer(Modifier.weight(1f))
        Text(
            tr("只在同一个 Wi-Fi 下可用。配对时生成的密钥只存在这台手机和你的电脑上，之后的所有通信都经过加密。", "Works on the same Wi-Fi only. The key made when pairing stays on this phone and your computer, and everything after is encrypted."),
            fontSize = 12.sp, lineHeight = 18.sp, color = colors.onSurfaceVariant.copy(alpha = 0.8f), modifier = Modifier.padding(top = 40.dp, bottom = 20.dp),
        )
    }
}

@Composable
private fun SearchingDots() {
    val t = rememberInfiniteTransition(label = "dots")
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        repeat(3) { i ->
            val a by t.animateFloat(0.25f, 1f, infiniteRepeatable(tween(520, delayMillis = i * 140), RepeatMode.Reverse), label = "dot$i")
            Box(Modifier.size(6.dp).graphicsLayer { alpha = a }.clip(CircleShape).background(MaterialTheme.colorScheme.onSurfaceVariant))
        }
    }
}

/** Six boxes and a glass number pad; fills as you tap, shakes on a wrong PIN. */
@Composable
private fun PinEntry(computer: FoundComputer, error: String?, onBack: () -> Unit, onDone: (String) -> Unit) {
    var pin by remember { mutableStateOf("") }
    val haptics = LocalHapticFeedback.current
    val shake = remember { Animatable(0f) }
    LaunchedEffect(error) {
        if (error != null) { haptics.performHapticFeedback(HapticFeedbackType.LongPress); shake.animateTo(0f, spring(0.2f, 900f), initialVelocity = 2600f) }
    }
    val colors = MaterialTheme.colorScheme
    val dark = LocalDarkTheme.current
    Column(Modifier.fillMaxSize().background(colors.background).statusBarsPadding().navigationBarsPadding().padding(horizontal = 24.dp)) {
        Spacer(Modifier.height(12.dp))
        GlassCircleButton(Icons.AutoMirrored.Rounded.ArrowBack, tr("返回", "Back"), onBack, size = 42.dp, iconSize = 20.dp)
        Spacer(Modifier.height(28.dp))
        Text(tr("输入 PIN", "Enter the PIN"), fontSize = 30.sp, fontWeight = FontWeight.Bold, fontFamily = TitleSerif, color = colors.onBackground)
        Spacer(Modifier.height(6.dp))
        Text(tr("${computer.name} 上「设置 → 手机端」显示的六位数字", "The six digits in Settings → Phone app on ${computer.name}"), fontSize = 14.sp, color = colors.onSurfaceVariant)
        Spacer(Modifier.height(30.dp))
        Row(Modifier.fillMaxWidth().graphicsLayer { translationX = shake.value / 60f }, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            repeat(6) { i ->
                val filled = i < pin.length
                val active = i == pin.length
                Box(
                    Modifier.weight(1f).aspectRatio(0.82f).filledField(RoundedCornerShape(14.dp), focused = active)
                        .then(if (active) Modifier.border(BorderStroke(1.5.dp, colors.onBackground.copy(alpha = 0.55f)), RoundedCornerShape(14.dp)) else Modifier),
                    contentAlignment = Alignment.Center,
                ) {
                    if (filled) Text(pin[i].toString(), fontSize = 28.sp, fontWeight = FontWeight.Bold, color = colors.onBackground)
                }
            }
        }
        Text(error ?: "", color = colors.error, fontSize = 14.sp, modifier = Modifier.padding(top = 12.dp).height(40.dp))
        Spacer(Modifier.weight(1f))
        val keys = listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "<")
        keys.chunked(3).forEach { row ->
            Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                row.forEach { key ->
                    Box(Modifier.weight(1f).height(62.dp), contentAlignment = Alignment.Center) {
                        if (key.isNotEmpty()) Box(
                            Modifier.fillMaxSize().clip(RoundedCornerShape(22.dp))
                                .then(if (key == "<") Modifier else Modifier.filledField(RoundedCornerShape(20.dp)))
                                .springClickable(pressedScale = 0.92f) {
                                    haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                    if (key == "<") pin = pin.dropLast(1)
                                    else if (pin.length < 6) { pin += key; if (pin.length == 6) onDone(pin) }
                                },
                            contentAlignment = Alignment.Center,
                        ) {
                            if (key == "<") Icon(Icons.AutoMirrored.Rounded.Backspace, tr("删除", "Delete"), tint = colors.onBackground)
                            else Text(key, fontSize = 26.sp, fontWeight = FontWeight.Medium, color = colors.onBackground)
                        }
                    }
                }
            }
        }
        Spacer(Modifier.height(20.dp))
    }
}

/** Both screens show the same six digits; the person checks them and says yes on the computer. */
@Composable
private fun WaitingForYes(code: String, name: String) {
    val colors = MaterialTheme.colorScheme
    val pulse = rememberInfiniteTransition(label = "pulse").animateFloat(0.92f, 1.06f, infiniteRepeatable(tween(1100), RepeatMode.Reverse), label = "ring")
    Column(
        Modifier.fillMaxSize().background(colors.background).statusBarsPadding().navigationBarsPadding().padding(28.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        Box(Modifier.size(84.dp).graphicsLayer { scaleX = pulse.value; scaleY = pulse.value }.clip(CircleShape).background(colors.surfaceVariant), contentAlignment = Alignment.Center) {
            Icon(Icons.Rounded.Computer, null, tint = colors.onBackground, modifier = Modifier.size(38.dp))
        }
        Spacer(Modifier.height(30.dp))
        Text(tr("在电脑上核对", "Check on the computer"), fontSize = 26.sp, fontWeight = FontWeight.Bold, fontFamily = TitleSerif, color = colors.onBackground)
        Spacer(Modifier.height(10.dp))
        Text(tr("$name 会显示这六位数字。一致时点「配对」。", "$name shows six digits. If they match these, click Pair."), fontSize = 15.sp, lineHeight = 22.sp, color = colors.onSurfaceVariant, textAlign = TextAlign.Center)
        Spacer(Modifier.height(30.dp))
        Text("${code.take(3)} ${code.drop(3)}", fontSize = 52.sp, fontWeight = FontWeight.Bold, letterSpacing = 6.sp, color = colors.onBackground, fontFamily = FontFamily.Monospace)
        Spacer(Modifier.height(16.dp))
        Text(tr("数字不一致就点拒绝，说明有人在中间。", "If they differ, refuse: someone is in between."), fontSize = 13.sp, color = colors.onSurfaceVariant, textAlign = TextAlign.Center)
    }
}

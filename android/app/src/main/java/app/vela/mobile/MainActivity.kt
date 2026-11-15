package app.vela.mobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import app.vela.mobile.net.LinkStatus
import app.vela.mobile.ui.fx.LocalTilt
import app.vela.mobile.ui.fx.rememberTilt
import app.vela.mobile.ui.main.MainScreen
import app.vela.mobile.ui.pair.PairScreen
import app.vela.mobile.ui.theme.VelaTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.auto(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
        )
        val app = application as VelaApp
        setContent {
            val theme by app.theme.collectAsState()
            VelaTheme(theme) {
                val system = LocalHapticFeedback.current
                val haptics = remember(system) {
                    object : HapticFeedback {
                        override fun performHapticFeedback(hapticFeedbackType: HapticFeedbackType) { if (app.settings.haptics) system.performHapticFeedback(hapticFeedbackType) }
                    }
                }
                CompositionLocalProvider(LocalHapticFeedback provides haptics, LocalTilt provides rememberTilt()) {
                    val computer by app.desk.computer.collectAsState()
                    val link by app.desk.link.collectAsState()
                    var notice by remember { mutableStateOf<String?>(null) }
                    // The computer forgot this phone: back to pairing, saying why.
                    LaunchedEffect(link) {
                        link?.status?.collect {
                            if (it is LinkStatus.Unpaired) {
                                notice = tr("电脑上已经移除了这台手机，请重新配对。", "The computer removed this phone. Pair again.")
                                app.desk.unpair()
                            }
                        }
                    }
                    val loaded by app.desk.loaded.collectAsState()
                    // Until storage is read, only the background: no flash of the pairing screen.
                    if (!loaded) { androidx.compose.foundation.layout.Box(androidx.compose.ui.Modifier.fillMaxSize().background(androidx.compose.material3.MaterialTheme.colorScheme.background)); return@CompositionLocalProvider }
                    AnimatedContent(computer != null, label = "root", transitionSpec = { fadeIn(tween(320)) togetherWith fadeOut(tween(200)) }) { paired ->
                        if (paired) MainScreen() else PairScreen(notice, if (BuildConfig.DEBUG) intent?.getStringExtra("qr") else null)
                    }
                }
            }
        }
    }
}

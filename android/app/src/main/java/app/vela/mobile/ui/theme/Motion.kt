package app.vela.mobile.ui.theme

import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

/**
 * 动效约定（全局统一）：
 * - 进入：元素从下方 + 略小处浮起，弹簧收尾；按顺序错落 55ms 一个；
 * - 页面推入：新页从右侧 1/5 处滑入、淡入、由 0.97 放大到 1；旧页轻退、变淡；
 * - 返回：反向。
 */
object Motion {
    const val STAGGER_MS = 55L

}

/**
 * 进入动效是否要播：整个进程只在首次出现时播一遍，
 * 之后从别的页面返回不再重播（由 AppRoot 提供）。
 */
val LocalEntrance = compositionLocalOf { EntranceGate() }

/** 首屏进入动效的整体延后：冷启动字标动画期间先不浮入，等字标开始淡出再接力 */
val LocalEntranceDelay = compositionLocalOf { 0L }

class EntranceGate {
    private val played = mutableSetOf<String>()
    /** 第一次问某个 key 时返回 true，之后都返回 false */
    fun firstTime(key: String): Boolean = played.add(key)
}

/**
 * 浮入：按序号错落，从下方 [rise] 处、0.96 倍大小、全透明，弹簧到位。
 * play=false 时直接处于终态。
 */
@Composable
fun Modifier.enterRise(index: Int, play: Boolean, rise: Dp = 28.dp, baseDelayMs: Long = 0L): Modifier {
    val p = remember { Animatable(if (play) 0f else 1f) }
    val globalDelay = LocalEntranceDelay.current
    LaunchedEffect(play) {
        if (!play) return@LaunchedEffect
        delay(globalDelay + baseDelayMs + index * Motion.STAGGER_MS)
        p.animateTo(1f, spring(dampingRatio = 0.78f, stiffness = 260f))
    }
    return graphicsLayer {
        val v = p.value
        alpha = v.coerceIn(0f, 1f)
        translationY = (1f - v) * rise.toPx()
        val s = 0.96f + 0.04f * v
        scaleX = s
        scaleY = s
        transformOrigin = TransformOrigin(0.5f, 1f)
    }
}

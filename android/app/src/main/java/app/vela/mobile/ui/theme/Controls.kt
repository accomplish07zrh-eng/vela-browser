package app.vela.mobile.ui.theme

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.shape.RoundedCornerShape
import kotlin.math.roundToInt

private val TrackW = 51.dp
private val TrackH = 31.dp
private val ThumbInset = 2.dp

/**
 * 胶囊开关（iOS 式）：按住时滑块横向拉长，松手后弹簧滑到另一端并带轻微过冲；
 * 轨道颜色随进度插值，单色系（浅色：灰 → 墨黑；深色：深灰 → 珍珠白）。
 */
@Composable
fun VelaSwitch(
    checked: Boolean,
    onCheckedChange: ((Boolean) -> Unit)?,
    enabled: Boolean = true,
) {
    val dark = LocalDarkTheme.current
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val progress by animateFloatAsState(
        if (checked) 1f else 0f,
        animationSpec = spring(dampingRatio = 0.62f, stiffness = 480f),
        label = "switchProgress",
    )
    val thumbW by animateDpAsState(
        if (pressed) 33.dp else 27.dp,
        animationSpec = spring(dampingRatio = 0.7f, stiffness = 700f),
        label = "switchThumb",
    )
    val trackOff = if (dark) Color(0xFF3A3A41) else Color(0xFFE5E5EA)
    val trackOn = if (dark) Color(0xFFEDEDF2) else Color(0xFF111114)
    val thumbColor = if (dark) Color(0xFF17171C) else Color.White
    Box(
        Modifier
            .alpha(if (enabled) 1f else 0.4f)
            .size(TrackW, TrackH)
            .clip(CircleShape)
            .background(lerp(trackOff, trackOn, progress))
            .toggleable(
                value = checked,
                enabled = enabled && onCheckedChange != null,
                role = Role.Switch,
                interactionSource = interaction,
                indication = null,
                onValueChange = { onCheckedChange?.invoke(it) },
            ),
        contentAlignment = Alignment.CenterStart,
    ) {
        Box(
            Modifier
                .offset {
                    val start = ThumbInset.toPx()
                    val end = (TrackW - ThumbInset - thumbW).toPx()
                    IntOffset((start + (end - start) * progress).roundToInt(), 0)
                }
                .width(thumbW)
                .height(TrackH - ThumbInset * 2)
                .shadow(3.dp, CircleShape, ambientColor = Color.Black.copy(alpha = 0.18f), spotColor = Color.Black.copy(alpha = 0.22f))
                .clip(CircleShape)
                .background(thumbColor)
        )
    }
}

/**
 * A borderless filled field, as the desktop's inputs: a faint ink wash that deepens while focused.
 */
@Composable
fun Modifier.filledField(shape: Shape = RoundedCornerShape(14.dp), focused: Boolean = false): Modifier {
    val dark = LocalDarkTheme.current
    val ink = if (dark) Color(0xFFF2F2F5) else Color(0xFF111114)
    return this.clip(shape).background(ink.copy(alpha = if (focused) (if (dark) 0.09f else 0.078f) else (if (dark) 0.055f else 0.048f)))
}

/**
 * 白色浮起卡片：设置分组、表单分组、信息面板共用。
 * 白底页面上靠一层柔和投影 + 极细轮廓线分层，与页头 / 底栏的玻璃控件是同一种“浮”的质感。
 */
@Composable
fun Modifier.floatingCard(shape: Shape): Modifier {
    val dark = LocalDarkTheme.current
    return this
        .shadow(
            if (dark) 4.dp else 10.dp,
            shape,
            ambientColor = Color.Black.copy(alpha = if (dark) 0.3f else 0.05f),
            spotColor = Color.Black.copy(alpha = if (dark) 0.3f else 0.09f),
        )
        .clip(shape)
        .background(if (dark) MaterialTheme.colorScheme.surface else Color.White)
        .border(
            1.dp,
            if (dark) Color.White.copy(alpha = 0.06f) else Color.Black.copy(alpha = 0.045f),
            shape,
        )
}

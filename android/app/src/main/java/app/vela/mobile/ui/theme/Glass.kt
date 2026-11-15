package app.vela.mobile.ui.theme

import app.vela.mobile.ui.fx.LocalTilt
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.runtime.State
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.zIndex
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.chrisbanes.haze.HazeState
import dev.chrisbanes.haze.HazeStyle
import dev.chrisbanes.haze.HazeTint
import dev.chrisbanes.haze.hazeChild

/** 磨砂玻璃材质：底层真模糊（API 31+），低版本退化为高不透明度的纯色磨砂 */
@Composable
fun glassStyle(): HazeStyle {
    val dark = LocalDarkTheme.current
    val bg = MaterialTheme.colorScheme.background
    return if (dark) {
        HazeStyle(
            backgroundColor = bg,
            tint = HazeTint(Color(0xFF1C1C22).copy(alpha = 0.50f)),
            blurRadius = 36.dp,
            noiseFactor = 0.06f,
            fallbackTint = HazeTint(Color(0xFF1C1C22).copy(alpha = 0.94f)),
        )
    } else {
        HazeStyle(
            backgroundColor = bg,
            // 重模糊 + 偏透的白：背后卡片的颜色会晕进玻璃里（系统相册那种奶白通透感）
            tint = HazeTint(Color.White.copy(alpha = 0.52f)),
            blurRadius = 36.dp,
            noiseFactor = 0.03f,
            fallbackTint = HazeTint(Color.White.copy(alpha = 0.95f)),
        )
    }
}

/**
 * 玻璃表面：柔和大投影 + 模糊背后内容 + 双层描边——
 * 外缘一道极细暗线定轮廓，内缘一圈顶亮底暗的折射高光，像厚玻璃的倒角。
 * hazeState 为空时（控件本身就在模糊源里，例如页头圆钮）用奶白实色兜底。
 */
@Composable
fun Modifier.glassSurface(hazeState: HazeState?, shape: Shape, elevated: Boolean = true): Modifier {
    val dark = LocalDarkTheme.current
    val tilt = LocalTilt.current
    val hairline = if (dark) Color.White.copy(alpha = 0.08f) else Color.Black.copy(alpha = 0.07f)
    val fallback = if (dark) Color(0xFF1C1C22).copy(alpha = 0.92f) else Color.White
    return this
        .then(
            if (elevated) Modifier.shadow(
                if (dark) 8.dp else 16.dp,
                shape,
                ambientColor = Color.Black.copy(alpha = 0.08f),
                spotColor = Color.Black.copy(alpha = 0.16f),
            ) else Modifier
        )
        .clip(shape)
        .then(if (hazeState != null) Modifier.hazeChild(hazeState, glassStyle()) else Modifier.background(fallback))
        .liquidRim(shape, tilt, dark)
        .border(1.dp, hairline, shape)
}

/**
 * 液态玻璃的边：光从左上打来，左上与右下两个对角各亮起一段高光（入射与折射），
 * 两侧收暗；高光角度随手机倾斜缓缓转动。顶部再垫一层很淡的内光，让玻璃有厚度。
 */
private fun Modifier.liquidRim(shape: Shape, tilt: State<Offset>, dark: Boolean) = drawWithContent {
    drawContent()
    val outline = shape.createOutline(size, layoutDirection, this)
    val t = tilt.value
    val c = Offset(size.width / 2f, size.height / 2f)
    var dx = -0.72f + t.x * 0.55f
    var dy = -0.72f + t.y * 0.55f
    val len = kotlin.math.sqrt(dx * dx + dy * dy).coerceAtLeast(0.001f)
    dx /= len
    dy /= len
    val r = maxOf(size.width, size.height) / 2f
    val hi = if (dark) 0.5f else 1f
    val lo = if (dark) 0.05f else 0.28f
    val back = if (dark) 0.24f else 0.75f
    val rim = Brush.linearGradient(
        0f to Color.White.copy(alpha = hi),
        0.3f to Color.White.copy(alpha = lo),
        0.7f to Color.White.copy(alpha = lo),
        1f to Color.White.copy(alpha = back),
        start = Offset(c.x + dx * r, c.y + dy * r),
        end = Offset(c.x - dx * r, c.y - dy * r),
    )
    drawRect(
        Brush.verticalGradient(
            0f to Color.White.copy(alpha = if (dark) 0.07f else 0.35f),
            0.45f to Color.Transparent,
        )
    )
    drawOutline(outline, rim, style = Stroke(width = 3.dp.toPx()))
}

/**
 * 按压回弹：按下时弹簧收缩、松手带一点过冲弹回，替代 Material 水波纹。
 * 缩放放在图层上，只重绘不重排；与同一个 interactionSource 的 clickable 搭配使用。
 */
@Composable
fun Modifier.pressScale(interaction: InteractionSource, pressedScale: Float = 0.9f): Modifier {
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (pressed) pressedScale else 1f,
        animationSpec = if (pressed) spring(dampingRatio = 1f, stiffness = 1400f)
        else spring(dampingRatio = 0.45f, stiffness = 520f),
        label = "pressScale",
    )
    return graphicsLayer {
        scaleX = scale
        scaleY = scale
    }
}

/** 可点击 + 按压回弹，一步到位 */
@Composable
fun Modifier.springClickable(
    enabled: Boolean = true,
    pressedScale: Float = 0.9f,
    onClick: () -> Unit,
): Modifier {
    val interaction = remember { MutableInteractionSource() }
    return pressScale(interaction, pressedScale)
        .clickable(interactionSource = interaction, indication = null, enabled = enabled, onClick = onClick)
}

/** 圆形玻璃按钮（右上角搜索 / 更多、详情关闭、页面返回） */
@Composable
fun GlassCircleButton(
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    hazeState: HazeState? = null,
    size: Dp = 46.dp,
    iconSize: Dp = 22.dp,
    tint: Color = MaterialTheme.colorScheme.onSurface,
) {
    val interaction = remember { MutableInteractionSource() }
    Box(
        modifier
            .pressScale(interaction, 0.88f)
            .size(size)
            .glassSurface(hazeState, CircleShape)
            .clickable(interactionSource = interaction, indication = null, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = contentDescription, tint = tint, modifier = Modifier.size(iconSize))
    }
}

/** 页面背景：纯色底（浅色为纯白），作为玻璃控件的模糊取样源 */
@Composable
fun AppBackground(modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit) {
    Box(
        modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
        content = content,
    )
}

/** 列表分组卡片的统一外观：白色浮起卡片（见 floatingCard） */
@Composable
fun Modifier.groupedSurface(shape: Shape): Modifier = floatingCard(shape)

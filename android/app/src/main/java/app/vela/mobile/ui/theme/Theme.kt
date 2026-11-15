package app.vela.mobile.ui.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontWeight
import androidx.core.view.WindowCompat

/**
 * 液态玻璃风格：单色为主（墨黑 / 珍珠白），彩色只留给卡面本身，
 * 界面控件靠半透明磨砂 + 细高光描边分层，而不是靠色块。
 */
private val DarkColors = darkColorScheme(
    primary = Color(0xFFF2F2F5),
    onPrimary = Color(0xFF0B0B0E),
    primaryContainer = Color(0xFF2A2A30),
    onPrimaryContainer = Color(0xFFF2F2F5),
    secondary = Color(0xFFAEB0BA),
    secondaryContainer = Color(0xFF24242A),
    onSecondaryContainer = Color(0xFFE6E6EB),
    background = Color(0xFF09090C),
    onBackground = Color(0xFFF2F2F5),
    surface = Color(0xFF16161B),
    onSurface = Color(0xFFF2F2F5),
    surfaceVariant = Color(0xFF222228),
    onSurfaceVariant = Color(0xFF9C9EA8),
    surfaceContainer = Color(0xFF1B1B21),
    surfaceContainerHigh = Color(0xFF222228),
    surfaceContainerHighest = Color(0xFF2A2A31),
    outline = Color(0xFF5A5C66),
    outlineVariant = Color(0xFF2E2F36),
    error = Color(0xFFFF6B63),
)

private val LightColors = lightColorScheme(
    primary = Color(0xFF111114),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFE9E9EE),
    onPrimaryContainer = Color(0xFF111114),
    secondary = Color(0xFF5E606A),
    secondaryContainer = Color(0xFFE9E9EE),
    onSecondaryContainer = Color(0xFF111114),
    // 纯白底：彩色只留给卡面；分组卡片与控件用极浅的灰，靠明度差分层
    background = Color(0xFFFFFFFF),
    onBackground = Color(0xFF111114),
    surface = Color(0xFFF5F5F7),
    onSurface = Color(0xFF111114),
    surfaceVariant = Color(0xFFEBEBEF),
    onSurfaceVariant = Color(0xFF6B6D77),
    surfaceContainer = Color(0xFFF5F5F7),
    surfaceContainerHigh = Color(0xFFFFFFFF),
    surfaceContainerHighest = Color(0xFFEBEBEF),
    outline = Color(0xFFB9BAC2),
    outlineVariant = Color(0xFFE3E3E8),
    error = Color(0xFFD93A35),
)

/** 当前是否深色：玻璃组件按它选磨砂底色与描边 */
val LocalDarkTheme = staticCompositionLocalOf { false }

private val BaseTypography = Typography()

/** 全局圆角放大：菜单、输入框、提示条、弹窗都与玻璃控件的圆润感一致 */
private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(12.dp),
    small = RoundedCornerShape(16.dp),
    medium = RoundedCornerShape(20.dp),
    large = RoundedCornerShape(26.dp),
    extraLarge = RoundedCornerShape(32.dp),
)

/** 标题加粗收紧，正文不动：大标题是这套风格的主要识别点 */
private val AppTypography = BaseTypography.copy(
    headlineLarge = BaseTypography.headlineLarge.copy(fontWeight = FontWeight.Black),
    headlineMedium = BaseTypography.headlineMedium.copy(fontWeight = FontWeight.Black),
    titleLarge = BaseTypography.titleLarge.copy(fontWeight = FontWeight.Bold),
)

@Composable
fun VelaTheme(themeMode: String = "system", content: @Composable () -> Unit) {
    val dark = when (themeMode) {
        "dark" -> true
        "light" -> false
        else -> isSystemInDarkTheme()
    }
    val colors = if (dark) DarkColors else LightColors

    // 系统栏与页面底色一致，状态栏图标随主题深浅切换
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as? Activity)?.window ?: return@SideEffect
            // Edge to edge: the bars stay transparent over the browser; only their icons follow the theme.
            window.statusBarColor = android.graphics.Color.TRANSPARENT
            window.navigationBarColor = android.graphics.Color.TRANSPARENT
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
        }
    }

    CompositionLocalProvider(LocalDarkTheme provides dark) {
        MaterialTheme(
            colorScheme = colors,
            typography = AppTypography,
            shapes = AppShapes,
            content = content,
        )
    }
}

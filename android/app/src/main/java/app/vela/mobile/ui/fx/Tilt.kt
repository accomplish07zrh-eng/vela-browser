package app.vela.mobile.ui.fx

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver

/** 当前设备倾斜（-1..1），驱动卡面光泽、闪粉与虹彩；全局只注册一个传感器 */
val LocalTilt = staticCompositionLocalOf<State<Offset>> { mutableStateOf(Offset.Zero) }

/**
 * 用重力传感器求屏幕平面上的倾斜：以拿起手机时的姿态为基准，
 * 偏离量经低通滤波后映射到 -1..1；只在前台监听，退后台即注销省电。
 */
@Composable
fun rememberTilt(): State<Offset> {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val state = remember { mutableStateOf(Offset.Zero) }
    DisposableEffect(lifecycle) {
        val sm = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
        val sensor = sm.getDefaultSensor(Sensor.TYPE_GRAVITY) ?: sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        var baseX = Float.NaN
        var baseY = Float.NaN
        var sx = 0f
        var sy = 0f
        val listener = object : SensorEventListener {
            override fun onSensorChanged(e: SensorEvent) {
                val gx = e.values[0] / SensorManager.GRAVITY_EARTH
                val gy = e.values[1] / SensorManager.GRAVITY_EARTH
                if (baseX.isNaN()) { baseX = gx; baseY = gy }
                // 基准缓慢跟随姿态，长时间同一角度握持时光效回到中性
                baseX += (gx - baseX) * 0.004f
                baseY += (gy - baseY) * 0.004f
                val tx = ((gx - baseX) * 2.2f).coerceIn(-1f, 1f)
                val ty = ((gy - baseY) * 2.2f).coerceIn(-1f, 1f)
                sx += (tx - sx) * 0.18f
                sy += (ty - sy) * 0.18f
                state.value = Offset(-sx, sy)
            }

            override fun onAccuracyChanged(s: Sensor?, a: Int) = Unit
        }
        fun start() = sensor?.let { sm.registerListener(listener, it, SensorManager.SENSOR_DELAY_GAME) }
        fun stop() = sm.unregisterListener(listener)
        val observer = LifecycleEventObserver { _, ev ->
            when (ev) {
                Lifecycle.Event.ON_RESUME -> start()
                Lifecycle.Event.ON_PAUSE -> stop()
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) start()
        onDispose {
            lifecycle.removeObserver(observer)
            stop()
        }
    }
    return state
}

package app.vela.mobile.ui.pair

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import app.vela.mobile.tr
import app.vela.mobile.ui.theme.GlassCircleButton
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import java.util.concurrent.Executors

/** Full-screen camera that reads the pairing code; [onCode] gets the text of the first QR code seen. */
@Composable
fun Scanner(onCode: (String) -> Unit, onClose: () -> Unit) {
    val context = LocalContext.current
    var allowed by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    var asked by remember { mutableStateOf(false) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed = it; asked = true }
    LaunchedEffect(Unit) { if (!allowed) ask.launch(Manifest.permission.CAMERA) }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        if (allowed) CameraPreview(onCode)
        // The window to aim with: everything around it darker, a soft light line sweeping through.
        val sweep = rememberInfiniteTransition(label = "sweep").animateFloat(0f, 1f, infiniteRepeatable(tween(1800), RepeatMode.Reverse), label = "line")
        Canvas(Modifier.fillMaxSize().graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }) {
            val side = size.minDimension * 0.68f
            val topLeft = Offset((size.width - side) / 2f, (size.height - side) / 2f - 40.dp.toPx())
            drawRect(Color.Black.copy(alpha = 0.55f))
            drawRoundRect(Color.Transparent, topLeft, Size(side, side), CornerRadius(28.dp.toPx()), blendMode = BlendMode.Clear)
            val arm = 34.dp.toPx(); val r = 28.dp.toPx(); val w = 4.dp.toPx()
            val corners = listOf(topLeft, Offset(topLeft.x + side, topLeft.y), Offset(topLeft.x, topLeft.y + side), Offset(topLeft.x + side, topLeft.y + side))
            corners.forEachIndexed { i, c ->
                val sx = if (i % 2 == 0) 1f else -1f
                val sy = if (i < 2) 1f else -1f
                drawLine(Color.White, Offset(c.x + sx * r, c.y), Offset(c.x + sx * (r + arm - r / 2), c.y), w, StrokeCap.Round)
                drawLine(Color.White, Offset(c.x, c.y + sy * r), Offset(c.x, c.y + sy * (r + arm - r / 2)), w, StrokeCap.Round)
                drawArc(Color.White, startAngle = when (i) { 0 -> 180f; 1 -> 270f; 2 -> 90f; else -> 0f }, sweepAngle = 90f, useCenter = false,
                    topLeft = Offset(if (sx > 0) c.x else c.x - 2 * r, if (sy > 0) c.y else c.y - 2 * r), size = Size(2 * r, 2 * r), style = Stroke(w, cap = StrokeCap.Round))
            }
            val y = topLeft.y + side * (0.12f + 0.76f * sweep.value)
            drawLine(Color.White.copy(alpha = 0.55f), Offset(topLeft.x + 24.dp.toPx(), y), Offset(topLeft.x + side - 24.dp.toPx(), y), 2.dp.toPx(), StrokeCap.Round)
        }
        Column(Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(start = 32.dp, end = 32.dp, bottom = 72.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                if (allowed) tr("对准电脑上「设置 → 手机端」里的二维码", "Point at the code in Settings → Phone app on the computer")
                else if (asked) tr("没有相机权限，可以改用 PIN 配对", "No camera access: pair with the PIN instead") else "",
                color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center,
            )
        }
        GlassCircleButton(Icons.Rounded.Close, tr("关闭", "Close"), onClose, Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(16.dp), tint = Color.White)
    }
}

@Composable
private fun CameraPreview(onCode: (String) -> Unit) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val executor = remember { Executors.newSingleThreadExecutor() }
    var done by remember { mutableStateOf(false) }
    val reader = remember {
        MultiFormatReader().apply { setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE), DecodeHintType.TRY_HARDER to true)) }
    }
    DisposableEffect(Unit) { onDispose { executor.shutdown() } }
    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { ctx ->
            val view = PreviewView(ctx).apply { scaleType = PreviewView.ScaleType.FILL_CENTER }
            val future = ProcessCameraProvider.getInstance(ctx)
            future.addListener({
                val provider = future.get()
                val preview = Preview.Builder().build().also { it.setSurfaceProvider(view.surfaceProvider) }
                val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
                analysis.setAnalyzer(executor) { image ->
                    try {
                        if (done) return@setAnalyzer
                        val plane = image.planes[0]
                        val buffer = plane.buffer
                        val data = ByteArray(buffer.remaining()).also { buffer.get(it) }
                        val source = PlanarYUVLuminanceSource(data, plane.rowStride, image.height, 0, 0, image.width, image.height, false)
                        val text = runCatching { reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text }.getOrNull()
                        reader.reset()
                        if (text != null && !done) { done = true; ContextCompat.getMainExecutor(ctx).execute { onCode(text) } }
                    } finally { image.close() }
                }
                runCatching {
                    provider.unbindAll()
                    provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                }
            }, ContextCompat.getMainExecutor(ctx))
            view
        },
    )
    DisposableEffect(Unit) { onDispose { runCatching { ProcessCameraProvider.getInstance(context).get().unbindAll() } } }
}

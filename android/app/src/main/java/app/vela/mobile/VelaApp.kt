package app.vela.mobile

import android.Manifest
import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import app.vela.mobile.data.ComputerStore
import app.vela.mobile.data.Settings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class VelaApp : Application() {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    lateinit var desk: Desk
        private set
    lateinit var settings: Settings
        private set
    private var sleeping: Job? = null
    /** Light, dark or following the system; the screens recompose when it changes. */
    val theme = kotlinx.coroutines.flow.MutableStateFlow("system")
    fun themeChanged() { theme.value = settings.theme }

    override fun onCreate() {
        super.onCreate()
        instance = this
        settings = Settings(this)
        theme.value = settings.theme
        desk = Desk(scope, ComputerStore(this))
        channels()
        desk.onBackgroundNotice = { notice -> if (settings.backgroundAlerts) post(notice) }
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                sleeping?.cancel()
                stopService(Intent(this@VelaApp, AlertService::class.java))
                desk.setForeground(true)
            }

            override fun onStop(owner: LifecycleOwner) {
                desk.setForeground(false)
                if (settings.backgroundAlerts && desk.computer.value != null) {
                    // Keeps the connection while in the background, so approvals and finished scripts still arrive.
                    ContextCompat.startForegroundService(this@VelaApp, Intent(this@VelaApp, AlertService::class.java))
                } else {
                    sleeping = scope.launch { delay(30_000); desk.stopLink() }
                }
            }
        })
    }

    private fun channels() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL_ALERTS, tr("审批与脚本提醒", "Approvals and scripts"), NotificationManager.IMPORTANCE_HIGH))
        manager.createNotificationChannel(NotificationChannel(CHANNEL_LINK, tr("保持连接", "Staying connected"), NotificationManager.IMPORTANCE_MIN).apply { setShowBadge(false) })
    }

    private fun post(notice: Notice) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(this, CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(notice.title)
            .setContentText(notice.detail)
            .setAutoCancel(true)
            .setContentIntent(open)
            .build()
        try { NotificationManagerCompat.from(this).notify(notice.id.toInt(), notification) } catch (_: SecurityException) {}
    }

    companion object {
        const val CHANNEL_ALERTS = "alerts"
        const val CHANNEL_LINK = "link"
        lateinit var instance: VelaApp
            private set
    }
}

/** Shown while the app keeps the connection in the background for alerts; ends when the app returns. */
class AlertService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val app = application as VelaApp
        val open = PendingIntent.getActivity(this, 1, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(this, VelaApp.CHANNEL_LINK)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(tr("正在接收提醒", "Listening for alerts"))
            .setContentText(app.desk.computer.value?.name ?: "Vela Browser")
            .setOngoing(true)
            .setContentIntent(open)
            .build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(7, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else startForeground(7, notification)
        return START_NOT_STICKY
    }
}

val Context.app: VelaApp get() = applicationContext as VelaApp

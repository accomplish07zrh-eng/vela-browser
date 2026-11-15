package app.vela.mobile.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONArray
import org.json.JSONObject

/** A computer this phone paired with: where to find it and the key both keep. */
data class Computer(
    val deviceId: String,
    val name: String,
    val hosts: List<String>,
    val port: Int,
    val fingerprint: String,
    val key: ByteArray,
)

/**
 * The paired computer, kept in app storage. Its key is sealed with a key from the Android
 * Keystore that never leaves the phone's secure hardware, so a copy of the app's files is no use.
 */
class ComputerStore(context: Context) {
    private val prefs = context.getSharedPreferences("vela", Context.MODE_PRIVATE)

    private fun wrappingKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    private fun seal(plain: ByteArray): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, wrappingKey())
        return Base64.encodeToString(cipher.iv + cipher.doFinal(plain), Base64.NO_WRAP)
    }

    private fun unseal(text: String): ByteArray? = try {
        val data = Base64.decode(text, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, wrappingKey(), GCMParameterSpec(128, data, 0, 12))
        cipher.doFinal(data, 12, data.size - 12)
    } catch (_: Exception) { null }

    fun load(): Computer? {
        val raw = prefs.getString("computer", null) ?: return null
        return try {
            val json = JSONObject(raw)
            val key = unseal(json.getString("key")) ?: return null
            val hosts = json.getJSONArray("hosts").let { array -> List(array.length()) { array.getString(it) } }
            Computer(json.getString("deviceId"), json.getString("name"), hosts, json.getInt("port"), json.getString("fingerprint"), key)
        } catch (_: Exception) { null }
    }

    fun save(computer: Computer) {
        val json = JSONObject()
            .put("deviceId", computer.deviceId)
            .put("name", computer.name)
            .put("hosts", JSONArray(computer.hosts))
            .put("port", computer.port)
            .put("fingerprint", computer.fingerprint)
            .put("key", seal(computer.key))
        prefs.edit().putString("computer", json.toString()).apply()
    }

    /** A computer's address can change (DHCP); the one that answered last goes first. */
    fun remember(computer: Computer, host: String) {
        if (computer.hosts.firstOrNull() == host) return
        save(computer.copy(hosts = listOf(host) + computer.hosts.filter { it != host }))
    }

    fun forget() { prefs.edit().remove("computer").remove("lastProfile").apply() }

    /** The browser shown last, shown again when the app opens. */
    var lastProfile: String?
        get() = prefs.getString("lastProfile", null)
        set(value) { prefs.edit().putString("lastProfile", value).apply() }

    private companion object { const val ALIAS = "vela-link" }
}

/** Small settings: theme and alerts in the background. */
class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("vela-settings", Context.MODE_PRIVATE)
    var theme: String
        get() = prefs.getString("theme", "system") ?: "system"
        set(value) { prefs.edit().putString("theme", value).apply() }
    var backgroundAlerts: Boolean
        get() = prefs.getBoolean("backgroundAlerts", false)
        set(value) { prefs.edit().putBoolean("backgroundAlerts", value).apply() }
    var haptics: Boolean
        get() = prefs.getBoolean("haptics", true)
        set(value) { prefs.edit().putBoolean("haptics", value).apply() }
}

package app.vela.mobile.net

import java.nio.ByteBuffer
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * The same cryptography as the computer (src/mobile-link.ts): P-256 keys, ECDH, HKDF-SHA256,
 * HMAC-SHA256 and AES-256-GCM with a counter as the IV.
 */
object VelaCrypto {
    fun newKeyPair(): KeyPair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()

    fun publicKey(spki: ByteArray): PublicKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(spki))

    fun ecdh(own: PrivateKey, other: PublicKey): ByteArray =
        KeyAgreement.getInstance("ECDH").run { init(own); doPhase(other, true); generateSecret() }

    fun hmac(key: ByteArray, vararg parts: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        parts.forEach { mac.update(it) }
        return mac.doFinal()
    }

    fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int = 32): ByteArray {
        val prk = hmac(salt, ikm)
        val out = ByteArray(length)
        var previous = ByteArray(0)
        var done = 0
        var counter = 1
        while (done < length) {
            previous = hmac(prk, previous, info, byteArrayOf(counter.toByte()))
            val take = minOf(previous.size, length - done)
            System.arraycopy(previous, 0, out, done, take)
            done += take
            counter++
        }
        return out
    }

    fun sha256(vararg parts: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").run { parts.forEach { update(it) }; digest() }

    /** Short form of the computer's key, as its QR code carries it. */
    fun fingerprint(spki: ByteArray): String = sha256(spki).joinToString("") { "%02x".format(it) }.take(32)

    /** The six digits both screens show while a PIN pairing waits for a yes on the computer. */
    fun pairCode(computerKey: ByteArray, phoneKey: ByteArray): String {
        val digest = sha256("vela-pair-code".toByteArray(), computerKey, phoneKey)
        val value = ByteBuffer.wrap(digest, 0, 4).int.toLong() and 0xffffffffL
        return (value % 1_000_000L).toString().padStart(6, '0')
    }

    fun same(a: ByteArray, b: ByteArray): Boolean = MessageDigest.isEqual(a, b)
}

fun String.utf8(): ByteArray = toByteArray(Charsets.UTF_8)

/** One sealed connection: AES-256-GCM both ways, each direction with its own key and an IV counter that only goes up. */
class SealedChannel private constructor(private val sendKey: ByteArray, private val receiveKey: ByteArray) {
    private var sent = 0L
    private var received = 0L

    companion object {
        fun forClient(deviceKey: ByteArray, serverNonce: ByteArray, clientNonce: ByteArray): SealedChannel {
            val salt = serverNonce + clientNonce
            return SealedChannel(
                VelaCrypto.hkdf(deviceKey, salt, "vela-c2s".utf8()),
                VelaCrypto.hkdf(deviceKey, salt, "vela-s2c".utf8()),
            )
        }
    }

    @Synchronized
    fun seal(plain: ByteArray): ByteArray {
        sent++
        val iv = ByteBuffer.allocate(12).putInt(0).putLong(sent).array()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(sendKey, "AES"), GCMParameterSpec(128, iv))
        return iv + cipher.doFinal(plain)
    }

    /** The plaintext, or null for anything forged, replayed or out of order. */
    @Synchronized
    fun open(sealed: ByteArray): ByteArray? {
        if (sealed.size < 28) return null
        val head = ByteBuffer.wrap(sealed, 0, 12)
        if (head.int != 0) return null
        val counter = head.long
        if (counter <= received) return null
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(receiveKey, "AES"), GCMParameterSpec(128, sealed, 0, 12))
            val plain = cipher.doFinal(sealed, 12, sealed.size - 12)
            received = counter
            plain
        } catch (_: Exception) { null }
    }
}

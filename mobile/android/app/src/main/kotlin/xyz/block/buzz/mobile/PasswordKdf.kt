package xyz.block.buzz.mobile

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Native PBKDF2 for the email-and-password account key.
 *
 * Pure Dart needs 6.1 s for the 600,000 HMAC-SHA256 rounds sign-in requires,
 * measured AOT on an Apple M1 Max, against 76 ms natively. This exists to
 * close that gap; it is not a convenience.
 *
 * Bytes in, bytes out. Nothing here normalises, trims or re-encodes its
 * inputs, and it must stay that way: the Dart side owns encoding, and a native
 * half that quietly disagreed about it would derive a different key from the
 * same password with no error to show for it.
 *
 * ## Why not SecretKeyFactory("PBKDF2WithHmacSHA256")
 *
 * That API takes the password as a `char[]` through `PBEKeySpec` and leaves
 * the character-to-byte encoding to whichever provider answers. OpenJDK's
 * implementation encodes UTF-8; BouncyCastle's `PKCS5PasswordToBytes` keeps
 * only the low byte of each character, which is Latin-1. Android has shipped
 * both. The same accented password would then derive one key on one Android
 * version and a different key on another, and the user would see nothing but
 * `invalid_credentials`. Driving HMAC directly keeps the bytes the Dart side
 * sent, on every provider, and the HMAC itself is still the platform's.
 */
internal object PasswordKdf {
    const val CHANNEL = "buzz/password_kdf"
    const val DERIVE_METHOD = "pbkdf2HmacSha256"

    private const val HMAC = "HmacSHA256"
    private const val HASH_LENGTH = 32

    /**
     * PBKDF2-HMAC-SHA256 (RFC 8018 section 5.2) over raw bytes.
     *
     * @throws IllegalArgumentException if any input is outside the range the
     *   algorithm defines, rather than silently returning a usable-looking key.
     */
    fun pbkdf2HmacSha256(
        password: ByteArray,
        salt: ByteArray,
        iterations: Int,
        length: Int,
    ): ByteArray {
        require(password.isNotEmpty()) { "password must not be empty" }
        require(salt.isNotEmpty()) { "salt must not be empty" }
        require(iterations > 0) { "iterations must be positive" }
        require(length > 0) { "length must be positive" }

        val mac = Mac.getInstance(HMAC)
        mac.init(SecretKeySpec(password, HMAC))

        val derived = ByteArray(length)
        val blockCount = (length + HASH_LENGTH - 1) / HASH_LENGTH
        var written = 0

        for (block in 1..blockCount) {
            mac.update(salt)
            // INT_32_BE(block), the big-endian block index RFC 8018 appends.
            mac.update(byteArrayOf(
                (block ushr 24).toByte(),
                (block ushr 16).toByte(),
                (block ushr 8).toByte(),
                block.toByte(),
            ))
            var u = mac.doFinal()
            val t = u.copyOf()
            for (round in 2..iterations) {
                u = mac.doFinal(u)
                for (i in t.indices) {
                    t[i] = (t[i].toInt() xor u[i].toInt()).toByte()
                }
            }
            val take = minOf(HASH_LENGTH, length - written)
            t.copyInto(derived, written, 0, take)
            written += take
        }

        return derived
    }
}

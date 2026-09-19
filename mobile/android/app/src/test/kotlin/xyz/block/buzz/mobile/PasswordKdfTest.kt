package xyz.block.buzz.mobile

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals

/**
 * The shared account vector, minted from desktop's own `deriveAuthKey` and
 * pinned identically in Dart, in `RunnerTests.swift` and in
 * `desktop/src/features/onboarding/authCrypto.test.mjs`.
 *
 * If this implementation drifts from the other three, a user with the right
 * password gets `invalid_credentials` and nothing in any log says why.
 */
class PasswordKdfTest {
    private val password = "correct horse battery".toByteArray(Charsets.UTF_8)
    private val salt =
        "8af931298933fa3787812090082249cbdca8621047fa7aff922fe12acb35d9d7".hexToBytes()
    private val authKey =
        "25e331a7de880c18d500eb562f99241e65a13f2ad5a0c664be0179d7cfc92082"

    @Test
    fun `matches the shared account vector`() {
        val derived = PasswordKdf.pbkdf2HmacSha256(password, salt, 600_000, 32)

        assertEquals(authKey, derived.toHex())
    }

    @Test
    fun `matches RFC 6070 style multi-block output`() {
        // A length past one SHA-256 block exercises the block loop, which the
        // 32-byte account vector never reaches.
        val derived = PasswordKdf.pbkdf2HmacSha256(password, salt, 4, 48)
        val firstBlock = PasswordKdf.pbkdf2HmacSha256(password, salt, 4, 32)

        assertEquals(48, derived.size)
        assertEquals(firstBlock.toHex(), derived.copyOf(32).toHex())
    }

    @Test
    fun `does not re-encode its inputs`() {
        // The channel contract is bytes in, bytes out. Two spellings of the
        // same accented password are different bytes and must stay different
        // keys, because desktop normalises nothing when deriving this value.
        // A provider that folded the password through Latin-1 would collapse
        // these, which is the reason this does not use SecretKeyFactory.
        val composed = "caf\u00e9 battery staple".toByteArray(Charsets.UTF_8)
        val decomposed = "cafe\u0301 battery staple".toByteArray(Charsets.UTF_8)

        assertNotEquals(
            PasswordKdf.pbkdf2HmacSha256(composed, salt, 4, 32).toHex(),
            PasswordKdf.pbkdf2HmacSha256(decomposed, salt, 4, 32).toHex(),
        )
    }

    @Test
    fun `refuses inputs outside the algorithm`() {
        // Refusing is the point: a derivation that quietly substituted a
        // default would return a usable-looking key that opens nothing.
        assertFailsWith<IllegalArgumentException> {
            PasswordKdf.pbkdf2HmacSha256(ByteArray(0), salt, 1, 32)
        }
        assertFailsWith<IllegalArgumentException> {
            PasswordKdf.pbkdf2HmacSha256(password, ByteArray(0), 1, 32)
        }
        assertFailsWith<IllegalArgumentException> {
            PasswordKdf.pbkdf2HmacSha256(password, salt, 0, 32)
        }
        assertFailsWith<IllegalArgumentException> {
            PasswordKdf.pbkdf2HmacSha256(password, salt, 1, 0)
        }
    }
}

private fun String.hexToBytes(): ByteArray =
    chunked(2).map { it.toInt(16).toByte() }.toByteArray()

private fun ByteArray.toHex(): String =
    joinToString("") { "%02x".format(it) }

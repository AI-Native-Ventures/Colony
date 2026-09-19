/// NIP-49 encrypted secret keys, the format of the account backup.
///
/// Signing in returns a `passwordBlob`, which is an `ncryptsec1…` string
/// holding the identity encrypted under the password. Nothing but the device
/// can open it: the relay stores it opaquely.
///
/// The parameters here are pinned against the Rust the desktop already uses,
/// `nostr`'s `nips::nip49` (`ScryptParams::new(log_n, 8, 1, 32)`, XChaCha20
/// Poly1305 with the key-security byte as associated data, and an NFKC
/// normalised password). A blob is produced by one implementation and opened
/// by another, so a disagreement here presents as a correct password failing.
library;

import 'dart:convert';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:bech32/bech32.dart' as bech32;
import 'package:cryptography/cryptography.dart' as crypto;
import 'package:pointycastle/export.dart';
import 'package:unorm_dart/unorm_dart.dart' as unorm;

/// Human-readable part of the bech32 encoding.
const ncryptsecHrp = 'ncryptsec';

/// Only version 0x02 has ever been defined.
const ncryptsecVersion = 0x02;

/// Highest scrypt cost this build will attempt.
///
/// Mirrors `MAX_VERIFY_LOG_N` in `desktop/src-tauri/src/key_backup.rs`, which
/// is also the cost desktop emits. NIP-49 lets the writer choose `log_n`, and
/// 2^18 already allocates 256 MiB, so an untrusted blob must not be able to
/// ask a phone for more before its password has even been checked.
const ncryptsecMaxLogN = 18;

const _saltLength = 16;
const _nonceLength = 24;
const _secretKeyLength = 32;
const _macLength = 16;
const _payloadLength =
    2 + _saltLength + _nonceLength + 1 + _secretKeyLength + _macLength;

/// A bech32 string long enough for a 91-byte payload. `package:bech32`
/// defaults to the 90-character BIP-173 cap, which every ncryptsec exceeds.
const _maxBech32Length = 512;

/// Why a backup could not be opened.
enum NcryptsecFailure {
  /// Not a well-formed `ncryptsec1…` string.
  malformed,

  /// Well formed, but asks for more scrypt work than this build will do.
  unsupportedCost,

  /// The password does not open it, or the bytes have been damaged.
  wrongPassword,
}

/// Thrown by [decryptNcryptsec]. Carries a reason, not a message: a screen
/// that printed a cipher error would say nothing a user could act on.
class NcryptsecException implements Exception {
  const NcryptsecException(this.failure);

  final NcryptsecFailure failure;

  @override
  String toString() => 'NcryptsecException(${failure.name})';
}

/// The parsed parts of a backup, before any password work.
class NcryptsecPayload {
  const NcryptsecPayload({
    required this.logN,
    required this.salt,
    required this.nonce,
    required this.keySecurity,
    required this.ciphertext,
  });

  final int logN;
  final Uint8List salt;
  final Uint8List nonce;

  /// Carried as associated data, so flipping it invalidates the ciphertext.
  final int keySecurity;

  /// The encrypted secret key with its Poly1305 tag appended.
  final Uint8List ciphertext;
}

/// Parse an `ncryptsec1…` string without doing any password work.
///
/// Separate from decryption so the cost can be inspected before 256 MiB is
/// allocated on a phone.
NcryptsecPayload parseNcryptsec(String input) {
  final bytes = _decodeBech32(input.trim());
  if (bytes.length != _payloadLength || bytes[0] != ncryptsecVersion) {
    throw const NcryptsecException(NcryptsecFailure.malformed);
  }
  var offset = 2;
  Uint8List take(int length) {
    final slice = Uint8List.sublistView(bytes, offset, offset + length);
    offset += length;
    return slice;
  }

  final logN = bytes[1];
  final salt = take(_saltLength);
  final nonce = take(_nonceLength);
  final keySecurity = bytes[offset];
  offset += 1;
  final ciphertext = take(_secretKeyLength + _macLength);
  return NcryptsecPayload(
    logN: logN,
    salt: salt,
    nonce: nonce,
    keySecurity: keySecurity,
    ciphertext: ciphertext,
  );
}

/// Decrypt a backup into its 32 secret-key bytes.
///
/// The scrypt work runs on its own isolate: at the cost desktop writes it is
/// seconds of CPU and a quarter of a gigabyte, which must not happen on the
/// frame-producing isolate.
Future<Uint8List> decryptNcryptsec({
  required String ncryptsec,
  required String password,
  int maxLogN = ncryptsecMaxLogN,
}) async {
  final payload = parseNcryptsec(ncryptsec);
  if (payload.logN > maxLogN) {
    throw const NcryptsecException(NcryptsecFailure.unsupportedCost);
  }

  final key = await Isolate.run(
    () => deriveNcryptsecKey(
      password: password,
      salt: payload.salt,
      logN: payload.logN,
    ),
  );

  try {
    final plaintext = await crypto.Xchacha20.poly1305Aead().decrypt(
      crypto.SecretBox(
        Uint8List.sublistView(payload.ciphertext, 0, _secretKeyLength),
        nonce: payload.nonce,
        mac: crypto.Mac(
          Uint8List.sublistView(payload.ciphertext, _secretKeyLength),
        ),
      ),
      secretKey: crypto.SecretKey(key),
      aad: [payload.keySecurity],
    );
    return Uint8List.fromList(plaintext);
  } on crypto.SecretBoxAuthenticationError {
    // The only honest reading: either the password is wrong or the bytes are
    // damaged, and the tag cannot tell those apart.
    throw const NcryptsecException(NcryptsecFailure.wrongPassword);
  }
}

/// The NIP-49 key derivation: scrypt over the NFKC-normalised password.
///
/// NFKC here is not optional and not symmetric with the account key. NIP-49
/// normalises (`normalize_password` in the Rust crate's `nip49.rs`), while
/// `deriveAuthKey` deliberately does not, so the same typed password takes
/// two different paths inside one sign-in.
Uint8List deriveNcryptsecKey({
  required String password,
  required Uint8List salt,
  required int logN,
}) {
  final normalised = Uint8List.fromList(utf8.encode(unorm.nfkc(password)));
  final derivator = Scrypt()
    ..init(ScryptParameters(1 << logN, 8, 1, _secretKeyLength, salt));
  return derivator.process(normalised);
}

Uint8List _decodeBech32(String input) {
  // package:bech32 raises a dozen unrelated exception types with no common
  // base, and every one of them means the same thing here.
  final bech32.Bech32 decoded;
  try {
    decoded = bech32.bech32.decode(input, _maxBech32Length);
  } on Exception {
    throw const NcryptsecException(NcryptsecFailure.malformed);
  }
  if (decoded.hrp != ncryptsecHrp) {
    throw const NcryptsecException(NcryptsecFailure.malformed);
  }
  return _fromFiveBit(decoded.data);
}

/// Regroup bech32's 5-bit words back into bytes, dropping the trailing
/// padding bits the encoder added.
Uint8List _fromFiveBit(List<int> words) {
  var accumulator = 0;
  var bits = 0;
  final out = <int>[];
  for (final word in words) {
    if (word < 0 || word > 31) {
      throw const NcryptsecException(NcryptsecFailure.malformed);
    }
    accumulator = (accumulator << 5) | word;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.add((accumulator >> bits) & 0xff);
    }
  }
  if (bits >= 5 || ((accumulator << (8 - bits)) & 0xff) != 0) {
    throw const NcryptsecException(NcryptsecFailure.malformed);
  }
  return Uint8List.fromList(out);
}

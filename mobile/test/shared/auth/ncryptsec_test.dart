import 'dart:typed_data';

import 'package:buzz/shared/auth/ncryptsec.dart';
import 'package:flutter_test/flutter_test.dart';

/// The published NIP-49 test vector.
///
/// Deliberately somebody else's numbers rather than a blob this code produced:
/// a round trip against ourselves would pass just as happily with the wrong
/// nonce placement, the wrong associated data, or no NFKC at all. The same
/// vector is already in the desktop tree, at
/// `desktop/src-tauri/src/egress_guard_tests.rs`, and the Rust that writes
/// Colony's real backups (`nostr`'s `nips::nip49`) is pinned against it too,
/// so agreeing with it is agreeing with the producer.
const specNcryptsec =
    'ncryptsec1qgg9947rlpvqu76pj5ecreduf9jxhselq2nae2kghhvd5g7dgjtcxfqtd67p9m0'
    'w57lspw8gsq6yphnm8623nsl8xn9j4jdzz84zm3frztj3z7s35vpzmqf6ksu8r89qk5z2zxfm'
    'u5gv8th8wclt0h4p';
const specPassword = 'nostr';
const specSecretKey =
    '3501454135014541350145413501453fefb02227e449e57cf4d3a3ce05378683';

String _hex(List<int> bytes) =>
    bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

void main() {
  group('parseNcryptsec', () {
    test('reads the published vector without doing password work', () {
      final payload = parseNcryptsec(specNcryptsec);

      expect(payload.logN, 16);
      expect(payload.salt, hasLength(16));
      expect(payload.nonce, hasLength(24));
      expect(payload.ciphertext, hasLength(48));
    });

    test('tolerates surrounding whitespace and uppercase', () {
      // bech32 permits an all-uppercase encoding, and a pasted blob arrives
      // with whatever the clipboard had around it.
      expect(
        parseNcryptsec('  ${specNcryptsec.toUpperCase()}  ').logN,
        parseNcryptsec(specNcryptsec).logN,
      );
    });

    test('refuses anything that is not an ncryptsec', () {
      for (final input in <String>[
        '',
        'ncryptsec1',
        'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5',
        specNcryptsec.substring(0, specNcryptsec.length - 1),
        '${specNcryptsec}q',
      ]) {
        expect(
          () => parseNcryptsec(input),
          throwsA(
            isA<NcryptsecException>().having(
              (e) => e.failure,
              'failure',
              NcryptsecFailure.malformed,
            ),
          ),
          reason: input,
        );
      }
    });
  });

  group('decryptNcryptsec', () {
    test('opens the published vector', () async {
      final secret = await decryptNcryptsec(
        ncryptsec: specNcryptsec,
        password: specPassword,
      );

      expect(_hex(secret), specSecretKey);
    }, timeout: const Timeout(Duration(minutes: 2)));

    test('refuses a wrong password', () async {
      await expectLater(
        decryptNcryptsec(ncryptsec: specNcryptsec, password: 'not nostr'),
        throwsA(
          isA<NcryptsecException>().having(
            (e) => e.failure,
            'failure',
            NcryptsecFailure.wrongPassword,
          ),
        ),
      );
    }, timeout: const Timeout(Duration(minutes: 2)));

    test('refuses a cost above the cap before deriving anything', () async {
      // The cap exists so an untrusted blob cannot ask a phone for gigabytes
      // before its password has even been checked, so this must fail fast
      // rather than after the work.
      await expectLater(
        decryptNcryptsec(
          ncryptsec: specNcryptsec,
          password: specPassword,
          maxLogN: 15,
        ),
        throwsA(
          isA<NcryptsecException>().having(
            (e) => e.failure,
            'failure',
            NcryptsecFailure.unsupportedCost,
          ),
        ),
      );
    });
  });

  group('deriveNcryptsecKey', () {
    test('NFKC-normalises the password, unlike the account key', () {
      // NIP-49 normalises and deriveAuthKey does not, so one typed password
      // takes two different paths inside a single sign-in. Both spellings of
      // an accented password must open the same backup.
      final salt = Uint8List.fromList(List<int>.filled(16, 7));
      final composed = deriveNcryptsecKey(
        password: 'caf\u00e9 battery staple',
        salt: salt,
        logN: 8,
      );
      final decomposed = deriveNcryptsecKey(
        password: 'café battery staple',
        salt: salt,
        logN: 8,
      );

      expect(_hex(composed), _hex(decomposed));
    });

    test('a different salt derives a different key', () {
      expect(
        _hex(
          deriveNcryptsecKey(
            password: specPassword,
            salt: Uint8List.fromList(List<int>.filled(16, 1)),
            logN: 8,
          ),
        ),
        isNot(
          _hex(
            deriveNcryptsecKey(
              password: specPassword,
              salt: Uint8List.fromList(List<int>.filled(16, 2)),
              logN: 8,
            ),
          ),
        ),
      );
    });
  });
}

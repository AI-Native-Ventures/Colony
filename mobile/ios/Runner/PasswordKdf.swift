import CommonCrypto
import Flutter
import Foundation

/// Native PBKDF2 for the email-and-password account key.
///
/// Pure Dart needs 6.1 s for the 600,000 HMAC-SHA256 rounds sign-in requires,
/// measured AOT on an Apple M1 Max, against 76 ms natively. This exists to
/// close that gap; it is not a convenience.
///
/// Bytes in, bytes out. Nothing here normalises, trims or re-encodes its
/// inputs, and it must stay that way: the Dart side owns encoding, and a
/// native half that quietly disagreed about it would derive a different key
/// from the same password with no error to show for it.
enum PasswordKdf {
  static let channelName = "buzz/password_kdf"

  private static let deriveMethod = "pbkdf2HmacSha256"

  static func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    guard call.method == deriveMethod else {
      result(FlutterMethodNotImplemented)
      return
    }
    guard
      let arguments = call.arguments as? [String: Any],
      let password = arguments["password"] as? FlutterStandardTypedData,
      let salt = arguments["salt"] as? FlutterStandardTypedData,
      let iterations = arguments["iterations"] as? Int,
      let length = arguments["length"] as? Int,
      iterations > 0,
      length > 0,
      !salt.data.isEmpty
    else {
      result(
        FlutterError(
          code: "invalid_arguments",
          message: "Expected password and salt bytes with positive iterations and length.",
          details: nil
        )
      )
      return
    }

    // Hundreds of milliseconds of hashing has no business on the main thread.
    DispatchQueue.global(qos: .userInitiated).async {
      let derived = derive(
        password: password.data,
        salt: salt.data,
        iterations: iterations,
        length: length
      )
      DispatchQueue.main.async {
        guard let derived else {
          result(
            FlutterError(
              code: "derivation_failed",
              message: "CCKeyDerivationPBKDF rejected the request.",
              details: nil
            )
          )
          return
        }
        result(FlutterStandardTypedData(bytes: derived))
      }
    }
  }

  /// PBKDF2-HMAC-SHA256 over raw bytes.
  ///
  /// Internal rather than private so `RunnerTests` can assert it against the
  /// same pinned vector the Dart and Kotlin sides assert.
  static func derive(
    password: Data,
    salt: Data,
    iterations: Int,
    length: Int
  ) -> Data? {
    guard !salt.isEmpty, length > 0, iterations > 0 else { return nil }
    var derived = Data(count: length)
    // An empty password is legal input to PBKDF2 but gives `withUnsafeBytes`
    // a nil base address, so it gets an explicit empty buffer instead.
    let password = password.isEmpty ? Data([]) : password
    let status: Int32 = derived.withUnsafeMutableBytes { derivedBytes in
      salt.withUnsafeBytes { saltBytes in
        password.withUnsafeBytes { passwordBytes in
          CCKeyDerivationPBKDF(
            CCPBKDFAlgorithm(kCCPBKDF2),
            passwordBytes.baseAddress?.assumingMemoryBound(to: CChar.self),
            password.count,
            saltBytes.baseAddress?.assumingMemoryBound(to: UInt8.self),
            salt.count,
            CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
            UInt32(iterations),
            derivedBytes.baseAddress?.assumingMemoryBound(to: UInt8.self),
            length
          )
        }
      }
    }
    return status == kCCSuccess ? derived : nil
  }
}

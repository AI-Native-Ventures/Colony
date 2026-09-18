import 'dart:async';

import 'package:http/http.dart' as http;

/// Owns the reusable HTTP transport used for relay `/query` requests.
///
/// A fresh [http.Client] per query throws away the connection every time, so
/// a screen that issues several reads pays a new TCP and TLS handshake for
/// each one. This keeps a single client alive across queries.
///
/// A timed-out request is the case worth the extra machinery: its connection
/// may still be occupied, so the client is retired rather than reused, new
/// queries get a fresh one immediately, and the retired one is closed only
/// once the requests still running on it have finished.
class RelayHttpQueryClient {
  RelayHttpQueryClient({
    http.Client? client,
    http.Client Function()? clientFactory,
  }) : _injectedClient = client,
       _clientFactory = clientFactory ?? (() => http.Client());

  final http.Client? _injectedClient;
  final http.Client Function() _clientFactory;
  _ClientGeneration? _currentGeneration;
  final Set<_ClientGeneration> _generations = {};

  Future<http.Response> post(
    Uri url, {
    required Map<String, String> headers,
    required List<int> body,
    required Duration timeout,
  }) async {
    final generation = _injectedClient == null
        ? (_currentGeneration ??= _createGeneration())
        : null;
    generation?.acquire();
    try {
      return await (_injectedClient ?? generation!.client)
          .post(url, headers: headers, body: body)
          .timeout(timeout);
    } on TimeoutException {
      if (identical(_currentGeneration, generation)) {
        _currentGeneration = null;
      }
      generation?.retire();
      rethrow;
    } finally {
      generation?.release();
    }
  }

  void close() {
    for (final generation in _generations.toList()) {
      generation.close();
    }
    _currentGeneration = null;
    _injectedClient?.close();
  }

  _ClientGeneration _createGeneration() {
    late final _ClientGeneration generation;
    generation = _ClientGeneration(
      _clientFactory(),
      onClosed: () => _generations.remove(generation),
    );
    _generations.add(generation);
    return generation;
  }
}

/// One transport and the requests still using it.
class _ClientGeneration {
  _ClientGeneration(this.client, {required this.onClosed});

  final http.Client client;
  final void Function() onClosed;
  int _activeRequests = 0;
  bool _retired = false;
  bool _closed = false;

  void acquire() {
    assert(!_closed);
    _activeRequests++;
  }

  void release() {
    assert(_activeRequests > 0);
    _activeRequests--;
    _closeIfIdle();
  }

  void retire() {
    _retired = true;
    _closeIfIdle();
  }

  void close() {
    if (_closed) return;
    _closed = true;
    client.close();
    onClosed();
  }

  void _closeIfIdle() {
    if (_retired && _activeRequests == 0) close();
  }
}

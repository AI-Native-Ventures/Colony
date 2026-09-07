//! Bounded, private parent/child protocol. Payloads must never be logged.
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, Read, Write};

pub(super) const MAX_FRAME: usize = 16 * 1024 * 1024;
pub(super) const PREFIX: &str = "@colony-native:";

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Request {
    Invoke {
        id: u64,
        command: String,
        #[serde(default)]
        args: Value,
        #[serde(default)]
        binary: Option<String>,
        #[serde(default)]
        headers: HashMap<String, String>,
    },
    Listen {
        id: u64,
        event: String,
    },
    Unlisten {
        id: u64,
        subscription: u64,
    },
    Emit {
        id: u64,
        event: String,
        #[serde(default)]
        payload: Value,
    },
    Shutdown {},
}

/// Read one newline-terminated message without allocating beyond the limit.
pub(super) fn read(reader: &mut impl BufRead) -> Result<Option<Request>, &'static str> {
    let mut bytes = Vec::new();
    loop {
        if bytes.len() > MAX_FRAME {
            return Err("Invalid native frame length");
        }
        let result = reader
            .take((MAX_FRAME + 1 - bytes.len()) as u64)
            .read_until(b'\n', &mut bytes);
        match result {
            Ok(0) if bytes.is_empty() => return Ok(None),
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                // Preserve a partial frame if a platform pipe temporarily has
                // no data; do not treat transient backpressure as EOF.
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(error) => {
                eprintln!("colony-native: input error kind {:?}", error.kind());
                return Err("Native request could not be read");
            }
        }
    }
    if bytes.len() > MAX_FRAME || bytes.last() != Some(&b'\n') {
        return Err("Invalid native frame length");
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "Invalid native request")
}

pub(super) fn send(value: &Value) -> Result<(), &'static str> {
    let data = serde_json::to_vec(value).map_err(|_| "Native response encoding failed")?;
    if data.len() > MAX_FRAME {
        return Err("Native response exceeds frame limit");
    }
    let stdout = std::io::stdout();
    let mut writer = stdout.lock();
    writer
        .write_all(PREFIX.as_bytes())
        .and_then(|_| writer.write_all(&data))
        .and_then(|_| writer.write_all(b"\n"))
        .and_then(|_| writer.flush())
        .map_err(|_| "Native response pipe closed")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn frames_are_bounded_and_never_echo_invalid_payloads() {
        let mut oversized = Cursor::new(vec![b'x'; MAX_FRAME + 1]);
        assert!(matches!(
            read(&mut oversized),
            Err("Invalid native frame length")
        ));
        let mut secret = Cursor::new(b"secret-credential\n");
        assert!(matches!(read(&mut secret), Err("Invalid native request")));
        assert!(read(&mut Cursor::new(b"{\"type\":\"shutdown\"}")).is_err());
    }

    #[test]
    fn messages_and_eof_are_distinct() {
        let mut stream = Cursor::new(
            b"{\"type\":\"listen\",\"id\":7,\"event\":\"ready\"}\n{\"type\":\"shutdown\"}\n",
        );
        assert!(matches!(
            read(&mut stream),
            Ok(Some(Request::Listen { id: 7, .. }))
        ));
        assert!(matches!(read(&mut stream), Ok(Some(Request::Shutdown {}))));
        assert!(matches!(read(&mut stream), Ok(None)));
    }

    #[test]
    fn transient_nonblocking_reads_preserve_partial_frames() {
        struct Input(usize);
        impl std::io::Read for Input {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                let chunk: &[u8] = match self.0 {
                    0 => b"{\"type\":\"shutdown\"",
                    1 => {
                        self.0 += 1;
                        return Err(std::io::ErrorKind::WouldBlock.into());
                    }
                    2 => b"}\n",
                    _ => return Ok(0),
                };
                self.0 += 1;
                buffer[..chunk.len()].copy_from_slice(chunk);
                Ok(chunk.len())
            }
        }
        let mut reader = std::io::BufReader::new(Input(0));
        assert!(matches!(read(&mut reader), Ok(Some(Request::Shutdown {}))));
    }

    #[test]
    fn unknown_fields_and_wrong_argument_types_fail() {
        assert!(read(&mut Cursor::new(
            b"{\"type\":\"shutdown\",\"secret\":\"ignored?\"}\n"
        ))
        .is_err());
        assert!(read(&mut Cursor::new(
            b"{\"type\":\"invoke\",\"id\":1,\"command\":false}\n"
        ))
        .is_err());
    }
}

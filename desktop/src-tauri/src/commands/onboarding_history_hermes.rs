//! Read-only Hermes CLI sessions. Never include third-party messaging sessions.
use super::onboarding_history::{regular_path, HistoryFile};
use rusqlite::{Connection, OpenFlags};
use std::path::Path;

fn database(path: &Path) -> Result<Connection, String> {
    if !regular_path(path)
        || std::fs::metadata(path)
            .map_err(|_| "Hermes history unavailable")?
            .len()
            > 256 * 1024 * 1024
    {
        return Err("Hermes history is unavailable or exceeds the import limit".into());
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|_| "Hermes history cannot be opened read-only")?;
    connection
        .busy_timeout(std::time::Duration::from_millis(250))
        .map_err(|e| e.to_string())?;
    connection
        .pragma_update(None, "trusted_schema", false)
        .map_err(|e| e.to_string())?;
    Ok(connection)
}
/// Count bounded CLI session metadata without fetching messages.
pub(super) fn count(path: &Path) -> Result<usize, String> {
    database(path)?
        .query_row(
            "SELECT count(*) FROM (SELECT id FROM sessions WHERE source = 'cli' LIMIT 201)",
            [],
            |row| row.get(0),
        )
        .map_err(|_| "Unsupported Hermes session schema".into())
}
/// Read bounded user messages, excluding assistant/tool text and gateway users.
pub(super) fn read(path: &Path) -> Result<Vec<HistoryFile>, String> {
    let connection = database(path)?;
    let mut query = connection.prepare("SELECT m.session_id, m.content, m.timestamp FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.source = 'cli' AND m.role = 'user' AND length(m.content) BETWEEN 1 AND 6000 ORDER BY m.timestamp DESC LIMIT 2000").map_err(|_| "Unsupported Hermes message schema")?;
    let rows = query
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, f64>(2)?,
            ))
        })
        .map_err(|_| "Hermes history unavailable")?;
    let mut text = String::new();
    for row in rows {
        let (session, content, time) = row.map_err(|_| "Invalid Hermes message")?;
        let date = chrono::DateTime::from_timestamp(time as i64, 0).map(|v| v.to_rfc3339());
        let line = serde_json::json!({"type":"user","timestamp":date,"session":session,"message":{"role":"user","content":content}}).to_string();
        if text.len() + line.len() + 1 > 1024 * 1024 {
            break;
        }
        text.push_str(&line);
        text.push('\n');
    }
    Ok(vec![HistoryFile {
        source: "hermes".into(),
        name: "Hermes CLI sessions".into(),
        text,
    }])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_cli_user_messages_are_read() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().canonicalize()?.join("state.db");
        let db = Connection::open(&path)?;
        db.execute_batch("CREATE TABLE sessions(id TEXT, source TEXT); CREATE TABLE messages(session_id TEXT, role TEXT, content TEXT, timestamp REAL); INSERT INTO sessions VALUES ('a','cli'),('b','telegram'); INSERT INTO messages VALUES ('a','user','I prefer clear updates.',1),('a','assistant','assistant claim',2),('b','user','third party text',3);")?;
        assert_eq!(count(&path)?, 1);
        let rows = read(&path)?;
        assert!(rows[0].text.contains("I prefer clear updates."));
        assert!(!rows[0].text.contains("assistant claim"));
        assert!(!rows[0].text.contains("third party text"));
        Ok(())
    }
}

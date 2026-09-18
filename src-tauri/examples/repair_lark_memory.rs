//! Bounded maintenance tool; not an application startup migration.
//! Preview: cargo run --example repair_lark_memory -- --database DB --source FILE
//! Apply the same selection with --apply --backup NEW_BACKUP_PATH.
use std::{
    collections::{BTreeMap, HashSet},
    error::Error,
    ops::Range,
    path::PathBuf,
};

use clap::Parser;
use loam_lib::memory::{
    config::read_global_config, embedder::build_embedder, lark_export::LarkDocument,
};
use mempal_runtime::{
    core::{db::Database, types::SourceType, utils::build_bootstrap_evidence_drawer_id},
    embed::Embedder,
    ingest::chunk::chunk_text,
};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use tauri::async_runtime::block_on;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

#[derive(Parser)]
struct Args {
    #[arg(long)]
    database: PathBuf,
    #[arg(long, required = true)]
    source: Vec<String>,
    #[arg(long)]
    apply: bool,
    #[arg(long, requires = "apply")]
    backup: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq)]
struct Stored {
    id: String,
    content: String,
    index: usize,
    deleted: Option<String>,
    wing: String,
    room: Option<String>,
    source: String,
    snapshot: String,
}

#[derive(Serialize)]
struct Replacement {
    old_id: String,
    new_id: Option<String>,
    #[serde(skip)]
    content: String,
}
struct Plan {
    before: Vec<Stored>,
    changes: Vec<Replacement>,
}

fn columns(connection: &Connection) -> Result<Vec<String>> {
    Ok(connection
        .prepare("PRAGMA table_info(drawers)")?
        .query_map([], |r| r.get(1))?
        .collect::<std::result::Result<_, _>>()?)
}
fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\""))
}
fn snapshot(connection: &Connection, source: &str) -> Result<Vec<Stored>> {
    let names = columns(connection)?
        .iter()
        .map(|s| quoted(s))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!("SELECT *, json_array({names}) AS snapshot FROM drawers WHERE source_file=?1 ORDER BY wing,room,chunk_index,id");
    Ok(connection
        .prepare(&sql)?
        .query_map([source], |r| {
            Ok(Stored {
                id: r.get("id")?,
                content: r.get("content")?,
                index: r.get("chunk_index")?,
                deleted: r.get("deleted_at")?,
                wing: r.get("wing")?,
                room: r.get("room")?,
                source: r.get("source_file")?,
                snapshot: r.get("snapshot")?,
            })
        })?
        .collect::<std::result::Result<_, _>>()?)
}

fn reconstruct(rows: &[Stored]) -> Result<(String, Vec<Range<usize>>)> {
    let first = rows.first().ok_or("no source chunks")?;
    let mut text = first.content.clone();
    let mut ranges = vec![0..text.len()];
    if first.index != 0 {
        return Err("first source chunk is missing".into());
    }
    for (index, row) in rows.iter().enumerate().skip(1) {
        if row.index != index {
            return Err(format!("missing or duplicate source chunk at {index}").into());
        }
        let overlap = row
            .content
            .char_indices()
            .map(|(i, _)| i)
            .chain([row.content.len()])
            .filter(|&i| {
                row.content[..i].chars().count() <= 100 && text.ends_with(&row.content[..i])
            })
            .max()
            .unwrap_or(0);
        if overlap == 0 {
            return Err(format!("cannot verify overlap at chunk {index}").into());
        }
        let start = text.len() - overlap;
        text.push_str(&row.content[overlap..]);
        ranges.push(start..text.len());
    }
    // JSON validity alone cannot detect an accidental merge of repeated table rows.
    if chunk_text(&text, 800, 100) != rows.iter().map(|r| r.content.clone()).collect::<Vec<_>>() {
        return Err("reconstructed source does not reproduce the stored chunks".into());
    }
    Ok((text, ranges))
}

fn plan(connection: &Connection, sources: &[String]) -> Result<Plan> {
    let mut before = Vec::new();
    let mut changes = Vec::new();
    for source in sources {
        let rows = snapshot(connection, source)?;
        if rows.is_empty() {
            return Err(format!("source not found: {source}").into());
        }
        if !rows
            .iter()
            .any(|r| r.deleted.is_none() && r.content.contains("\\u003clark-"))
        {
            continue;
        }
        let mut groups: BTreeMap<(String, Option<String>), Vec<Stored>> = BTreeMap::new();
        for row in &rows {
            groups
                .entry((row.wing.clone(), row.room.clone()))
                .or_default()
                .push(row.clone());
        }
        for group in groups.values() {
            let (raw, ranges) = reconstruct(group)?;
            let doc = LarkDocument::parse(&raw)?.ok_or("source is not a successful Lark export")?;
            for (row, range) in group.iter().zip(ranges) {
                if row.deleted.is_some() {
                    continue;
                }
                let content = doc.readable_range(range);
                if content == row.content {
                    continue;
                }
                let new_id = (!content.is_empty()).then(|| {
                    build_bootstrap_evidence_drawer_id(
                        &row.wing,
                        row.room.as_deref(),
                        &content,
                        &SourceType::Project,
                        Some(&row.source),
                    )
                });
                changes.push(Replacement {
                    old_id: row.id.clone(),
                    new_id,
                    content,
                });
            }
        }
        before.extend(rows);
    }
    Ok(Plan { before, changes })
}

fn check_unreferenced(connection: &Connection, changes: &[Replacement]) -> Result<()> {
    for item in changes {
        let references: i64 = connection.query_row(
            "SELECT (SELECT count(*) FROM drawers d WHERE d.deleted_at IS NULL AND (
                EXISTS(SELECT 1 FROM json_each(d.supporting_refs) WHERE value=?1) OR
                EXISTS(SELECT 1 FROM json_each(d.verification_refs) WHERE value=?1) OR
                EXISTS(SELECT 1 FROM json_each(d.counterexample_refs) WHERE value=?1) OR
                EXISTS(SELECT 1 FROM json_each(d.teaching_refs) WHERE value=?1))) +
                (SELECT count(*) FROM knowledge_evidence_links WHERE evidence_drawer_id=?1) +
                (SELECT count(*) FROM triples WHERE source_drawer=?1 OR subject=?1 OR object=?1)",
            [&item.old_id],
            |r| r.get(0),
        )?;
        if references != 0 {
            return Err(format!("{} has references; no data changed", item.old_id).into());
        }
        let eligible: bool = connection.query_row(
            "SELECT memory_kind='evidence' AND source_type='project' AND deleted_at IS NULL FROM drawers WHERE id=?1",
            [&item.old_id], |r| r.get(0))?;
        if !eligible {
            return Err("source item is not active project material".into());
        }
    }
    Ok(())
}

fn apply(connection: &mut Connection, plan: &Plan, vectors: &[Vec<f32>]) -> Result<()> {
    if vectors.len() != plan.changes.len() {
        return Err("embedding count mismatch".into());
    }
    let transaction = connection.transaction()?;
    let mut current = Vec::new();
    let mut sources = HashSet::new();
    for row in &plan.before {
        if sources.insert(&row.source) {
            current.extend(snapshot(&transaction, &row.source)?);
        }
    }
    if current != plan.before {
        return Err("source changed since preview; no data changed".into());
    }
    check_unreferenced(&transaction, &plan.changes)?;
    let names = columns(&transaction)?;
    let select = names
        .iter()
        .map(|s| match s.as_str() {
            "id" => "?1".into(),
            "content" => "?2".into(),
            _ => quoted(s),
        })
        .collect::<Vec<_>>()
        .join(",");
    let names = names
        .iter()
        .map(|s| quoted(s))
        .collect::<Vec<_>>()
        .join(",");
    let insert = format!("INSERT INTO drawers ({names}) SELECT {select} FROM drawers WHERE id=?3 AND deleted_at IS NULL");
    let timestamp = mempal_runtime::core::utils::current_timestamp();
    for (change, vector) in plan.changes.iter().zip(vectors) {
        if let Some(new_id) = &change.new_id {
            if new_id == &change.old_id {
                return Err("replacement ID equals source ID".into());
            }
            let existing: Option<(String, Option<String>)> = transaction
                .query_row(
                    "SELECT content,deleted_at FROM drawers WHERE id=?1",
                    [new_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            match existing {
                Some((content, None)) if content == change.content => {}
                Some(_) => {
                    return Err("replacement ID collides with an existing/deleted item".into())
                }
                None => {
                    if transaction
                        .execute(&insert, params![new_id, change.content, change.old_id])?
                        != 1
                    {
                        return Err("source disappeared during repair".into());
                    }
                    transaction.execute(
                        "INSERT INTO drawer_vectors(id,embedding) VALUES(?1,vec_f32(?2))",
                        params![new_id, serde_json::to_string(vector)?],
                    )?;
                }
            }
        }
        if transaction.execute(
            "UPDATE drawers SET deleted_at=?1 WHERE id=?2 AND deleted_at IS NULL",
            params![timestamp, change.old_id],
        )? != 1
        {
            return Err("source disappeared during repair".into());
        }
    }
    transaction.commit()?;
    Ok(())
}

fn main() -> Result<()> {
    let args = Args::parse();
    if args.source.iter().collect::<HashSet<_>>().len() != args.source.len() {
        return Err("duplicate source argument".into());
    }
    let connection = Connection::open_with_flags(&args.database, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let version: i64 = connection.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version != 9 {
        return Err("this repair tool requires library schema 9".into());
    }
    let plan = plan(&connection, &args.source)?;
    check_unreferenced(&connection, &plan.changes)?;
    if args.apply && !plan.changes.is_empty() {
        let backup = args.backup.as_ref().ok_or("--apply requires --backup")?;
        if backup.exists() {
            return Err("backup already exists; refusing overwrite".into());
        }
        // Registration applies only to connections opened afterward.
        let database = Database::open(&args.database)?;
        let mut connection =
            Connection::open_with_flags(&args.database, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        connection.execute(
            "VACUUM INTO ?1",
            [backup.to_str().ok_or("invalid backup path")?],
        )?;
        let embedder = build_embedder(&read_global_config()?)?;
        let dimension: i64 = connection.query_row(
            "SELECT vec_length(embedding) FROM drawer_vectors LIMIT 1",
            [],
            |r| r.get(0),
        )?;
        if dimension as usize != embedder.dimensions() {
            return Err("embedding dimension mismatch".into());
        }
        let texts = plan
            .changes
            .iter()
            .map(|p| p.content.as_str())
            .collect::<Vec<_>>();
        let vectors = block_on(embedder.embed(&texts))?;
        apply(&mut connection, &plan, &vectors)?;
        drop(database);
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "applied":args.apply,"sources":args.source,"replaced":plan.changes.len(),
            "preservedDeleted":plan.before.iter().filter(|r|r.deleted.is_some()).count(),
            "backup":args.backup,"mapping":plan.changes
        }))?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mempal_runtime::core::types::{BootstrapEvidenceArgs, Drawer};

    fn fixture() -> (tempfile::TempDir, Database, Connection, Vec<String>) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("palace.db");
        let db = Database::open(&path).unwrap();
        let body = (0..90)
            .map(|i| {
                format!(
                    "<lark-tr><lark-td>字段{i}</lark-td><lark-td>正文内容{i}</lark-td></lark-tr>\n"
                )
            })
            .collect::<String>();
        let prose = (0..900).map(|i| format!("plain{i} ")).collect::<String>();
        let raw = serde_json::json!({"ok":true,"data":{"doc_id":"d","markdown":format!("<lark-table>{body}</lark-table>\n{prose}")}})
            .to_string().replace('<',"\\u003c").replace('>',"\\u003e");
        let source = "export.json".to_string();
        for (index, content) in chunk_text(&raw, 800, 100).into_iter().enumerate() {
            let item = Drawer::new_bootstrap_evidence(BootstrapEvidenceArgs {
                id: build_bootstrap_evidence_drawer_id(
                    "test",
                    Some("docs"),
                    &content,
                    &SourceType::Project,
                    Some(&source),
                ),
                content,
                wing: "test".into(),
                room: Some("docs".into()),
                source_file: Some(source.clone()),
                source_type: SourceType::Project,
                added_at: "10".into(),
                chunk_index: Some(index as i64),
                importance: 2,
            });
            db.insert_drawer(&item).unwrap();
            db.insert_vector(&item.id, &[1.0, 0.5]).unwrap();
        }
        let connection = Connection::open(path).unwrap();
        (dir, db, connection, vec![source])
    }
    #[test]
    fn repairs_active_chunks_and_vectors_without_resurrecting_deleted_material() {
        let (_dir, db, mut con, sources) = fixture();
        let deleted_id = snapshot(&con, &sources[0]).unwrap()[2].id.clone();
        db.soft_delete_drawer(&deleted_id).unwrap();
        let before = snapshot(&con, &sources[0]).unwrap();
        let planned = plan(&con, &sources).unwrap();
        assert_eq!(
            snapshot(&con, &sources[0]).unwrap(),
            before,
            "preview is read only"
        );
        assert!(
            planned.changes.len() < before.len() - 1,
            "unchanged plain chunks must be preserved"
        );
        assert!(!planned.changes.iter().any(|r| r.old_id == deleted_id));
        apply(
            &mut con,
            &planned,
            &vec![vec![0.25, 0.75]; planned.changes.len()],
        )
        .unwrap();
        let after = snapshot(&con, &sources[0]).unwrap();
        assert_eq!(
            after.iter().find(|r| r.id == deleted_id),
            before.iter().find(|r| r.id == deleted_id)
        );
        for row in &before {
            if !planned.changes.iter().any(|c| c.old_id == row.id) {
                assert_eq!(after.iter().find(|r| r.id == row.id), Some(row));
            }
        }
        for change in &planned.changes {
            let old = after.iter().find(|r| r.id == change.old_id).unwrap();
            assert!(old.deleted.is_some());
            if let Some(id) = &change.new_id {
                let new = after.iter().find(|r| r.id == *id).unwrap();
                assert!(new.deleted.is_none());
                assert_eq!(
                    (&new.source, &new.wing, &new.room, new.index),
                    (&old.source, &old.wing, &old.room, old.index)
                );
                assert!(!new.content.contains("\\u003c"));
                assert!(!new.content.contains("lark-"));
                let vector: String = con
                    .query_row(
                        "SELECT vec_to_json(embedding) FROM drawer_vectors WHERE id=?1",
                        [id],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert_eq!(
                    serde_json::from_str::<Vec<f32>>(&vector).unwrap(),
                    vec![0.25, 0.75]
                );
            }
        }
        assert!(
            plan(&con, &sources).unwrap().changes.is_empty(),
            "rerun must be a no-op"
        );
        let matches: i64 = con
            .query_row(
                "SELECT count(*) FROM drawers_fts WHERE drawers_fts MATCH 'lark'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(matches, 0, "FTS must not retain the raw markup");
    }
    #[test]
    fn changed_source_or_new_reference_aborts_without_writes() {
        let (_dir, _db, mut con, sources) = fixture();
        let planned = plan(&con, &sources).unwrap();
        let target = planned.changes[0].old_id.clone();
        con.execute("UPDATE drawers SET importance=9 WHERE id=?1", [&target])
            .unwrap();
        let before = snapshot(&con, &sources[0]).unwrap();
        assert!(apply(
            &mut con,
            &planned,
            &vec![vec![1.0, 0.5]; planned.changes.len()]
        )
        .is_err());
        assert_eq!(snapshot(&con, &sources[0]).unwrap(), before);
        let planned = plan(&con, &sources).unwrap();
        con.execute("INSERT INTO triples(id,subject,predicate,object,source_drawer) VALUES('t','a','b','c',?1)",[&target]).unwrap();
        assert!(apply(
            &mut con,
            &planned,
            &vec![vec![1.0, 0.5]; planned.changes.len()]
        )
        .is_err());
        assert_eq!(snapshot(&con, &sources[0]).unwrap(), before);
    }
    #[test]
    fn a_late_vector_error_rolls_back_text_fts_and_deletion_together() {
        let (_dir, _db, mut con, sources) = fixture();
        let before = snapshot(&con, &sources[0]).unwrap();
        let planned = plan(&con, &sources).unwrap();
        let mut vectors = vec![vec![1.0, 0.5]; planned.changes.len()];
        *vectors.last_mut().unwrap() = vec![1.0];
        assert!(apply(&mut con, &planned, &vectors).is_err());
        assert_eq!(snapshot(&con, &sources[0]).unwrap(), before);
        let count: i64 = con
            .query_row("SELECT count(*) FROM drawer_vectors", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count as usize, before.len());
    }
    #[test]
    fn missing_chunks_cannot_be_guessed_from_the_rest() {
        let (_dir, _db, con, sources) = fixture();
        let target = snapshot(&con, &sources[0]).unwrap()[2].id.clone();
        con.execute("DELETE FROM drawers WHERE id=?1", [target])
            .unwrap();
        assert!(plan(&con, &sources).is_err());
    }
}

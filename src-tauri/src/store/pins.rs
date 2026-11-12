//! Pinned objects and schemas (F-027): shown at the top of their connection's tree.

use rusqlite::{Row, params};

use super::{Store, now};
use crate::db::errors::YadbeError;
use crate::db::meta::ObjectKind;
use crate::db::object_model::PinnedObject;

const SCHEMA_KIND: &str = "schema";
const COLUMNS: &str = "connection_id, database_name, schema_name, kind, object_id, name";

fn kind_id(kind: Option<ObjectKind>) -> String {
    match kind {
        None => SCHEMA_KIND.to_owned(),
        Some(kind) => serde_json::to_value(kind)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default(),
    }
}

fn kind_of(id: &str) -> Option<Option<ObjectKind>> {
    if id == SCHEMA_KIND {
        return Some(None);
    }
    serde_json::from_value(serde_json::Value::String(id.to_owned()))
        .ok()
        .map(Some)
}

fn row_to_pin(row: &Row<'_>) -> rusqlite::Result<Option<PinnedObject>> {
    let schema: String = row.get(2)?;
    let kind: String = row.get(3)?;
    // A kind this version does not know (a later one wrote it): left out, not an error.
    let Some(kind) = kind_of(&kind) else {
        return Ok(None);
    };
    Ok(Some(PinnedObject {
        connection_id: row.get(0)?,
        database: row.get(1)?,
        schema: (!schema.is_empty()).then_some(schema),
        kind,
        id: row.get(4)?,
        name: row.get(5)?,
    }))
}

impl Store {
    /// Every pin of every connection, in the order they were pinned.
    pub fn list_pins(&self) -> Result<Vec<PinnedObject>, YadbeError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLUMNS} FROM pinned_objects ORDER BY connection_id, position"
        ))?;
        let rows = stmt.query_map([], row_to_pin)?;
        let mut pins = Vec::new();
        for pin in rows {
            pins.extend(pin?);
        }
        Ok(pins)
    }

    /// Pins an object (pinning it again keeps its place). Fails with `connectionNotFound`
    /// when the connection is gone.
    pub fn pin_object(&self, pin: &PinnedObject) -> Result<(), YadbeError> {
        let conn = self.conn();
        let exists: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM connections WHERE id = ?1)",
            params![pin.connection_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(YadbeError::connection_not_found(&pin.connection_id));
        }
        conn.execute(
            "INSERT INTO pinned_objects
               (connection_id, database_name, schema_name, kind, object_id, name, position, pinned_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6,
               (SELECT COALESCE(MAX(position) + 1, 0) FROM pinned_objects WHERE connection_id = ?1),
               ?7)
             ON CONFLICT (connection_id, database_name, schema_name, kind, object_id) DO NOTHING",
            params![
                pin.connection_id,
                pin.database,
                pin.schema.clone().unwrap_or_default(),
                kind_id(pin.kind),
                pin.id,
                pin.name,
                now()
            ],
        )?;
        Ok(())
    }

    /// Unpins an object; unpinning one that is not pinned does nothing.
    pub fn unpin_object(&self, pin: &PinnedObject) -> Result<(), YadbeError> {
        let conn = self.conn();
        conn.execute(
            "DELETE FROM pinned_objects
             WHERE connection_id = ?1 AND database_name = ?2 AND schema_name = ?3
               AND kind = ?4 AND object_id = ?5",
            params![
                pin.connection_id,
                pin.database,
                pin.schema.clone().unwrap_or_default(),
                kind_id(pin.kind),
                pin.id
            ],
        )?;
        Ok(())
    }

    /// Moves a pin to the new name of its renamed object. A routine's id (`name(args)`)
    /// is left alone: only a pin whose id is its name follows.
    pub fn rename_pin(&self, pin: &PinnedObject, new_name: &str) -> Result<(), YadbeError> {
        let conn = self.conn();
        let new_id = if pin.id == pin.name {
            new_name.to_owned()
        } else {
            pin.id.replacen(&pin.name, new_name, 1)
        };
        conn.execute(
            "UPDATE OR IGNORE pinned_objects SET name = ?6, object_id = ?7
             WHERE connection_id = ?1 AND database_name = ?2 AND schema_name = ?3
               AND kind = ?4 AND object_id = ?5",
            params![
                pin.connection_id,
                pin.database,
                pin.schema.clone().unwrap_or_default(),
                kind_id(pin.kind),
                pin.id,
                new_name,
                new_id
            ],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::config::sample_definition;
    use crate::db::engine::Engine;
    use crate::db::errors::ErrorCode;

    fn pin(
        connection_id: &str,
        schema: Option<&str>,
        kind: Option<ObjectKind>,
        name: &str,
    ) -> PinnedObject {
        PinnedObject {
            connection_id: connection_id.into(),
            database: "app".into(),
            schema: schema.map(str::to_owned),
            kind,
            name: name.into(),
            id: name.into(),
        }
    }

    fn with_connection() -> (Store, String) {
        let store = Store::open_in_memory().expect("store");
        let definition = sample_definition(Engine::Postgres)
            .normalized()
            .expect("valid");
        let saved = store.create_connection(&definition).expect("connection");
        (store, saved.id)
    }

    #[test]
    fn pins_keep_their_order_and_survive_a_second_pin() {
        let (store, id) = with_connection();
        let orders = pin(&id, Some("sales"), Some(ObjectKind::Table), "orders");
        let sales = pin(&id, Some("sales"), None, "sales");
        store.pin_object(&orders).expect("pin");
        store.pin_object(&sales).expect("pin");
        store.pin_object(&orders).expect("pinning twice is fine");
        assert_eq!(
            store.list_pins().expect("list"),
            vec![orders.clone(), sales.clone()]
        );
        store.unpin_object(&orders).expect("unpin");
        store
            .unpin_object(&orders)
            .expect("unpinning twice is fine");
        assert_eq!(store.list_pins().expect("list"), vec![sales]);
    }

    #[test]
    fn schema_less_engines_pin_with_no_schema() {
        let (store, id) = with_connection();
        let items = pin(&id, None, Some(ObjectKind::View), "items");
        store.pin_object(&items).expect("pin");
        assert_eq!(store.list_pins().expect("list"), vec![items]);
    }

    #[test]
    fn pins_go_with_their_connection_and_need_one() {
        let (store, id) = with_connection();
        store
            .pin_object(&pin(&id, None, Some(ObjectKind::Table), "t"))
            .expect("pin");
        store.delete_connection(&id).expect("delete");
        assert!(store.list_pins().expect("list").is_empty());
        let err = store
            .pin_object(&pin(&id, None, Some(ObjectKind::Table), "t"))
            .expect_err("no such connection");
        assert_eq!(err.code, ErrorCode::ConnectionNotFound);
    }

    #[test]
    fn a_pin_follows_a_rename() {
        let (store, id) = with_connection();
        let orders = pin(&id, Some("sales"), Some(ObjectKind::Table), "orders");
        store.pin_object(&orders).expect("pin");
        store.rename_pin(&orders, "sales_orders").expect("rename");
        let pins = store.list_pins().expect("list");
        assert_eq!(pins.len(), 1);
        assert_eq!(pins[0].name, "sales_orders");
        assert_eq!(pins[0].id, "sales_orders");
    }
}

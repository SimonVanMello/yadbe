//! The scan, conflict detection and import against an in-memory store and keychain.

use std::sync::Arc;

use super::*;
use crate::db::config::ConnectionDefinition;
use crate::db::engine::Engine;
use crate::secrets::MemoryKeychain;
use sources::blank;

fn stores() -> (Store, SecretStore) {
    (
        Store::open_in_memory().expect("store"),
        SecretStore::new(Arc::new(MemoryKeychain::default())),
    )
}

fn postgres(name: &str, host: &str, db: &str, user: &str) -> ConnectionDefinition {
    let mut definition = blank(Engine::Postgres, name);
    definition.host = host.into();
    definition.database = db.into();
    definition.username = user.into();
    definition
}

fn write(dir: &Path, name: &str, text: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, text).expect("writes");
    path
}

const PGPASS: &str =
    "db.example.com:5432:shop:app:s3cret\nreports.example.com:5432:rep:ro:pw-Zq9\n";

#[test]
fn scans_a_file_and_marks_the_connections_that_exist() {
    let (store, _) = stores();
    // Same target under another name, and another target under the same name.
    store
        .create_connection(&postgres("Shop DB", "DB.example.com", "shop", "app"))
        .expect("saved");
    store
        .create_connection(&postgres(
            "ro@reports.example.com/rep",
            "elsewhere",
            "x",
            "y",
        ))
        .expect("saved");
    let dir = tempfile::tempdir().expect("dir");
    let path = write(dir.path(), "pgpass", PGPASS);
    let scan = scan(
        ConnectionSourceKind::Pgpass,
        &path,
        &store.list_connections().expect("list"),
    )
    .expect("scans");
    assert_eq!(scan.connections.len(), 2);
    let first = scan.connections[0].conflict.as_ref().expect("same target");
    assert_eq!(
        (first.kind, first.existing_name.as_str()),
        (ConflictKind::SameTarget, "Shop DB")
    );
    let second = scan.connections[1].conflict.as_ref().expect("same name");
    assert_eq!(second.kind, ConflictKind::SameName);
    assert!(scan.connections.iter().all(|c| c.has_password));
    let json = serde_json::to_string(&scan.connections).expect("serializes");
    assert!(!json.contains("s3cret"), "a scan never carries a password");
}

#[test]
fn imports_with_folders_unique_names_and_passwords_in_the_keychain_only_on_request() {
    let (store, secrets) = stores();
    store
        .create_connection(&postgres("app@db.example.com/shop", "other", "o", "o"))
        .expect("saved");
    let dir = tempfile::tempdir().expect("dir");
    let path = write(dir.path(), "pgpass", PGPASS);
    let parse = || {
        parse_source(
            ConnectionSourceKind::Pgpass,
            &read_source_file(&path).expect("reads"),
        )
        .expect("parses")
    };

    // Without the passwords option nothing reaches the keychain.
    let keys = vec!["line 1".to_owned()];
    let result = import(&store, &secrets, parse(), &keys, false).expect("imports");
    assert_eq!(result.created.len(), 1);
    assert_eq!(
        result.created[0].definition.name,
        "app@db.example.com/shop (2)"
    );
    assert!(!result.created[0].definition.remember_password);
    assert_eq!(
        (result.passwords_stored, result.passwords_session_only),
        (0, 0)
    );
    assert!(
        secrets
            .get(&result.created[0].id, SecretKind::Password)
            .expect("get")
            .is_none()
    );

    // With it, the password is stored under the new connection id.
    let keys = vec!["line 2".to_owned()];
    let result = import(&store, &secrets, parse(), &keys, true).expect("imports");
    let saved = &result.created[0];
    assert_eq!(saved.definition.host, "reports.example.com");
    assert!(saved.definition.remember_password);
    assert_eq!(result.passwords_stored, 1);
    let stored = secrets
        .get(&saved.id, SecretKind::Password)
        .expect("get")
        .expect("a secret");
    assert_eq!(stored.expose(), "pw-Zq9");
    let rows = serde_json::to_string(&store.list_connections().expect("list")).expect("json");
    assert!(!rows.contains("pw-Zq9"), "the store holds no password");
    assert_eq!(store.list_connections().expect("list").len(), 3);
}

#[test]
fn recreates_nested_folders_once_and_reuses_existing_ones() {
    let (store, secrets) = stores();
    let existing = store.create_group("Prod", None).expect("group");
    let dir = tempfile::tempdir().expect("dir");
    let text = r#"{ "folders": { "EU": { "parent": "Prod" } },
      "connections": {
        "a": { "provider": "postgresql", "name": "A", "folder": "EU",
               "configuration": { "host": "a" } },
        "b": { "provider": "postgresql", "name": "B", "folder": "EU",
               "configuration": { "host": "b" } },
        "c": { "provider": "postgresql", "name": "C", "folder": "Staging",
               "configuration": { "host": "c" } } } }"#;
    let path = write(dir.path(), "data-sources.json", text);
    let parsed = parse_source(
        ConnectionSourceKind::Dbeaver,
        &read_source_file(&path).expect("reads"),
    )
    .expect("parses");
    let keys = vec!["a".to_owned(), "b".to_owned(), "c".to_owned()];
    let result = import(&store, &secrets, parsed, &keys, false).expect("imports");
    assert_eq!(result.created.len(), 3);
    assert_eq!(
        result.groups_created, 2,
        "EU under the existing Prod, and Staging"
    );
    let groups = store.list_groups().expect("groups");
    let eu = groups.iter().find(|g| g.name == "EU").expect("EU");
    assert_eq!(eu.parent_id.as_deref(), Some(existing.id.as_str()));
    assert_eq!(
        result.created[0].definition.group_id,
        result.created[1].definition.group_id
    );
    assert_eq!(
        result.created[0].definition.group_id.as_deref(),
        Some(eu.id.as_str())
    );
}

#[test]
fn reports_a_connection_that_cannot_be_saved_and_goes_on() {
    let (store, secrets) = stores();
    let dir = tempfile::tempdir().expect("dir");
    // A name over the limit fails `normalized`.
    let text = format!(
        r#"{{ "connections": {{
          "long": {{ "provider": "postgresql", "name": "{}", "configuration": {{ "host": "h" }} }},
          "ok": {{ "provider": "postgresql", "name": "ok", "configuration": {{ "host": "h" }} }} }} }}"#,
        "x".repeat(150)
    );
    let path = write(dir.path(), "data-sources.json", &text);
    let parsed = parse_source(
        ConnectionSourceKind::Dbeaver,
        &read_source_file(&path).expect("reads"),
    )
    .expect("parses");
    let keys = vec!["long".to_owned(), "ok".to_owned()];
    let result = import(&store, &secrets, parsed, &keys, false).expect("imports");
    assert_eq!(result.created.len(), 1);
    assert_eq!(result.failed.len(), 1);
    assert_eq!(result.failed[0].key, "long");
}

#[test]
fn exports_and_imports_a_yadbe_file_between_stores() {
    let (source, source_secrets) = stores();
    let shop = source.create_group("Shop", None).expect("group");
    let mut prod = postgres("Shop prod", "db.example.com", "shop", "app");
    prod.group_id = Some(shop.id.clone());
    prod.read_only = true;
    prod.environment.kind = crate::db::config::EnvironmentKind::Prod;
    prod.remember_password = true;
    let prod = source.create_connection(&prod).expect("saved");
    source
        .create_connection(&postgres("Other", "o", "o", "o"))
        .expect("saved");
    source_secrets
        .set(
            &prod.id,
            SecretKind::Password,
            crate::secrets::Secret::new("hunter2"),
            true,
        )
        .expect("secret");

    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("connections.json");
    assert_eq!(
        export_file(&source, std::slice::from_ref(&prod.id), &path, "0.1.0").expect("exports"),
        1
    );
    let text = std::fs::read_to_string(&path).expect("reads");
    assert!(
        !text.contains("hunter2"),
        "an exported file has no password"
    );
    assert!(text.contains("\"Shop prod\"") && !text.contains("\"Other\""));
    assert_eq!(
        std::fs::read_dir(dir.path()).expect("lists").count(),
        1,
        "no temporary file is left"
    );
    assert_eq!(
        export_file(&source, &[], &path, "0.1.0").expect("exports all"),
        2
    );

    // Merge into a store that already has one of them: a duplicate is detected, not replaced.
    let (target, target_secrets) = stores();
    target
        .create_connection(&postgres("Shop prod", "db.example.com", "shop", "app"))
        .expect("saved");
    let found = scan(
        ConnectionSourceKind::Yadbe,
        &path,
        &target.list_connections().expect("list"),
    )
    .expect("scans");
    assert_eq!(found.connections.len(), 2);
    let named = |name: &str| {
        found
            .connections
            .iter()
            .find(|c| c.definition.name == name)
            .expect("found")
    };
    assert_eq!(
        named("Shop prod").conflict.as_ref().map(|c| c.kind),
        Some(ConflictKind::SameTarget)
    );
    assert!(named("Other").conflict.is_none());
    let parsed = parse_source(ConnectionSourceKind::Yadbe, &text_of(&path)).expect("parses");
    let keys = vec![
        found.connections[0].key.clone(),
        found.connections[1].key.clone(),
    ];
    let result = import(&target, &target_secrets, parsed, &keys, true).expect("imports");
    assert_eq!(result.created.len(), 2);
    let copy = result
        .created
        .iter()
        .find(|c| c.definition.name.starts_with("Shop prod"))
        .expect("the copy");
    assert_eq!(copy.definition.name, "Shop prod (2)");
    assert_ne!(copy.id, prod.id, "new ids");
    assert!(copy.definition.read_only);
    assert_eq!(
        copy.definition.environment.kind,
        crate::db::config::EnvironmentKind::Prod
    );
    assert!(copy.definition.group_id.is_some());
    assert_eq!(result.groups_created, 1);
    assert!(
        target_secrets
            .get(&copy.id, SecretKind::Password)
            .expect("get")
            .is_none()
    );
}

fn text_of(path: &Path) -> String {
    std::fs::read_to_string(path).expect("reads")
}

#[test]
fn files_are_checked_before_they_are_read() {
    let dir = tempfile::tempdir().expect("dir");
    let locations = Locations {
        os: locations::Os::Linux,
        home: Some(dir.path().to_path_buf()),
        appdata: None,
        xdg_config: None,
        xdg_data: None,
        pgpassfile: None,
        pgservicefile: None,
    };
    assert!(resolve_path(ConnectionSourceKind::Pgpass, Some("relative"), &locations).is_err());
    assert_eq!(
        resolve_path(ConnectionSourceKind::Pgpass, None, &locations)
            .expect_err("no default")
            .code,
        crate::db::errors::ErrorCode::FileNotFound
    );
    let listed = list_sources(&locations);
    assert_eq!(listed.len(), 7);
    assert!(listed.iter().all(|s| s.default_path.is_none()));
    assert!(listed.iter().any(|s| s.supports_passwords));
    let binary = dir.path().join("bin");
    std::fs::write(&binary, [0xff, 0xfe, 0x00, 0x80]).expect("writes");
    assert_eq!(
        read_source_file(&binary).expect_err("not UTF-8").code,
        crate::db::errors::ErrorCode::ConnectionFileInvalid
    );
}

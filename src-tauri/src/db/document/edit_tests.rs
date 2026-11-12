use super::*;

fn j(text: &str) -> Json {
    Json::parse(text).expect("json")
}

fn f(name: &str) -> PathSeg {
    PathSeg::Field(name.to_owned())
}

fn set(edits: Vec<DocEdit>) -> DocChangeSet {
    DocChangeSet {
        database: "shop".into(),
        collection: "orders".into(),
        edits,
    }
}

fn plan_one(edit: DocEdit) -> Result<Planned, YadbeError> {
    let mut ids = || j(r#"{"$oid":"000000000000000000000001"}"#);
    plan(&set(vec![edit]), &mut ids).map(|mut p| p.remove(0))
}

const ID: &str = r#"{"$oid":"64b7f0c2a1b2c3d4e5f60718"}"#;

#[test]
fn canonical_types_plain_numbers_and_dates() {
    assert_eq!(
        canonical(&j(
            r#"{"a":1,"b":3000000000,"c":1.5,"d":{"$date":"1970-01-01T00:00:01Z"},"e":[2]}"#
        ))
        .expect("ok"),
        j(
            r#"{"a":{"$numberInt":"1"},"b":{"$numberLong":"3000000000"},"c":{"$numberDouble":"1.5"},"d":{"$date":{"$numberLong":"1000"}},"e":[{"$numberInt":"2"}]}"#
        )
    );
    // Wrapped values stay as they are.
    let id = j(ID);
    assert_eq!(canonical(&id).expect("ok"), id);
}

#[test]
fn an_update_writes_only_its_paths_guarded_type_exactly() {
    let planned = plan_one(DocEdit::Update {
        id: ID.into(),
        fields: vec![
            FieldEdit {
                path: vec![f("qty")],
                original: Some(r#"{"$numberInt":"5"}"#.into()),
                value: Some("6".into()),
            },
            FieldEdit {
                path: vec![f("note")],
                original: None,
                value: Some(r#""new""#.into()),
            },
            FieldEdit {
                path: vec![f("old")],
                original: Some("null".into()),
                value: None,
            },
        ],
    })
    .expect("planned");
    let DocOp::Update {
        filter,
        update,
        many,
        upsert,
        ..
    } = &planned.op
    else {
        panic!("an update");
    };
    assert!(!many && !upsert);
    assert_eq!(
        update,
        &j(r#"{"$set":{"qty":{"$numberInt":"6"},"note":"new"},"$unset":{"old":""}}"#)
    );
    assert_eq!(
        filter,
        &j(&format!(
            r#"{{"_id":{ID},"$expr":{{"$and":[
                {{"$eq":["$qty",{{"$literal":{{"$numberInt":"5"}}}}]}},
                {{"$eq":[{{"$type":"$qty"}},"int"]}},
                {{"$eq":[{{"$type":"$note"}},"missing"]}},
                {{"$eq":["$old",{{"$literal":null}}]}},
                {{"$eq":[{{"$type":"$old"}},"null"]}}
            ]}}}}"#
        ))
    );
    assert!(shell_op(&planned.op).starts_with(
        r#"coll.updateOne({"_id": ObjectId("64b7f0c2a1b2c3d4e5f60718"), "$expr": {"$and": [{"$eq": ["$qty", {"$literal": NumberInt(5)}]}"#
    ));
}

#[test]
fn nested_paths_are_reached_without_traversing_arrays() {
    let planned = plan_one(DocEdit::Update {
        id: ID.into(),
        fields: vec![FieldEdit {
            path: vec![f("items"), PathSeg::Index(1), f("sku")],
            original: Some(r#""a""#.into()),
            value: Some(r#""b""#.into()),
        }],
    })
    .expect("planned");
    let DocOp::Update { filter, update, .. } = &planned.op else {
        panic!("an update");
    };
    assert_eq!(update, &j(r#"{"$set":{"items.1.sku":"b"}}"#));
    let text = filter.to_text();
    assert!(text.contains(r#""$arrayElemAt":["$$p",1]"#), "{text}");
    assert!(
        text.contains(r#""$getField":{"field":"sku","input":"$$p"}"#),
        "{text}"
    );
    assert!(
        !text.contains("items.1"),
        "no dotted path in the guard: {text}"
    );
}

#[test]
fn numbers_inside_a_guarded_value_are_type_checked() {
    let planned = plan_one(DocEdit::Update {
        id: ID.into(),
        fields: vec![FieldEdit {
            path: vec![f("dims")],
            original: Some(r#"{"w":{"$numberInt":"1"},"h":[{"$numberDouble":"2.5"}]}"#.into()),
            value: Some(r#"{"w":2}"#.into()),
        }],
    })
    .expect("planned");
    let text = planned.op.display();
    assert_eq!(text.matches(r#"}},"int"]}"#).count(), 1, "{text}");
    assert_eq!(text.matches(r#"}},"double"]}"#).count(), 1, "{text}");
    assert!(
        text.contains(r#""object"]"#)
            && text.contains(r#""int"]"#)
            && text.contains(r#""double"]"#)
    );
}

#[test]
fn a_new_nested_field_needs_its_parent_to_be_a_document() {
    let planned = plan_one(DocEdit::Update {
        id: ID.into(),
        fields: vec![FieldEdit {
            path: vec![f("address"), f("zip")],
            original: None,
            value: Some(r#""75001""#.into()),
        }],
    })
    .expect("planned");
    let text = planned.op.display();
    assert!(
        text.contains(r#"{"$eq":[{"$type":"$address"},"object"]}"#),
        "{text}"
    );
}

#[test]
fn refused_paths() {
    let update = |path: Vec<PathSeg>, original: Option<&str>, value: Option<&str>| {
        plan_one(DocEdit::Update {
            id: ID.into(),
            fields: vec![FieldEdit {
                path,
                original: original.map(str::to_owned),
                value: value.map(str::to_owned),
            }],
        })
    };
    assert!(update(vec![f("_id")], Some("1"), Some("2")).is_err(), "_id");
    assert!(
        update(vec![f("a.b")], Some("1"), Some("2")).is_err(),
        "dotted name"
    );
    assert!(
        update(vec![f("$x")], Some("1"), Some("2")).is_err(),
        "$ name"
    );
    assert!(update(vec![], Some("1"), Some("2")).is_err(), "empty");
    assert!(
        update(vec![f("a"), PathSeg::Index(3)], None, Some("1")).is_err(),
        "an element is not added by index"
    );
    assert!(
        update(vec![f("a"), PathSeg::Index(3)], Some("1"), None).is_err(),
        "nor removed by index"
    );
    assert!(update(vec![f("a"), PathSeg::Index(3)], Some("1"), Some("2")).is_ok());
    let overlap = plan_one(DocEdit::Update {
        id: ID.into(),
        fields: vec![
            FieldEdit {
                path: vec![f("a")],
                original: Some("1".into()),
                value: Some("2".into()),
            },
            FieldEdit {
                path: vec![f("a"), f("b")],
                original: None,
                value: Some("2".into()),
            },
        ],
    });
    assert!(overlap.is_err());
}

#[test]
fn replace_and_delete_are_guarded_by_the_whole_document() {
    let original = format!(r#"{{"_id":{ID},"n":{{"$numberLong":"7"}},"s":"x"}}"#);
    let planned = plan_one(DocEdit::Replace {
        id: ID.into(),
        original: original.clone(),
        replacement: r#"{"s":"y"}"#.into(),
    })
    .expect("planned");
    let DocOp::Replace {
        filter,
        replacement,
        ..
    } = &planned.op
    else {
        panic!("a replace");
    };
    assert_eq!(
        replacement,
        &j(&format!(r#"{{"_id":{ID},"s":"y"}}"#)),
        "_id first"
    );
    let text = filter.to_text();
    assert!(text.contains(r#""$eq":["$$ROOT",{"$literal":"#), "{text}");
    assert!(
        text.contains(r#"{"$eq":[{"$type":"$n"},"long"]}"#),
        "{text}"
    );
    assert!(
        plan_one(DocEdit::Replace {
            id: ID.into(),
            original: original.clone(),
            replacement: r#"{"_id":1}"#.into(),
        })
        .is_err(),
        "the _id stays"
    );
    let planned = plan_one(DocEdit::Delete {
        id: ID.into(),
        original,
    })
    .expect("planned");
    assert!(matches!(planned.op, DocOp::Delete { many: false, .. }));
}

#[test]
fn inserts_get_an_id_first() {
    let planned = plan_one(DocEdit::Insert {
        document: r#"{"a":1,"_id":5}"#.into(),
    })
    .expect("planned");
    let DocOp::Insert { documents, .. } = &planned.op else {
        panic!("an insert");
    };
    assert_eq!(
        documents[0],
        j(r#"{"_id":{"$numberInt":"5"},"a":{"$numberInt":"1"}}"#)
    );
    let planned = plan_one(DocEdit::Insert {
        document: r#"{"a":1}"#.into(),
    })
    .expect("planned");
    assert_eq!(
        planned.exact.id(),
        j(r#"{"$oid":"000000000000000000000001"}"#)
    );
    let made = new_object_id();
    let hex = made.get("$oid").and_then(Json::as_str).expect("oid");
    assert_eq!(hex.len(), 24);
    assert_ne!(new_object_id(), made);
}

#[test]
fn the_inverse_undoes_in_reverse_order() {
    let edits = vec![
        DocEdit::Update {
            id: ID.into(),
            fields: vec![FieldEdit {
                path: vec![f("a")],
                original: None,
                value: Some("1".into()),
            }],
        },
        DocEdit::Delete {
            id: "2".into(),
            original: r#"{"_id":2,"x":true}"#.into(),
        },
        DocEdit::Insert {
            document: r#"{"_id":3}"#.into(),
        },
    ];
    let change = set(edits);
    let mut ids = new_object_id;
    let planned = plan(&change, &mut ids).expect("planned");
    let refs: Vec<&Planned> = planned.iter().collect();
    let back = inverse(&change, &refs);
    assert_eq!(
        back.edits,
        vec![
            DocEdit::Delete {
                id: r#"{"$numberInt":"3"}"#.into(),
                original: r#"{"_id":{"$numberInt":"3"}}"#.into(),
            },
            DocEdit::Insert {
                document: r#"{"_id":{"$numberInt":"2"},"x":true}"#.into(),
            },
            DocEdit::Update {
                id: ID.into(),
                fields: vec![FieldEdit {
                    path: vec![f("a")],
                    original: Some(r#"{"$numberInt":"1"}"#.into()),
                    value: None,
                }],
            },
        ]
    );
    assert_eq!(counts(&refs), (1, 1, 1));
}

#[test]
fn conflicts_name_what_changed() {
    let planned = plan_one(DocEdit::Update {
        id: ID.into(),
        fields: vec![
            FieldEdit {
                path: vec![f("a")],
                original: Some("1".into()),
                value: Some("2".into()),
            },
            FieldEdit {
                path: vec![f("b")],
                original: Some("1".into()),
                value: Some("3".into()),
            },
        ],
    })
    .expect("planned");
    let current = j(&format!(
        r#"{{"_id":{ID},"a":{{"$numberDouble":"1.0"}},"b":{{"$numberInt":"1"}}}}"#
    ));
    let conflict = conflict_of(&planned, Some(&current));
    assert_eq!(conflict.kind, DocConflictKind::Changed);
    assert_eq!(conflict.fields.len(), 1, "Int32 1 became Double 1.0");
    assert_eq!(
        conflict.fields[0].now.as_deref(),
        Some(r#"{"$numberDouble":"1.0"}"#)
    );
    assert_eq!(conflict_of(&planned, None).kind, DocConflictKind::Deleted);
    assert_eq!(
        value_at(&current, &[f("a")]),
        Some(&j(r#"{"$numberDouble":"1.0"}"#))
    );
    assert_eq!(
        value_at(&current, &[f("_id"), f("$oid")]),
        None,
        "wrappers are leaves"
    );
}

#[test]
fn preview_says_what_runs_in_the_transaction() {
    let mut ids = new_object_id;
    let planned = plan(
        &set(vec![DocEdit::Insert {
            document: r#"{"_id":1}"#.into(),
        }]),
        &mut ids,
    )
    .expect("planned");
    let ns = Namespace::new("shop", "orders");
    let atomic: Vec<String> = preview_lines(&ns, &planned, true)
        .into_iter()
        .map(|l| l.text)
        .collect();
    assert_eq!(
        atomic,
        vec![
            "const session = db.getMongo().startSession()",
            "session.startTransaction()",
            r#"const coll = session.getDatabase("shop").getCollection("orders")"#,
            r#"coll.insertOne({"_id": NumberInt(1)})"#,
            "session.commitTransaction()",
        ]
    );
    let plain = preview_lines(&ns, &planned, false);
    assert_eq!(plain.len(), 2);
    assert_eq!(plain[1].role, DocLineRole::Write);
}

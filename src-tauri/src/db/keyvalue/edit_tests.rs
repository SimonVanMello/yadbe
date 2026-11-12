use super::*;

fn t(text: &str) -> KvBytes {
    KvBytes::text(text)
}

fn set(edits: Vec<KvEdit>) -> KvChangeSet {
    KvChangeSet { database: 0, edits }
}

fn lines(plan: &KvPlan) -> Vec<String> {
    plan.preview().into_iter().map(|l| l.text).collect()
}

#[test]
fn a_hash_edit_is_checked_then_queued() {
    let plan = plan(
        &set(vec![
            KvEdit::HashSet {
                key: t("user:1"),
                field: t("name"),
                original: Some(t("Ada")),
                value: t("Ada L."),
            },
            KvEdit::HashSet {
                key: t("user:1"),
                field: t("plan"),
                original: None,
                value: t("pro"),
            },
        ]),
        b"tomb".to_vec(),
    )
    .expect("plan");
    assert_eq!(
        lines(&plan),
        [
            "WATCH user:1",
            "TYPE user:1",
            "HGET user:1 name",
            "TYPE user:1",
            "HGET user:1 plan",
            "MULTI",
            "HSET user:1 name \"Ada L.\"",
            "HSET user:1 plan pro",
            "EXEC",
        ]
    );
}

#[test]
fn list_removal_uses_a_tombstone_after_the_sets_and_before_the_pushes() {
    let plan = plan(
        &set(vec![
            KvEdit::ListPush {
                key: t("q"),
                head: true,
                values: vec![t("new")],
            },
            KvEdit::ListRemove {
                key: t("q"),
                index: 3,
                original: t("c"),
            },
            KvEdit::ListSet {
                key: t("q"),
                index: 1,
                original: t("a"),
                value: t("A"),
            },
        ]),
        b"yadbe:t".to_vec(),
    )
    .expect("plan");
    let text = lines(&plan);
    let multi = text.iter().position(|l| l == "MULTI").expect("multi");
    assert_eq!(
        &text[multi + 1..multi + 5],
        [
            "LSET q 3 yadbe:t",
            "LSET q 1 A",
            "LREM q 0 yadbe:t",
            "LPUSH q new",
        ]
    );
    assert!(text.contains(&"LPOS q yadbe:t".to_owned()));
    assert!(text.contains(&"LINDEX q 3".to_owned()));
    // The list is snapshotted before (revert) and inside the transaction (revert guard).
    assert_eq!(plan.before, vec![b"q".to_vec()]);
    assert_eq!(plan.after, vec![b"q".to_vec()]);
}

#[test]
fn the_same_list_element_twice_is_refused() {
    let err = plan(
        &set(vec![
            KvEdit::ListSet {
                key: t("q"),
                index: 0,
                original: t("a"),
                value: t("b"),
            },
            KvEdit::ListRemove {
                key: t("q"),
                index: 0,
                original: t("a"),
            },
        ]),
        b"x".to_vec(),
    )
    .expect_err("refused");
    assert_eq!(err.code, crate::db::errors::ErrorCode::InvalidArgument);
}

#[test]
fn binary_values_and_long_ones_are_shown_faithfully() {
    let long = "x".repeat(SHOWN_ARG_CHARS + 10);
    let plan = plan(
        &set(vec![KvEdit::StringSet {
            key: KvBytes::from_bytes(&[0xff, b'k']),
            original: Some(t("a b")),
            value: t(&long),
        }]),
        Vec::new(),
    )
    .expect("plan");
    let text = lines(&plan);
    assert_eq!(text[0], "WATCH \"\\xffk\"");
    assert_eq!(text[2], "GET \"\\xffk\"");
    let set_line = text.iter().find(|l| l.starts_with("SET")).expect("set");
    assert!(set_line.ends_with(&format!("({} bytes) KEEPTTL", long.len())));
    // What is sent is the exact bytes.
    assert_eq!(plan.steps[0].cmd.args[1], vec![0xff, b'k']);
    assert_eq!(plan.steps[0].cmd.args[2], long.as_bytes());
}

#[test]
fn verdicts_name_what_changed() {
    let check = |cmd: &str, expect: Expect, missing| Check {
        edit: 2,
        key: b"k".to_vec(),
        cmd: KvCommand::of([cmd, "k"]),
        expect,
        missing,
    };
    let key = t("k");
    let changed = verdict(
        &check(
            "hget",
            Expect::Bytes(Some(b"a".to_vec())),
            KvConflictKind::Missing,
        ),
        &Ok(KvReply::Bulk(b"b".to_vec())),
        &key,
    )
    .expect("conflict");
    assert_eq!(changed.kind, KvConflictKind::Changed);
    assert_eq!(changed.current, Some(t("b")));
    assert_eq!(changed.expected.as_deref(), Some("a"));
    assert!(changed.rebasable);
    assert_eq!(changed.edit, 2);

    let gone = verdict(
        &check(
            "hget",
            Expect::Bytes(Some(b"a".to_vec())),
            KvConflictKind::Missing,
        ),
        &Ok(KvReply::Nil),
        &key,
    )
    .expect("conflict");
    assert_eq!(gone.kind, KvConflictKind::Missing);
    assert!(!gone.rebasable);

    let added = verdict(
        &check("hget", Expect::Bytes(None), KvConflictKind::Exists),
        &Ok(KvReply::Bulk(b"z".to_vec())),
        &key,
    )
    .expect("conflict");
    assert_eq!(added.kind, KvConflictKind::Exists);
    assert!(added.rebasable);

    let typed = verdict(
        &check("type", Expect::TypeIn(HASH), KvConflictKind::Missing),
        &Ok(KvReply::Status("string".into())),
        &key,
    )
    .expect("conflict");
    assert_eq!(typed.kind, KvConflictKind::TypeChanged);
    assert_eq!(typed.actual_type.as_deref(), Some("string"));

    assert!(
        verdict(
            &check("zscore", Expect::Score(Some(1.5)), KvConflictKind::Missing),
            &Ok(KvReply::Bulk(b"1.5".to_vec())),
            &key,
        )
        .is_none()
    );
    let json = verdict(
        &check(
            "json.get",
            Expect::Json(serde_json::json!({"a": 1})),
            KvConflictKind::Missing,
        ),
        &Ok(KvReply::Bulk(br#"[{"a":2}]"#.to_vec())),
        &key,
    )
    .expect("conflict");
    assert_eq!(json.current, Some(t(r#"{"a":2}"#)));
    let ttl = verdict(
        &check("pexpiretime", Expect::ExpireAt(-1), KvConflictKind::Missing),
        &Ok(KvReply::Int(1_700_000_000_000)),
        &key,
    )
    .expect("conflict");
    assert_eq!(ttl.current, Some(t("1700000000000")));
}

fn observed_with(replies: Vec<KvReply>) -> Observed {
    Observed {
        step_replies: replies,
        ..Observed::default()
    }
}

#[test]
fn inverses_undo_edit_by_edit_in_reverse_order() {
    let forward = set(vec![
        KvEdit::HashSet {
            key: t("h"),
            field: t("a"),
            original: Some(t("1")),
            value: t("2"),
        },
        KvEdit::ZsetSet {
            key: t("z"),
            member: t("m"),
            original: None,
            score: "3".into(),
        },
        KvEdit::ListPush {
            key: t("l"),
            head: true,
            values: vec![t("x"), t("y")],
        },
        KvEdit::ListSet {
            key: t("l"),
            index: 0,
            original: t("old"),
            value: t("new"),
        },
    ]);
    let plan = plan(&forward, Vec::new()).expect("plan");
    let back = inverse(&forward, &plan, &observed_with(Vec::new())).expect("inverse");
    assert_eq!(
        back.edits,
        vec![
            // The element set at index 0 is at index 2 once two were pushed at the head.
            KvEdit::ListSet {
                key: t("l"),
                index: 2,
                original: t("new"),
                value: t("old"),
            },
            KvEdit::ListPop {
                key: t("l"),
                head: true,
                values: vec![t("y"), t("x")],
            },
            KvEdit::ZsetRemove {
                key: t("z"),
                member: t("m"),
                original: "3".into(),
            },
            KvEdit::HashSet {
                key: t("h"),
                field: t("a"),
                original: Some(t("2")),
                value: t("1"),
            },
        ]
    );
    // And the inverse of the inverse is the change set again (same edits, list order kept).
    let plan_back = super::plan(&back, Vec::new()).expect("plan back");
    let again = inverse(&back, &plan_back, &observed_with(Vec::new())).expect("again");
    let mut expected = forward.edits.clone();
    expected.swap(2, 3);
    assert_eq!(again.edits.len(), 4);
    assert!(again.edits.contains(&expected[0]));
    assert!(again.edits.contains(&KvEdit::ListPush {
        key: t("l"),
        head: true,
        values: vec![t("x"), t("y")],
    }));
}

#[test]
fn deleted_keys_come_back_from_their_snapshot_and_created_keys_go_guarded() {
    let snap = KvSnapshot::of(b"payload", Some(1_900_000_000_000));
    let made = KvSnapshot::of(b"made", None);
    let forward = set(vec![
        KvEdit::Delete {
            key: t("gone"),
            guard: None,
        },
        KvEdit::Create {
            key: t("new"),
            value: KvNewValue::String { value: t("v") },
            ttl_ms: None,
        },
    ]);
    let plan = plan(&forward, Vec::new()).expect("plan");
    assert_eq!(plan.before, vec![b"gone".to_vec()]);
    assert_eq!(plan.after, vec![b"new".to_vec()]);
    let mut observed = Observed::default();
    observed.before.insert(b"gone".to_vec(), Some(snap.clone()));
    observed.after.insert(b"new".to_vec(), Some(made.clone()));
    let back = inverse(&forward, &plan, &observed).expect("inverse");
    assert_eq!(
        back.edits,
        vec![
            KvEdit::Delete {
                key: t("new"),
                guard: Some(made),
            },
            KvEdit::Restore {
                key: t("gone"),
                snapshot: snap.clone(),
                replace: None,
            },
        ]
    );
    let restore_plan = super::plan(&back, Vec::new()).expect("plan");
    let restore = lines(&restore_plan);
    assert!(
        restore.contains(&"RESTORE gone 1900000000000 <DUMP payload, 7 bytes> ABSTTL".to_owned())
    );
    assert!(restore.contains(&"DUMP new".to_owned()));

    // Without the snapshot (over the bound), there is no inverse.
    let blocked = inverse(&forward, &plan, &Observed::default()).expect_err("blocked");
    assert_eq!(blocked, RevertBlocker::TooLarge);
}

#[test]
fn renames_restore_what_they_overwrote() {
    let forward = set(vec![KvEdit::Rename {
        key: t("a"),
        to: t("b"),
        overwrite: true,
    }]);
    let plan = plan(&forward, Vec::new()).expect("plan");
    // No "b must not exist" check with overwrite; "b" is kept for the revert.
    assert!(!lines(&plan).contains(&"EXISTS b".to_owned()));
    assert_eq!(plan.before, vec![b"b".to_vec()]);
    assert_eq!(plan.after, vec![b"b".to_vec()]);
    let mut observed = Observed::default();
    let old_b = KvSnapshot::of(b"old-b", None);
    let moved = KvSnapshot::of(b"a-now-b", Some(1_900_000_000_000));
    observed.before.insert(b"b".to_vec(), Some(old_b.clone()));
    observed.after.insert(b"b".to_vec(), Some(moved.clone()));
    let back = inverse(&forward, &plan, &observed).expect("inverse");
    assert_eq!(
        back.edits,
        vec![
            KvEdit::Restore {
                key: t("a"),
                snapshot: moved.clone(),
                replace: None,
            },
            KvEdit::Restore {
                key: t("b"),
                snapshot: old_b,
                replace: Some(moved),
            },
        ]
    );
    // Without overwriting, the rename goes back.
    let plain = set(vec![KvEdit::Rename {
        key: t("a"),
        to: t("c"),
        overwrite: false,
    }]);
    let plain_plan = super::plan(&plain, Vec::new()).expect("plan");
    assert_eq!(
        inverse(&plain, &plain_plan, &Observed::default())
            .expect("inverse")
            .edits,
        vec![KvEdit::Rename {
            key: t("c"),
            to: t("a"),
            overwrite: false,
        }]
    );
}

#[test]
fn stream_entries_added_are_deleted_by_their_new_id() {
    let forward = set(vec![KvEdit::StreamAdd {
        key: t("s"),
        fields: vec![KvField {
            field: t("f"),
            value: t("v"),
        }],
    }]);
    let plan = plan(&forward, Vec::new()).expect("plan");
    let back = inverse(
        &forward,
        &plan,
        &observed_with(vec![KvReply::Bulk(b"5-0".to_vec())]),
    )
    .expect("inverse");
    assert_eq!(
        back.edits,
        vec![KvEdit::StreamDelete {
            key: t("s"),
            id: "5-0".into(),
            fields: vec![KvField {
                field: t("f"),
                value: t("v"),
            }],
        }]
    );
}

#[test]
fn ttl_changes_revert_to_the_expiry_seen() {
    let forward = set(vec![KvEdit::Expire {
        key: t("k"),
        original: None,
        ttl: KvTtl::In { ms: 60_000.0 },
    }]);
    let plan = plan(&forward, Vec::new()).expect("plan");
    assert!(lines(&plan).contains(&"PEXPIRE k 60000".to_owned()));
    let mut observed = Observed::default();
    observed
        .expiry_after
        .insert(b"k".to_vec(), Some(1_800_000_000_000));
    let back = inverse(&forward, &plan, &observed).expect("inverse");
    assert_eq!(
        back.edits,
        vec![KvEdit::Expire {
            key: t("k"),
            original: Some(1_800_000_000_000.0),
            ttl: KvTtl::Persist,
        }]
    );
}

#[test]
fn bad_input_is_refused_before_anything_runs() {
    for edit in [
        KvEdit::JsonSet {
            key: t("j"),
            path: "$".into(),
            original: Some("{}".into()),
            value: "{not json".into(),
        },
        KvEdit::JsonSet {
            key: t("j"),
            path: "a.b".into(),
            original: Some("1".into()),
            value: "2".into(),
        },
        KvEdit::ZsetSet {
            key: t("z"),
            member: t("m"),
            original: None,
            score: "NaN".into(),
        },
        KvEdit::Rename {
            key: t("a"),
            to: t("a"),
            overwrite: false,
        },
        KvEdit::Create {
            key: t("h"),
            value: KvNewValue::Hash { fields: Vec::new() },
            ttl_ms: None,
        },
    ] {
        assert!(
            plan(&set(vec![edit.clone()]), Vec::new()).is_err(),
            "{edit:?}"
        );
    }
    assert!(plan(&set(Vec::new()), Vec::new()).is_err());
}

#[test]
fn scores_are_text_and_may_be_infinite() {
    assert_eq!(parse_score(" -inf ").expect("score"), f64::NEG_INFINITY);
    assert_eq!(parse_score("+INF").expect("score"), f64::INFINITY);
    assert_eq!(parse_score("1.5e3").expect("score"), 1500.0);
    assert!(parse_score("abc").is_err());
    let plan = plan(
        &set(vec![KvEdit::ZsetSet {
            key: t("z"),
            member: t("m"),
            original: Some("-inf".into()),
            score: "inf".into(),
        }]),
        Vec::new(),
    )
    .expect("plan");
    assert!(lines(&plan).contains(&"ZADD z +inf m".to_owned()));
    assert_eq!(
        plan.checks[1].expect,
        Expect::Score(Some(f64::NEG_INFINITY))
    );
}

#[test]
fn patterns_match_like_scan() {
    assert_eq!(prefix_pattern(b"user:*[1]"), b"user:\\*\\[1\\]*".to_vec());
    assert!(glob_match(&prefix_pattern(b"user:*[1]"), b"user:*[1]:x"));
    assert!(!glob_match(&prefix_pattern(b"user:*[1]"), b"user:a[1]:x"));
    assert!(glob_match(b"user:*", b"user:42"));
    assert!(glob_match(b"h?llo", b"hello"));
    assert!(glob_match(b"h[ae]llo", b"hallo"));
    assert!(!glob_match(b"h[^e]llo", b"hello"));
    assert!(glob_match(b"h[a-c]llo", b"hbllo"));
    assert!(glob_match(b"*", b""));
    assert!(!glob_match(b"a*b", b"acd"));
    assert!(glob_match(b"a*b*c", b"axxbyyc"));
}

#[test]
fn counts_and_key_moves() {
    let changes = set(vec![
        KvEdit::Delete {
            key: t("a"),
            guard: None,
        },
        KvEdit::Rename {
            key: t("b"),
            to: t("c"),
            overwrite: false,
        },
        KvEdit::ListPush {
            key: t("l"),
            head: false,
            values: vec![t("1"), t("2")],
        },
    ]);
    assert_eq!(counts(&changes), (1, 2, 1));
    let (added, removed) = key_moves(&changes);
    assert_eq!(added, vec![t("c")]);
    assert_eq!(removed, vec![t("a"), t("b")]);
}

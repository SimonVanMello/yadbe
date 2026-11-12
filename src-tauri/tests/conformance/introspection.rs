//! Introspection part of the driver conformance suite (SPEC §10): every driver describes
//! the logical "shop" fixture (`fixtures/meta_<engine>.sql`) the same way, through the
//! metadata cache. Engine differences come from the dialect's capabilities only.

use crate::common::SqlEngine as _;
use yadbe_lib::db::engine::Engine;
use yadbe_lib::db::errors::ErrorCode;
use yadbe_lib::db::meta::{
    ForeignKeyAction, MetaNode, ObjectKind, ObjectRef, TableDetails, TriggerEvent, TriggerTiming,
};
use yadbe_lib::db::script::ScriptKind;
use yadbe_lib::events::{BackendEvent, RecordingSink};
use yadbe_lib::session::ConnectionManager;
use yadbe_lib::session::meta_cache::MetaService;
use yadbe_lib::session::statement_log::StatementLog;

/// Where the fixture lives on one engine.
pub struct Shop {
    pub engine: Engine,
    pub database: String,
    /// Schemas of the PostgreSQL flavor; `None` on engines without schemas.
    pub shop: Option<String>,
    pub sales: Option<String>,
    pub odd: Option<String>,
}

impl Shop {
    pub fn shop(&self, name: &str) -> ObjectRef {
        self.at(self.shop.clone(), name)
    }

    pub fn sales(&self, name: &str) -> ObjectRef {
        self.at(self.sales.clone(), name)
    }

    pub fn odd(&self, name: &str) -> ObjectRef {
        self.at(self.odd.clone(), name)
    }

    fn at(&self, schema: Option<String>, name: &str) -> ObjectRef {
        ObjectRef {
            database: self.database.clone(),
            schema,
            name: name.to_owned(),
        }
    }
}

pub struct Ctx<'a> {
    pub meta: &'a MetaService,
    pub manager: &'a ConnectionManager,
    pub log: &'a StatementLog,
    pub sink: &'a RecordingSink,
    pub connection_id: &'a str,
}

impl Ctx<'_> {
    pub async fn table(&self, table: &ObjectRef) -> TableDetails {
        self.meta
            .table_details(self.manager, None, self.connection_id, table)
            .await
            .unwrap_or_else(|e| panic!("details of {table:?}: {e:?}"))
    }
}

fn column<'a>(table: &'a TableDetails, name: &str) -> &'a yadbe_lib::db::meta::ColumnInfo {
    table
        .columns
        .iter()
        .find(|c| c.name == name)
        .unwrap_or_else(|| panic!("column {name} of {:?}", table.table))
}

/// An expression as the engines print it, without quotes, brackets, parentheses or spaces:
/// `([price]>=(0))` (SQL Server) and `price >= (0)::numeric` (PostgreSQL) both contain
/// `price>=0`.
fn bare(expression: &str) -> String {
    expression
        .chars()
        .filter(|c| !c.is_whitespace() && !matches!(c, '[' | ']' | '(' | ')' | '"' | '`'))
        .collect()
}

fn names<T>(items: &[T], name: impl Fn(&T) -> String) -> Vec<String> {
    items.iter().map(name).collect()
}

/// Runs the whole suite; the fixture must be loaded and the connection open.
pub async fn check(ctx: &Ctx<'_>, shop: &Shop) {
    let caps = shop.engine.dialect().capabilities();
    let meta_caps = shop.engine.dialect().meta_capabilities();
    let (meta, manager, id) = (ctx.meta, ctx.manager, ctx.connection_id);

    // Databases → schemas → counts → objects.
    let databases = meta.databases(manager, None, id).await.expect("databases");
    assert!(
        databases
            .iter()
            .any(|d| d.current && d.name == shop.database && d.accessible),
        "{databases:?}"
    );
    let schemas = meta
        .schemas(manager, None, id, &shop.database)
        .await
        .expect("schemas");
    if caps.schemas {
        for name in [&shop.shop, &shop.sales, &shop.odd].into_iter().flatten() {
            assert!(
                schemas.iter().any(|s| &s.name == name && !s.system),
                "{name} in {schemas:?}"
            );
        }
        assert!(schemas.iter().any(|s| s.system), "system schemas flagged");
    } else {
        assert!(schemas.is_empty());
    }

    let counts = meta
        .object_counts(manager, None, id, &shop.database, shop.shop.as_deref())
        .await
        .expect("counts");
    assert_eq!(
        counts.iter().map(|c| c.kind).collect::<Vec<_>>(),
        meta_caps.object_kinds
    );
    let tables = meta
        .objects(
            manager,
            None,
            id,
            &shop.database,
            shop.shop.as_deref(),
            ObjectKind::Table,
        )
        .await
        .expect("tables");
    let table_count = counts.iter().find(|c| c.kind == ObjectKind::Table);
    assert_eq!(table_count.map(|c| c.count as usize), Some(tables.len()));
    assert_eq!(
        table_count.map(|c| c.system_count as usize),
        Some(tables.iter().filter(|t| t.system).count())
    );
    let table_names = names(&tables, |t| t.name.clone());
    for name in ["customers", "products", "orders", "order_items"] {
        assert!(
            table_names.contains(&name.to_owned()),
            "{name} in {table_names:?}"
        );
    }
    let views = meta
        .objects(
            manager,
            None,
            id,
            &shop.database,
            shop.shop.as_deref(),
            ObjectKind::View,
        )
        .await
        .expect("views");
    assert!(views.iter().any(|v| v.name == "customer_orders"));

    // Columns, identity, defaults, unique keys, expression index.
    let customers = ctx.table(&shop.shop("customers")).await;
    assert_eq!(customers.kind, ObjectKind::Table);
    assert_eq!(
        names(&customers.columns, |c| c.name.clone()),
        ["id", "email", "full_name", "created_at"]
    );
    assert_eq!(
        customers
            .columns
            .iter()
            .map(|c| c.ordinal)
            .collect::<Vec<_>>(),
        [1, 2, 3, 4]
    );
    let id_col = column(&customers, "id");
    assert!(id_col.identity.is_some() && id_col.primary_key && !id_col.nullable);
    assert!(!column(&customers, "email").nullable);
    assert!(column(&customers, "created_at").default.is_some());
    assert!(column(&customers, "full_name").type_name.contains("200"));
    assert_eq!(
        customers.primary_key.as_ref().map(|k| k.columns.clone()),
        Some(vec!["id".to_owned()])
    );
    assert_eq!(
        names(&customers.unique_keys, |k| k.columns.join(",")),
        ["email"]
    );
    if meta_caps.expression_indexes {
        let lower = customers
            .indexes
            .iter()
            .find(|i| i.name == "customers_lower_email_idx")
            .expect("expression index");
        assert_eq!(lower.columns.len(), 1);
        assert!(lower.columns[0].contains("lower(email)"), "{lower:?}");
        assert!(!lower.unique);
    }

    // Composite unique key, named check.
    let products = ctx.table(&shop.shop("products")).await;
    let mut uniques = names(&products.unique_keys, |k| k.columns.join(","));
    uniques.sort();
    assert_eq!(uniques, ["name,status", "sku"]);
    assert!(
        products
            .checks
            .iter()
            .any(|c| bare(&c.expression).contains("price>=0")),
        "{:?}",
        products.checks
    );

    // Generated column, foreign key with action, partial index, trigger.
    let orders = ctx.table(&shop.shop("orders")).await;
    let total = column(&orders, "total");
    let generated = total.generated.as_ref().expect("generated");
    assert!(generated.stored);
    assert!(
        generated
            .expression
            .as_deref()
            .is_some_and(|e| e.contains("subtotal")),
        "{generated:?}"
    );
    assert!(column(&orders, "customer_id").foreign_key);
    let fk = &orders.foreign_keys[0];
    assert_eq!(fk.columns, ["customer_id"]);
    assert_eq!(fk.referenced_table, shop.shop("customers"));
    assert_eq!(fk.referenced_columns, ["id"]);
    assert_eq!(fk.on_delete, ForeignKeyAction::Cascade);
    assert_eq!(fk.on_update, ForeignKeyAction::NoAction);
    let partial = orders
        .indexes
        .iter()
        .find(|i| i.name == "orders_created_at_idx")
        .expect("partial index");
    if meta_caps.partial_indexes {
        assert!(
            partial
                .predicate
                .as_deref()
                .is_some_and(|p| bare(p).contains("total>0")),
            "{partial:?}"
        );
    }
    assert_eq!(orders.triggers.len(), 1);
    let trigger = &orders.triggers[0];
    assert_eq!(trigger.name, "orders_touch");
    assert_eq!(trigger.events, [TriggerEvent::Update]);
    assert!(trigger.enabled);
    if meta_caps.row_triggers {
        assert_eq!(trigger.timing, TriggerTiming::Before);
        assert!(trigger.for_each_row);
    } else {
        assert_eq!(trigger.timing, TriggerTiming::After);
        assert!(!trigger.for_each_row);
    }

    // Composite primary key, two foreign keys with their actions.
    let items = ctx.table(&shop.shop("order_items")).await;
    assert_eq!(
        items.primary_key.as_ref().map(|k| k.columns.clone()),
        Some(vec!["order_id".to_owned(), "product_id".to_owned()])
    );
    let mut fks: Vec<_> = items
        .foreign_keys
        .iter()
        .map(|f| {
            (
                f.columns.join(","),
                f.referenced_table.name.clone(),
                f.referenced_columns.join(","),
                f.on_update,
                f.on_delete,
            )
        })
        .collect();
    fks.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        fks,
        [
            (
                "order_id".into(),
                "orders".into(),
                "id".into(),
                ForeignKeyAction::NoAction,
                ForeignKeyAction::Cascade
            ),
            (
                "product_id".into(),
                "products".into(),
                "id".into(),
                ForeignKeyAction::Cascade,
                if meta_caps.restrict_action {
                    ForeignKeyAction::Restrict
                } else {
                    ForeignKeyAction::NoAction
                }
            ),
        ]
    );
    assert!(
        items
            .checks
            .iter()
            .any(|c| bare(&c.expression).contains("quantity>0"))
    );
    assert!(items.columns.iter().all(|c| c.identity.is_none()));

    // A foreign key to another schema (the same one on engines without schemas).
    let invoices = ctx.table(&shop.sales("invoices")).await;
    assert_eq!(
        invoices.foreign_keys[0].referenced_table,
        shop.shop("orders")
    );

    // Identifiers that need quoting.
    let odd_ref = shop.odd("Odd \"Table\"");
    let odd = ctx.table(&odd_ref).await;
    assert_eq!(
        names(&odd.columns, |c| c.name.clone()),
        ["Id", "Select", "col with space"]
    );
    let dialect = shop.engine.dialect();
    let select = meta
        .script(manager, id, &odd_ref, ScriptKind::Select)
        .await
        .expect("script");
    assert!(
        select.contains(&dialect.quote_identifier("col with space")),
        "{select}"
    );
    assert!(
        select.contains(&dialect.quote_identifier("Odd \"Table\"")),
        "{select}"
    );
    let delete = meta
        .script(manager, id, &shop.shop("order_items"), ScriptKind::Delete)
        .await
        .expect("script");
    assert!(delete.contains("<product_id, "), "{delete}");

    // Views have columns and no keys.
    let view = ctx.table(&shop.shop("customer_orders")).await;
    assert_eq!(view.kind, ObjectKind::View);
    assert_eq!(
        names(&view.columns, |c| c.name.clone()),
        ["order_id", "email", "total"]
    );
    assert!(view.primary_key.is_none());

    // A missing object is a typed error.
    let missing = meta
        .table_details(manager, None, id, &shop.shop("no_such_table"))
        .await
        .expect_err("missing");
    assert_eq!(missing.code, ErrorCode::ObjectNotFound);

    // Completion catalog: relations with typed columns and foreign keys between them.
    let catalog = meta
        .completion_catalog(manager, None, id, &shop.database, false)
        .await
        .expect("catalog");
    let index = |name: &str| {
        catalog
            .relations
            .iter()
            .position(|r| {
                r.name == name
                    && r.schema.map(|s| catalog.schemas[s as usize].name.clone()) == shop.shop
            })
            .unwrap_or_else(|| panic!("{name} in the catalog"))
    };
    let orders_index = index("orders");
    let relation = &catalog.relations[orders_index];
    assert_eq!(relation.columns.len(), relation.column_types.len());
    assert!(relation.columns.contains(&"customer_id".to_owned()));
    let items_index = index("order_items");
    assert!(catalog.foreign_keys.iter().any(|f| {
        f.from as usize == items_index
            && f.to as usize == orders_index
            && f.from_columns == [0]
            && catalog.relations[orders_index].columns[f.to_columns[0] as usize] == "id"
    }));
    assert!(
        catalog
            .relations
            .iter()
            .flat_map(|r| &r.column_types)
            .all(|&t| (t as usize) < catalog.type_names.len())
    );
    if caps.schemas {
        assert!(catalog.schemas.iter().all(|s| !s.system));
    }

    // Cached: reading again runs nothing; a refresh drops the node and says so.
    let before = ctx.log.entries().len();
    ctx.table(&shop.shop("orders")).await;
    meta.objects(
        manager,
        None,
        id,
        &shop.database,
        shop.shop.as_deref(),
        ObjectKind::Table,
    )
    .await
    .expect("tables");
    assert_eq!(ctx.log.entries().len(), before, "served from the cache");
    let node = MetaNode::Table {
        table: shop.shop("orders"),
    };
    meta.refresh(id, node.clone());
    assert!(ctx.sink.events().iter().any(|e| matches!(
        e,
        BackendEvent::MetaRefreshed(r) if r.node == node && r.connection_id == id
    )));
    ctx.table(&shop.shop("orders")).await;
    assert!(
        ctx.log.entries().len() > before,
        "read again after a refresh"
    );
    let after = ctx.log.entries().len();
    meta.objects(
        manager,
        None,
        id,
        &shop.database,
        shop.shop.as_deref(),
        ObjectKind::Table,
    )
    .await
    .expect("tables");
    assert_eq!(ctx.log.entries().len(), after, "siblings stay cached");
}

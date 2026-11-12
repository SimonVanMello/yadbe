//! `ResultEditService`: editable query results (M3-7, F-087).
//!
//! **Editable.** A result set is editable when the engine said where each of its columns
//! comes from (`ColumnOrigin`, recorded by the `QueryRunner`), every column that comes from a
//! table comes from the same one, that table is the one the statement names in a plain
//! `SELECT … FROM <one table>` (`db::result_source`, so that a self-join or a view hiding a
//! join never passes), it is a table (not a view) with a row identity, and the result holds
//! every identity column. The statement is never rewritten (rule 3): a result without its key
//! stays read-only, with the reason.
//!
//! **Edits** go through the table-tab machinery: each edited result has a table tab of the
//! `TableDataService` of its own (a hidden one, `result:<id>`), opened on the first preview,
//! apply or refresh, with its own server connection, so an apply is one transaction with the
//! one-row rule, the original-value checks (F-089) and the change journal (F-090). The query
//! tab's connection is left alone: its transaction must be closed first, since the rows it
//! read may hold changes nobody else sees yet.
//!
//! **Rows read again** (after an apply, a conflict) are in the result's columns: the columns
//! the query computed keep the value they were read with (they are not computed again).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use tokio::sync::Mutex as AsyncMutex;

use crate::db::errors::{ErrorCode, YadbeError};
use crate::db::meta::{ObjectKind, ObjectRef};
use crate::db::value::{ColumnMeta, Value};
use crate::edit::model::{ApplyOutcome, ChangeSet, EditPreview};
use crate::session::ConnectionManager;
use crate::session::meta_cache::MetaService;
use crate::session::query_model::TransactionStatus;
use crate::session::query_runner::{QueryRunner, ResultOrigin};
use crate::session::result_edit_model::{
    ResultEditColumn, ResultEditInfo, ResultReadOnlyReason, ResultRowRef,
};
use crate::session::result_store::ResultStore;
use crate::session::table_data::TableDataService;
use crate::session::table_model::{
    ColumnReadOnlyReason, PAGE_WINDOW_ROWS, RefreshedRows, RowKey, TableColumn, TableReadOnlyReason,
};
use crate::session::table_shape::TableShape;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// An editable result.
struct ResultEdit {
    result_id: u32,
    /// The query tab that ran it.
    tab_id: String,
    connection_id: String,
    table: ObjectRef,
    /// The result's columns.
    columns: Vec<ColumnMeta>,
    /// Per result column, the table column it shows.
    sources: Vec<Option<String>>,
    row_identity: Vec<String>,
    /// Its hidden table tab is open (serializes opening it).
    opened: AsyncMutex<bool>,
    /// Rows read again for it, kept in the store until it closes.
    results: Mutex<Vec<u32>>,
}

impl ResultEdit {
    fn hidden_tab(&self) -> String {
        format!("result:{}", self.result_id)
    }

    fn sourced(&self) -> HashSet<&str> {
        self.sources.iter().flatten().map(String::as_str).collect()
    }
}

pub struct ResultEditService {
    manager: Arc<ConnectionManager>,
    runner: Arc<QueryRunner>,
    tables: Arc<TableDataService>,
    store: Arc<ResultStore>,
    edits: Mutex<HashMap<u32, Arc<ResultEdit>>>,
}

/// A result column that is not a table column as the table holds it.
fn computed(meta: &ColumnMeta) -> ResultEditColumn {
    ResultEditColumn {
        source: None,
        column: TableColumn {
            name: meta.name.clone(),
            type_name: meta.type_name.clone(),
            kind: meta.kind,
            nullable: true,
            default: None,
            optional_on_insert: true,
            primary_key: false,
            read_only_reason: Some(ColumnReadOnlyReason::Computed),
            enum_values: None,
        },
    }
}

fn reason_error(reason: ResultReadOnlyReason) -> YadbeError {
    let (en, fr) = match reason {
        ResultReadOnlyReason::NotSingleTable => (
            "This result does not come from a plain SELECT of one table: it cannot be edited.",
            "Ce résultat ne vient pas d'un simple SELECT d'une table : il ne peut pas être modifié.",
        ),
        ResultReadOnlyReason::OriginUnknown => (
            "The server did not say which table this result's columns come from: it cannot be edited.",
            "Le serveur n'a pas indiqué de quelle table viennent les colonnes de ce résultat : il ne peut pas être modifié.",
        ),
        ResultReadOnlyReason::OtherSource => (
            "This result's columns come from another object than the table the query names (a view, a synonym, several tables): it cannot be edited.",
            "Les colonnes de ce résultat viennent d'un autre objet que la table nommée par la requête (une vue, un synonyme, plusieurs tables) : il ne peut pas être modifié.",
        ),
        ResultReadOnlyReason::View => (
            "A view cannot be edited from its rows.",
            "Une vue ne peut pas être modifiée depuis ses lignes.",
        ),
        ResultReadOnlyReason::TableUnknown => (
            "The table of this result is not in the connection's metadata: it cannot be edited.",
            "La table de ce résultat n'est pas dans les métadonnées de la connexion : il ne peut pas être modifié.",
        ),
        ResultReadOnlyReason::NoRowIdentity => (
            "This table has neither a primary key nor a unique key on non-null columns: its rows cannot be told apart.",
            "Cette table n'a ni clé primaire ni clé unique sur des colonnes non nulles : ses lignes ne peuvent pas être distinguées.",
        ),
        ResultReadOnlyReason::KeyNotSelected => (
            "This result does not hold every column of the table's key: add them to the query to edit it.",
            "Ce résultat ne contient pas toutes les colonnes de la clé de la table : ajoutez-les à la requête pour le modifier.",
        ),
        ResultReadOnlyReason::ReadOnlyConnection => {
            return YadbeError::read_only_violation("UPDATE");
        }
        ResultReadOnlyReason::OpenTransaction => (
            "A transaction is open in this query tab: commit or roll it back first. Changes to a result are applied in a transaction of their own.",
            "Une transaction est ouverte dans cet onglet de requête : validez-la ou annulez-la d'abord. Les modifications d'un résultat sont appliquées dans leur propre transaction.",
        ),
    };
    YadbeError::table_not_editable(en, fr)
}

impl ResultEditService {
    pub fn new(
        manager: Arc<ConnectionManager>,
        runner: Arc<QueryRunner>,
        tables: Arc<TableDataService>,
    ) -> Self {
        Self {
            manager,
            store: runner.shared_store(),
            runner,
            tables,
            edits: Mutex::new(HashMap::new()),
        }
    }

    /// Whether result `result_id` can be edited, and how.
    pub async fn describe(
        &self,
        meta: &MetaService,
        result_id: u32,
    ) -> Result<ResultEditInfo, YadbeError> {
        self.sweep().await;
        let origin = self.runner.result_origin(result_id)?;
        let (info, edit) = self.decide(meta, result_id, &origin).await?;
        let mut edits = lock(&self.edits);
        match edit {
            Some(edit) => {
                // A result described again keeps its hidden tab.
                edits.entry(result_id).or_insert(edit);
            }
            None => {
                edits.remove(&result_id);
            }
        }
        Ok(info)
    }

    async fn decide(
        &self,
        meta: &MetaService,
        result_id: u32,
        origin: &ResultOrigin,
    ) -> Result<(ResultEditInfo, Option<Arc<ResultEdit>>), YadbeError> {
        let session = self.manager.session(&origin.connection_id)?;
        let target = session.target();
        let dialect = target.engine.dialect();
        let mut info = ResultEditInfo {
            result_id,
            table: None,
            read_only_reasons: Vec::new(),
            columns: origin.columns.iter().map(computed).collect(),
            row_identity: Vec::new(),
            identity_columns: Vec::new(),
        };
        let read_only = target.read_only;
        let refuse = |mut info: ResultEditInfo, reason| {
            info.read_only_reasons.push(reason);
            if read_only {
                info.read_only_reasons
                    .push(ResultReadOnlyReason::ReadOnlyConnection);
            }
            Ok((info, None))
        };
        let Some(select) = &origin.select else {
            return refuse(info, ResultReadOnlyReason::NotSingleTable);
        };
        let Some(origins) = origin
            .origins
            .as_ref()
            .filter(|o| o.len() == origin.columns.len())
        else {
            return refuse(info, ResultReadOnlyReason::OriginUnknown);
        };
        let mut sources = origins.iter().flatten();
        let Some(first) = sources.next() else {
            return refuse(info, ResultReadOnlyReason::OriginUnknown);
        };
        let same_table = |o: &&crate::db::driver::ColumnOrigin| {
            o.database == first.database && o.schema == first.schema && o.table == first.table
        };
        if !sources.all(|o| same_table(&o)) {
            return refuse(info, ResultReadOnlyReason::OtherSource);
        }
        let database = first
            .database
            .clone()
            .or_else(|| origin.database.clone())
            .unwrap_or_else(|| target.database.clone());
        let schemas = dialect.capabilities().schemas;
        let schema = if schemas {
            match &first.schema {
                Some(schema) => Some(schema.clone()),
                None => return refuse(info, ResultReadOnlyReason::OriginUnknown),
            }
        } else {
            None
        };
        if !select.names(Some(&database), schema.as_deref(), &first.table) {
            return refuse(info, ResultReadOnlyReason::OtherSource);
        }
        let table = ObjectRef {
            database,
            schema,
            name: first.table.clone(),
        };
        info.table = Some(table.clone());
        let details = match meta
            .table_details(&self.manager, None, &origin.connection_id, &table)
            .await
        {
            Ok(details) => details,
            Err(err) if err.code == ErrorCode::ObjectNotFound => {
                return refuse(info, ResultReadOnlyReason::TableUnknown);
            }
            Err(err) => return Err(err),
        };
        let shape = TableShape::new(dialect, details, read_only, &HashMap::new());
        let mut reasons = Vec::new();
        if shape.details.kind != ObjectKind::Table
            || shape
                .info
                .read_only_reasons
                .contains(&TableReadOnlyReason::View)
        {
            reasons.push(ResultReadOnlyReason::View);
        } else if shape.identity.is_empty() {
            reasons.push(ResultReadOnlyReason::NoRowIdentity);
        }

        // Each table column once, shown as the table holds it.
        let mut used = HashSet::new();
        let mut columns = Vec::with_capacity(origins.len());
        let mut source_names = Vec::with_capacity(origins.len());
        for (meta, column_origin) in origin.columns.iter().zip(origins) {
            let index = column_origin
                .as_ref()
                .filter(|o| same_table(o))
                .and_then(|o| table_column(&shape, &o.column));
            match index {
                Some(index)
                    if !shape.as_text.get(index).copied().unwrap_or(true) && used.insert(index) =>
                {
                    let column = shape.info.columns[index].clone();
                    source_names.push(Some(column.name.clone()));
                    columns.push(ResultEditColumn {
                        source: Some(column.name.clone()),
                        column,
                    });
                }
                _ => {
                    source_names.push(None);
                    columns.push(computed(meta));
                }
            }
        }
        info.columns = columns;
        info.row_identity = shape.info.row_identity.clone().unwrap_or_default();
        let mut identity_columns = Vec::new();
        if reasons.is_empty() {
            for &index in &shape.identity {
                let name = &shape.details.columns[index].name;
                match source_names
                    .iter()
                    .position(|s| s.as_deref() == Some(name.as_str()))
                {
                    Some(at) => identity_columns.push(u32::try_from(at).unwrap_or(u32::MAX)),
                    None => {
                        reasons.push(ResultReadOnlyReason::KeyNotSelected);
                        break;
                    }
                }
            }
        }
        if read_only {
            reasons.push(ResultReadOnlyReason::ReadOnlyConnection);
        }
        info.read_only_reasons = reasons;
        if !info.read_only_reasons.is_empty() {
            return Ok((info, None));
        }
        info.identity_columns = identity_columns;
        let edit = Arc::new(ResultEdit {
            result_id,
            tab_id: origin.tab_id.clone(),
            connection_id: origin.connection_id.clone(),
            table,
            columns: origin.columns.clone(),
            sources: source_names,
            row_identity: info.row_identity.clone(),
            opened: AsyncMutex::new(false),
            results: Mutex::new(Vec::new()),
        });
        Ok((info, Some(edit)))
    }

    /// The edit of an editable result, described first when needed; the reason as an error
    /// otherwise.
    async fn edit(
        &self,
        meta: &MetaService,
        result_id: u32,
    ) -> Result<Arc<ResultEdit>, YadbeError> {
        if let Some(edit) = lock(&self.edits).get(&result_id).cloned() {
            // Its query may have been replaced since.
            self.runner.result_origin(result_id)?;
            return Ok(edit);
        }
        let info = self.describe(meta, result_id).await?;
        if let Some(reason) = info.read_only_reasons.first() {
            let reason = if info
                .read_only_reasons
                .contains(&ResultReadOnlyReason::ReadOnlyConnection)
            {
                ResultReadOnlyReason::ReadOnlyConnection
            } else {
                *reason
            };
            return Err(reason_error(reason));
        }
        lock(&self.edits)
            .get(&result_id)
            .cloned()
            .ok_or_else(|| YadbeError::result_not_found(result_id))
    }

    /// Opens the result's hidden table tab, checking the table still has the row identity
    /// the result was described with.
    async fn open(&self, meta: &MetaService, edit: &ResultEdit) -> Result<(), YadbeError> {
        let mut opened = edit.opened.lock().await;
        if *opened {
            return Ok(());
        }
        let info = self
            .tables
            .open(meta, &edit.hidden_tab(), &edit.connection_id, &edit.table)
            .await?;
        if info.row_identity.as_ref() != Some(&edit.row_identity) {
            self.tables.close(&edit.hidden_tab()).await;
            return Err(YadbeError::table_not_editable(
                "The table changed since the query ran: run it again to edit its rows.",
                "La table a changé depuis l'exécution de la requête : relancez-la pour modifier ses lignes.",
            ));
        }
        *opened = true;
        Ok(())
    }

    /// Refuses what a result edit cannot hold: new rows, and columns the result does not show
    /// as the table holds them.
    fn check(edit: &ResultEdit, changes: &ChangeSet) -> Result<(), YadbeError> {
        if !changes.inserts.is_empty() {
            return Err(YadbeError::invalid_argument(
                "Rows cannot be added to a query result: open the table to insert rows.",
                "On ne peut pas ajouter de lignes à un résultat de requête : ouvrez la table pour insérer des lignes.",
            ));
        }
        let sourced = edit.sourced();
        let unknown = changes
            .updates
            .iter()
            .map(|u| u.column.as_str())
            .chain(
                changes
                    .deletes
                    .iter()
                    .flat_map(|d| d.values.iter().map(|v| v.column.as_str())),
            )
            .find(|column| !sourced.contains(column));
        if let Some(column) = unknown {
            return Err(YadbeError::invalid_argument(
                format!("The result does not show the table column \"{column}\" as it is stored."),
                format!(
                    "Le résultat ne montre pas la colonne « {column} » de la table telle qu'elle est stockée."
                ),
            ));
        }
        Ok(())
    }

    pub async fn preview(
        &self,
        meta: &MetaService,
        result_id: u32,
        changes: &ChangeSet,
    ) -> Result<EditPreview, YadbeError> {
        let edit = self.edit(meta, result_id).await?;
        Self::check(&edit, changes)?;
        self.open(meta, &edit).await?;
        let hidden = edit.hidden_tab();
        // As Apply will run them: deleted rows checked on every column (see `apply`).
        let mut changes = changes.clone();
        self.complete_deletes(&hidden, &mut changes).await?;
        self.tables.preview(&hidden, &changes)
    }

    /// Applies `changes` like a table tab. Deleted rows are completed with the table columns
    /// the result does not show, read just before, so the journal can insert them back.
    pub async fn apply(
        &self,
        meta: &MetaService,
        result_id: u32,
        changes: &ChangeSet,
    ) -> Result<ApplyOutcome, YadbeError> {
        let edit = self.edit(meta, result_id).await?;
        Self::check(&edit, changes)?;
        if self
            .manager
            .session(&edit.connection_id)?
            .target()
            .read_only
        {
            return Err(reason_error(ResultReadOnlyReason::ReadOnlyConnection));
        }
        if self.runner.tab_info(&edit.tab_id).transaction.status != TransactionStatus::Idle {
            return Err(reason_error(ResultReadOnlyReason::OpenTransaction));
        }
        self.open(meta, &edit).await?;
        let hidden = edit.hidden_tab();
        let mut changes = changes.clone();
        self.complete_deletes(&hidden, &mut changes).await?;
        let outcome = self.tables.apply(&hidden, &changes).await?;
        Ok(match outcome {
            ApplyOutcome::Conflicted {
                conflicts,
                current,
                duration_ms,
            } => {
                let rows = current
                    .positions
                    .iter()
                    .map(|_| None)
                    .collect::<Vec<Option<u32>>>();
                ApplyOutcome::Conflicted {
                    conflicts,
                    current: self.remap(&edit, &current, &rows)?,
                    duration_ms,
                }
            }
            other => other,
        })
    }

    /// Adds to each deleted row the table columns the result does not show, as stored now.
    async fn complete_deletes(
        &self,
        hidden: &str,
        changes: &mut ChangeSet,
    ) -> Result<(), YadbeError> {
        if changes.deletes.is_empty() {
            return Ok(());
        }
        let keys: Vec<RowKey> = changes.deletes.iter().map(|d| d.key.clone()).collect();
        let read = self.tables.refresh_rows(hidden, keys).await?;
        let stored = self.store.get(read.window.result_id)?;
        let columns = stored.columns().to_vec();
        for (delete, position) in changes.deletes.iter_mut().zip(&read.positions) {
            let Some(position) = position else {
                // Gone already: the delete conflicts on its own.
                continue;
            };
            let Some(row) = stored.rows(*position as usize, 1).into_iter().next() else {
                continue;
            };
            for (column, value) in columns.iter().zip(row) {
                if !delete.values.iter().any(|v| v.column == column.name) {
                    delete.values.push(crate::edit::model::ColumnValue {
                        column: column.name.clone(),
                        value,
                    });
                }
            }
        }
        self.store.remove([read.window.result_id]);
        Ok(())
    }

    /// Reads rows of the result's table again, in the result's columns.
    pub async fn refresh(
        &self,
        meta: &MetaService,
        result_id: u32,
        rows: &[ResultRowRef],
    ) -> Result<RefreshedRows, YadbeError> {
        let edit = self.edit(meta, result_id).await?;
        self.open(meta, &edit).await?;
        let keys = rows.iter().map(|r| r.key.clone()).collect();
        let read = self.tables.refresh_rows(&edit.hidden_tab(), keys).await?;
        let at: Vec<Option<u32>> = rows.iter().map(|r| Some(r.row)).collect();
        let remapped = self.remap(&edit, &read, &at)?;
        self.store.remove([read.window.result_id]);
        Ok(remapped)
    }

    /// Rows a table tab read (table columns), in the result's columns: a computed column
    /// takes its value from row `rows[i]` of the result, `NULL` without one.
    fn remap(
        &self,
        edit: &ResultEdit,
        read: &RefreshedRows,
        rows: &[Option<u32>],
    ) -> Result<RefreshedRows, YadbeError> {
        let table_rows = self.store.get(read.window.result_id)?;
        let table_columns: Vec<String> = table_rows
            .columns()
            .iter()
            .map(|c| c.name.clone())
            .collect();
        let at: Vec<Option<usize>> = edit
            .sources
            .iter()
            .map(|s| {
                s.as_ref()
                    .and_then(|name| table_columns.iter().position(|c| c == name))
            })
            .collect();
        let original = self.store.get(edit.result_id).ok();
        let mut out = Vec::new();
        let mut positions = Vec::with_capacity(read.positions.len());
        for (i, position) in read.positions.iter().enumerate() {
            let Some(position) = position else {
                positions.push(None);
                continue;
            };
            let Some(fresh) = table_rows.rows(*position as usize, 1).into_iter().next() else {
                positions.push(None);
                continue;
            };
            let old = rows
                .get(i)
                .copied()
                .flatten()
                .and_then(|row| original.as_ref()?.rows(row as usize, 1).into_iter().next());
            let row: Vec<Value> = at
                .iter()
                .enumerate()
                .map(|(col, index)| match index {
                    Some(index) => fresh.get(*index).cloned().unwrap_or(Value::Null),
                    None => old
                        .as_ref()
                        .and_then(|old| old.get(col).cloned())
                        .unwrap_or(Value::Null),
                })
                .collect();
            out.push(row);
            positions.push(Some(u32::try_from(out.len() - 1).unwrap_or(u32::MAX)));
        }
        let stored = self.store.create(edit.columns.clone());
        stored.append(out);
        lock(&edit.results).push(stored.id());
        Ok(RefreshedRows {
            window: stored.window(0, PAGE_WINDOW_ROWS as usize),
            positions,
        })
    }

    pub async fn cancel(&self, result_id: u32) {
        let edit = lock(&self.edits).get(&result_id).cloned();
        if let Some(edit) = edit {
            self.tables.cancel(&edit.hidden_tab()).await;
        }
    }

    pub async fn close(&self, result_id: u32) {
        let edit = lock(&self.edits).remove(&result_id);
        if let Some(edit) = edit {
            self.forget(&edit).await;
        }
    }

    async fn forget(&self, edit: &ResultEdit) {
        self.tables.close(&edit.hidden_tab()).await;
        let ids = std::mem::take(&mut *lock(&edit.results));
        self.store.remove(ids);
    }

    /// Closes the edits of results whose query was replaced or whose tab closed.
    async fn sweep(&self) {
        let gone: Vec<Arc<ResultEdit>> = {
            let mut edits = lock(&self.edits);
            let ids: Vec<u32> = edits
                .keys()
                .copied()
                .filter(|id| self.runner.result_origin(*id).is_err())
                .collect();
            ids.iter().filter_map(|id| edits.remove(id)).collect()
        };
        for edit in gone {
            self.forget(&edit).await;
        }
    }
}

/// The table column named `name` as the engine reported it: exactly, else the only one equal
/// to it ignoring case.
fn table_column(shape: &TableShape, name: &str) -> Option<usize> {
    let columns = &shape.details.columns;
    if let Some(index) = columns.iter().position(|c| c.name == name) {
        return Some(index);
    }
    let mut matching = columns
        .iter()
        .enumerate()
        .filter(|(_, c)| c.name.eq_ignore_ascii_case(name));
    match (matching.next(), matching.next()) {
        (Some((index, _)), None) => Some(index),
        _ => None,
    }
}

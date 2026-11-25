//! A whole collection for an export (M4-11): every document matching a collection tab's
//! filter, projection and sort, not only the page shown. Pages are read the way the tab reads
//! them (after the last `_id` when the order allows it, else by skipping, `_id` breaking ties),
//! each one a `find` of yadbe's own through the gate: read-only, the statement timeout, the
//! statement log. Pages are read one after the other, not in one snapshot: documents changed
//! meanwhile by others can be missed or read twice (as for a table export).

use std::sync::Arc;

use crate::db::document::json::Json;
use crate::db::document::ops::{DocEvent, Namespace};
use crate::db::driver::DocumentConnection;
use crate::db::errors::YadbeError;
use crate::db::value::{ColumnMeta, Value};
use crate::session::ConnectionSession;
use crate::session::document::gate::{self, GateContext, GateOutcome, GateRequest, Origin};
use crate::session::document::results::{document_column, grid_columns, grid_row};
use crate::session::document::service::{
    DocumentService, PageStart, Paging, page_find, parse_document,
};

/// Documents per page of an export.
pub const EXPORT_PAGE: u32 = 1_000;

/// What a collection export reads: the query of a collection tab, as typed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectionExport {
    pub connection_id: String,
    pub ns: Namespace,
    /// Extended JSON; empty: none.
    pub filter: String,
    pub projection: String,
    pub sort: String,
    /// Each document whole (one `document` column, canonical Extended JSON: what JSON Lines
    /// writes), rather than grid rows.
    pub documents: bool,
}

/// Where the pages of an export are: what the next one starts after, whether it is the last.
#[derive(Debug, Clone, PartialEq)]
struct Cursor {
    paging: Paging,
    /// The `_id` the last page ended on (`_id` paging).
    after: Option<Json>,
    /// Documents read so far (skip paging, and the fallback below).
    read: u64,
    page_size: u32,
    done: bool,
}

impl Cursor {
    fn new(paging: Paging, page_size: u32) -> Self {
        Self {
            paging,
            after: None,
            read: 0,
            page_size: page_size.max(1),
            done: false,
        }
    }

    fn start(&self) -> PageStart {
        match self.paging {
            Paging::Keyset { descending } => PageStart::After {
                descending,
                after: self.after.clone(),
            },
            Paging::Skip => PageStart::Skip(self.read),
        }
    }

    /// Moves past a page just read.
    fn advance(&mut self, page: &[Json]) {
        self.read += page.len() as u64;
        if page.len() < self.page_size as usize {
            self.done = true;
            return;
        }
        if let Paging::Keyset { .. } = self.paging {
            match page.last().and_then(|d| d.get("_id")) {
                Some(id) => self.after = Some(id.clone()),
                // Documents without `_id` (a view that drops it): their order is the `_id`
                // order all the same, so skipping what was read goes on from the same place.
                None => self.paging = Paging::Skip,
            }
        }
    }
}

/// The rows of a collection export: grid rows under the columns of the first page (a field
/// that only appears later is left out of them), or whole documents.
pub struct CollectionExportRows {
    session: Arc<ConnectionSession>,
    conn: Arc<dyn DocumentConnection>,
    ns: Namespace,
    filter: Json,
    projection: Option<Json>,
    sort: Option<Json>,
    cursor: Cursor,
    /// Names of the grid columns; `None`: whole documents.
    names: Option<Vec<String>>,
    columns: Vec<ColumnMeta>,
    /// The first page, read when the export opened.
    first: Option<Vec<Json>>,
    /// The token of the `find` in flight, to stop it on the server when the export is dropped.
    running: Option<String>,
}

impl CollectionExportRows {
    pub fn columns(&self) -> &[ColumnMeta] {
        &self.columns
    }

    async fn read_page(&mut self) -> Result<Vec<Json>, YadbeError> {
        let op = page_find(
            self.ns.clone(),
            &self.filter,
            self.projection.clone(),
            self.sort.as_ref(),
            self.cursor.start(),
            i64::from(self.cursor.page_size),
        );
        let token = uuid::Uuid::new_v4().to_string();
        self.running = Some(token.clone());
        let ctx = GateContext::of(&self.session);
        let request = GateRequest {
            op: &op,
            origin: Origin::Yadbe,
            confirmed: false,
            max_time: self.session.statement_timeout(),
            token,
            max_documents: None,
        };
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let collect = async {
            let mut docs = Vec::new();
            while let Some(DocEvent::Documents(batch)) = rx.recv().await {
                docs.extend(batch);
            }
            docs
        };
        let (outcome, docs) = tokio::join!(gate::run(&ctx, &*self.conn, request, tx), collect);
        self.running = None;
        match outcome? {
            GateOutcome::Done(_) => {}
            GateOutcome::Confirm(_) => {
                return Err(YadbeError::internal(
                    "an export page was classified as dangerous",
                ));
            }
        }
        self.cursor.advance(&docs);
        Ok(docs)
    }

    fn rows(&self, docs: &[Json]) -> Vec<Vec<Value>> {
        match &self.names {
            Some(names) => docs.iter().map(|doc| grid_row(doc, names)).collect(),
            None => docs
                .iter()
                .map(|doc| vec![Value::Json(doc.to_text())])
                .collect(),
        }
    }

    /// The next page, `None` at the end. Dropping the call mid-page loses that page: the
    /// export is over then (a cancel).
    pub async fn next_batch(&mut self) -> Result<Option<Vec<Vec<Value>>>, YadbeError> {
        let docs = match self.first.take() {
            Some(first) => first,
            None if self.cursor.done => return Ok(None),
            None => self.read_page().await?,
        };
        if docs.is_empty() {
            return Ok(None);
        }
        Ok(Some(self.rows(&docs)))
    }
}

impl Drop for CollectionExportRows {
    /// A cancelled export stops its `find` on the server (`killOp`).
    fn drop(&mut self) {
        let Some(token) = self.running.take() else {
            return;
        };
        let conn = Arc::clone(&self.conn);
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                if let Err(err) = conn.kill(&token).await {
                    tracing::debug!(error = %err, "collection export cancel failed");
                }
            });
        }
    }
}

impl DocumentService {
    async fn open_export(
        &self,
        export: CollectionExport,
        page_size: u32,
    ) -> Result<CollectionExportRows, YadbeError> {
        let filter =
            parse_document(&export.filter, "filter", "Le filtre")?.unwrap_or_else(Json::empty);
        let projection = parse_document(&export.projection, "projection", "La projection")?;
        let sort = parse_document(&export.sort, "sort", "Le tri")?.filter(|s| !s.is_empty_object());
        let session = self.session(&export.connection_id)?;
        let conn = Self::connection(&session)?;
        let paging = self
            .paging_of(
                &export.connection_id,
                &export.ns,
                sort.as_ref(),
                projection.as_ref(),
            )
            .await?;
        let mut rows = CollectionExportRows {
            session,
            conn,
            ns: export.ns,
            filter,
            projection,
            sort,
            cursor: Cursor::new(paging, page_size),
            names: None,
            columns: vec![document_column()],
            first: None,
            running: None,
        };
        let first = rows.read_page().await?;
        if !export.documents {
            let (names, columns) = grid_columns(&first);
            rows.names = Some(names);
            rows.columns = columns;
        }
        rows.first = Some(first);
        Ok(rows)
    }

    /// Every document of `export`, read in pages of [`EXPORT_PAGE`]. The first page is read
    /// here: a bad filter or a lost connection fails the start of the export, not its file.
    pub async fn export_rows(
        &self,
        export: CollectionExport,
    ) -> Result<CollectionExportRows, YadbeError> {
        self.open_export(export, EXPORT_PAGE).await
    }

    /// The first `limit` rows of an export, for the preview. Grid rows come from a whole first
    /// page, so that the preview has the columns of the file.
    pub async fn export_preview(
        &self,
        export: CollectionExport,
        limit: u32,
    ) -> Result<(Vec<ColumnMeta>, Vec<Vec<Value>>), YadbeError> {
        let page = if export.documents {
            limit.clamp(1, EXPORT_PAGE)
        } else {
            EXPORT_PAGE
        };
        let mut rows = self.open_export(export, page).await?;
        let columns = rows.columns().to_vec();
        let mut first = rows.next_batch().await?.unwrap_or_default();
        first.truncate(limit as usize);
        Ok((columns, first))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::document::ops::DocOp;

    fn j(text: &str) -> Json {
        Json::parse(text).expect("json")
    }

    fn docs(ids: std::ops::Range<i64>) -> Vec<Json> {
        ids.map(|i| Json::object([("_id", Json::int(i))])).collect()
    }

    fn find_of(op: DocOp) -> (Json, Option<Json>, Option<u64>) {
        match op {
            DocOp::Find {
                filter, options, ..
            } => (filter, options.sort, options.skip),
            other => panic!("not a find: {other:?}"),
        }
    }

    #[test]
    fn id_pages_start_after_the_last_id_read() {
        let mut cursor = Cursor::new(Paging::Keyset { descending: false }, 3);
        assert_eq!(
            cursor.start(),
            PageStart::After {
                descending: false,
                after: None
            }
        );
        cursor.advance(&docs(0..3));
        assert!(!cursor.done);
        let filter = j(r#"{"status":"paid"}"#);
        let (find, sort, skip) = find_of(page_find(
            Namespace::new("db", "c"),
            &filter,
            None,
            None,
            cursor.start(),
            3,
        ));
        assert_eq!(
            find,
            j(r#"{"$and":[{"status":"paid"},{"_id":{"$gt":2}}]}"#),
            "the filter and the bound"
        );
        assert_eq!(sort, Some(j(r#"{"_id":1}"#)));
        assert_eq!(skip, None);
        cursor.advance(&docs(3..5));
        assert!(cursor.done, "a short page is the last");
        assert_eq!(cursor.read, 5);
    }

    #[test]
    fn descending_id_pages_go_below_the_last_id() {
        let mut cursor = Cursor::new(Paging::Keyset { descending: true }, 2);
        cursor.advance(&[j(r#"{"_id":9}"#), j(r#"{"_id":8}"#)]);
        let (find, sort, _) = find_of(page_find(
            Namespace::new("db", "c"),
            &Json::empty(),
            None,
            Some(&j(r#"{"_id":-1}"#)),
            cursor.start(),
            2,
        ));
        assert_eq!(find, j(r#"{"_id":{"$lt":8}}"#));
        assert_eq!(sort, Some(j(r#"{"_id":-1}"#)));
    }

    #[test]
    fn other_sorts_skip_with_id_as_tie_breaker() {
        let mut cursor = Cursor::new(Paging::Skip, 2);
        cursor.advance(&docs(0..2));
        cursor.advance(&docs(2..4));
        let (find, sort, skip) = find_of(page_find(
            Namespace::new("db", "c"),
            &j(r#"{"a":1}"#),
            None,
            Some(&j(r#"{"total":-1}"#)),
            cursor.start(),
            2,
        ));
        assert_eq!(find, j(r#"{"a":1}"#));
        assert_eq!(sort, Some(j(r#"{"total":-1,"_id":1}"#)));
        assert_eq!(skip, Some(4));
        cursor.advance(&[]);
        assert!(cursor.done);
    }

    #[test]
    fn documents_without_id_fall_back_to_skipping() {
        let mut cursor = Cursor::new(Paging::Keyset { descending: false }, 2);
        cursor.advance(&[j(r#"{"a":1}"#), j(r#"{"a":2}"#)]);
        assert_eq!(cursor.paging, Paging::Skip);
        assert_eq!(cursor.start(), PageStart::Skip(2));
    }

    #[test]
    fn grid_rows_keep_the_columns_of_the_first_page() {
        let first = [j(r#"{"_id":1,"a":"x"}"#), j(r#"{"_id":2,"b":true}"#)];
        let (names, columns) = grid_columns(&first);
        assert_eq!(names, ["_id", "a", "b"]);
        assert_eq!(columns.len(), 3);
        let later = j(r#"{"c":3,"_id":3,"a":"y"}"#);
        assert_eq!(
            grid_row(&later, &names),
            vec![
                Value::Int("3".into()),
                Value::Text("y".into()),
                Value::Missing
            ],
            "a field the first page lacks is left out, a field a document lacks is missing"
        );
    }
}

//! `TableDataService`: table tabs (M2-1 browsing, M2-2 edits).

use std::sync::Arc;

use crate::db::errors::YadbeError;
use crate::db::meta::ObjectRef;
use crate::edit::model::{ApplyOutcome, ChangeSet, EditPreview};
use crate::events::EventSink;
use crate::session::ConnectionManager;
use crate::session::meta_cache::MetaService;
use crate::session::result_store::ResultStore;
use crate::session::table_model::{
    CountMode, RefreshedRows, RowKey, TableDataInfo, TableFilter, TablePage, TablePageRequest,
    TableRowCount,
};

pub struct TableDataService {
    #[allow(dead_code)]
    manager: Arc<ConnectionManager>,
    #[allow(dead_code)]
    store: Arc<ResultStore>,
    #[allow(dead_code)]
    sink: Arc<dyn EventSink>,
}

impl TableDataService {
    pub fn new(
        manager: Arc<ConnectionManager>,
        store: Arc<ResultStore>,
        sink: Arc<dyn EventSink>,
    ) -> Self {
        Self {
            manager,
            store,
            sink,
        }
    }

    pub async fn open(
        &self,
        _meta: &MetaService,
        _tab_id: &str,
        _connection_id: &str,
        _table: &ObjectRef,
    ) -> Result<TableDataInfo, YadbeError> {
        Err(YadbeError::not_implemented())
    }

    pub async fn page(
        &self,
        _tab_id: &str,
        _request: TablePageRequest,
    ) -> Result<TablePage, YadbeError> {
        Err(YadbeError::not_implemented())
    }

    pub async fn count(
        &self,
        _tab_id: &str,
        _filter: TableFilter,
        _mode: CountMode,
    ) -> Result<TableRowCount, YadbeError> {
        Err(YadbeError::not_implemented())
    }

    pub async fn refresh_rows(
        &self,
        _tab_id: &str,
        _keys: Vec<RowKey>,
    ) -> Result<RefreshedRows, YadbeError> {
        Err(YadbeError::not_implemented())
    }

    pub async fn cancel(&self, _tab_id: &str) {}

    pub async fn close(&self, _tab_id: &str) {}

    pub fn preview(&self, _tab_id: &str, _changes: &ChangeSet) -> Result<EditPreview, YadbeError> {
        Err(YadbeError::not_implemented())
    }

    pub async fn apply(
        &self,
        _tab_id: &str,
        _changes: &ChangeSet,
    ) -> Result<ApplyOutcome, YadbeError> {
        Err(YadbeError::not_implemented())
    }
}

//! The change journal service (F-090): records the change sets table tabs apply, applies the
//! retention preferences, and hands a revert the inverse of an entry.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::db::engine::EngineFamily;
use crate::db::errors::YadbeError;
use crate::db::meta::ObjectRef;
use crate::events::{BackendEvent, ChangeJournalChanged, EventSink};
use crate::store::{
    JournalEntry, JournalRetention, NewJournalEntry, RevertBlocker, Store, StoredInverse,
};

pub struct ChangeJournal {
    store: Arc<Store>,
    sink: Arc<dyn EventSink>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// What the user reads when a revert is refused.
fn blocker_message(blocker: &RevertBlocker) -> (String, String) {
    match blocker {
        RevertBlocker::OriginalUnknown { column } => (
            format!("the value \"{column}\" had before is not known"),
            format!("la valeur qu'avait « {column} » n'est pas connue"),
        ),
        RevertBlocker::DeletedRowUnknown => (
            "the values of a deleted row are not known".into(),
            "les valeurs d'une ligne supprimée ne sont pas connues".into(),
        ),
        RevertBlocker::ColumnsNotLoaded { columns } => (
            format!(
                "columns of a deleted row were not loaded ({})",
                columns.join(", ")
            ),
            format!(
                "des colonnes d'une ligne supprimée n'étaient pas chargées ({})",
                columns.join(", ")
            ),
        ),
        RevertBlocker::UnwritableColumn { column } => (
            format!("a deleted row holds a value of \"{column}\" that cannot be written back"),
            format!(
                "une ligne supprimée contient une valeur de « {column} » qui ne peut pas être réécrite"
            ),
        ),
        RevertBlocker::IdentityNotRestorable { column } => (
            format!("the identity value of \"{column}\" cannot be written back"),
            format!("la valeur d'identité de « {column} » ne peut pas être réécrite"),
        ),
        RevertBlocker::InsertedRowUnknown => (
            "an inserted row could not be read back".into(),
            "une ligne insérée n'a pas pu être relue".into(),
        ),
        RevertBlocker::UpdatedRowUnknown => (
            "an updated row could not be read back".into(),
            "une ligne modifiée n'a pas pu être relue".into(),
        ),
        RevertBlocker::TooLarge => (
            "its values were too large to keep".into(),
            "ses valeurs étaient trop volumineuses pour être conservées".into(),
        ),
        RevertBlocker::NotPlannable => (
            "its inverse statements could not be built".into(),
            "ses instructions inverses n'ont pas pu être construites".into(),
        ),
    }
}

/// The same table: a database and a schema only differ when both are given.
pub fn same_table(a: &ObjectRef, b: &ObjectRef) -> bool {
    a.name == b.name
        && (a.schema.is_none() || b.schema.is_none() || a.schema == b.schema)
        && (a.database.is_empty() || b.database.is_empty() || a.database == b.database)
}

impl ChangeJournal {
    pub fn new(store: Arc<Store>, sink: Arc<dyn EventSink>) -> Self {
        Self { store, sink }
    }

    /// The connection's current name (the id when it was deleted).
    pub fn connection_name(&self, connection_id: &str) -> String {
        self.store
            .connection(connection_id)
            .map_or_else(|_| connection_id.to_owned(), |c| c.definition.name)
    }

    /// Records a change set, applies the retention and announces it; `None` when the store
    /// could not take it (logged: the change itself is applied either way). `reverts`: marks
    /// that entry as reverted by the new one.
    pub async fn record(&self, entry: NewJournalEntry) -> Option<i64> {
        let store = Arc::clone(&self.store);
        let written = tokio::task::spawn_blocking(move || -> Result<i64, YadbeError> {
            let id = store.insert_journal(&entry)?;
            if let Some(reverted) = entry.reverts {
                store.mark_journal_reverted(reverted, id)?;
            }
            let preferences = store.preferences()?;
            store.prune_journal(
                JournalRetention {
                    max_entries: preferences.journal_max_entries,
                    max_age_days: preferences.journal_max_age_days,
                },
                now_ms(),
            )?;
            Ok(id)
        })
        .await;
        let id = match written {
            Ok(Ok(id)) => Some(id),
            Ok(Err(err)) => {
                tracing::error!(error = %err, "cannot write the change journal");
                None
            }
            Err(err) => {
                tracing::error!(error = %err, "change journal writer failed");
                None
            }
        };
        self.notify();
        id
    }

    /// Announces a change (an entry recorded, entries cleared, the retention applied).
    pub fn notify(&self) {
        self.sink
            .emit(BackendEvent::ChangeJournalChanged(ChangeJournalChanged {}));
    }

    /// Applies the retention preferences now (they were just changed).
    pub fn prune_now(&self) -> Result<(), YadbeError> {
        let preferences = self.store.preferences()?;
        let gone = self.store.prune_journal(
            JournalRetention {
                max_entries: preferences.journal_max_entries,
                max_age_days: preferences.journal_max_age_days,
            },
            now_ms(),
        )?;
        if gone > 0 {
            self.notify();
        }
        Ok(())
    }

    /// The inverse of entry `id` for a revert on `table` of `connection_id`: refused
    /// (`invalidArgument`) when the entry is gone, belongs to another table or family, was
    /// already reverted or cannot be reverted faithfully.
    pub fn revert_input(
        &self,
        id: u32,
        connection_id: &str,
        table: &ObjectRef,
    ) -> Result<String, YadbeError> {
        let (entry, inverse) = self.revertible(id, connection_id, EngineFamily::Sql)?;
        if !same_table(&entry.table, table) {
            return Err(YadbeError::invalid_argument(
                "This change set was applied to another table.",
                "Cet ensemble de modifications a été appliqué à une autre table.",
            ));
        }
        Ok(inverse)
    }

    /// Entry `id` and its inverse (JSON, written by the `family`'s service), when it can be
    /// reverted on `connection_id`: refused (`invalidArgument`) when the entry is gone,
    /// belongs to another connection or family, was already reverted or cannot be reverted
    /// faithfully. Every family's revert goes through it.
    pub fn revertible(
        &self,
        id: u32,
        connection_id: &str,
        family: EngineFamily,
    ) -> Result<(JournalEntry, String), YadbeError> {
        let StoredInverse { entry, inverse } =
            self.store.journal_inverse(id)?.ok_or_else(|| {
                YadbeError::invalid_argument(
                    "This change set is no longer in the journal.",
                    "Cet ensemble de modifications n'est plus dans le journal.",
                )
            })?;
        if entry.connection_id != connection_id || entry.family != family {
            return Err(YadbeError::invalid_argument(
                "This change set was applied to another connection.",
                "Cet ensemble de modifications a été appliqué à une autre connexion.",
            ));
        }
        if let Some(by) = entry.reverted_by {
            return Err(YadbeError::invalid_argument(
                format!("This change set was already reverted (#{by})."),
                format!("Cet ensemble de modifications a déjà été annulé (n° {by})."),
            ));
        }
        if let Some(blocker) = &entry.revert_blocker {
            let (en, fr) = blocker_message(blocker);
            return Err(YadbeError::invalid_argument(
                format!("This change set cannot be reverted faithfully: {en}."),
                format!("Cet ensemble de modifications ne peut pas être annulé fidèlement : {fr}."),
            ));
        }
        let inverse = inverse.ok_or_else(|| {
            YadbeError::invalid_argument(
                "This change set cannot be reverted.",
                "Cet ensemble de modifications ne peut pas être annulé.",
            )
        })?;
        Ok((entry, inverse))
    }
}

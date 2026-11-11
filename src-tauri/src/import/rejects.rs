//! The side file of rejected rows: a CSV with the line, the reason and the row's own cells,
//! written next to nothing until the import ends (a temporary file renamed over the target).

use std::io::Write;
use std::path::{Path, PathBuf};

use crate::db::errors::YadbeError;

const FLUSH_BYTES: usize = 64 * 1024;

/// One CSV line; quoted when a field holds a delimiter, a quote or a line break.
pub fn csv_line(fields: &[Option<&str>]) -> String {
    let mut line = String::new();
    for (n, field) in fields.iter().enumerate() {
        if n > 0 {
            line.push(',');
        }
        let Some(text) = field else { continue };
        if text.is_empty() || text.contains([',', '"', '\n', '\r']) {
            line.push('"');
            line.push_str(&text.replace('"', "\"\""));
            line.push('"');
        } else {
            line.push_str(text);
        }
    }
    line.push('\n');
    line
}

async fn blocking<T, F>(work: F) -> Result<T, YadbeError>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| YadbeError::internal(format!("background task failed: {e}")))
}

pub struct RejectsFile {
    file: Option<std::fs::File>,
    tmp: PathBuf,
    target: PathBuf,
    buffer: Vec<u8>,
}

impl RejectsFile {
    /// Creates the file with its header: `line`, `error`, then the file's columns.
    pub async fn create(
        target: &Path,
        import_id: u32,
        columns: &[String],
    ) -> Result<Self, YadbeError> {
        let name = target
            .file_name()
            .map_or_else(|| "rejects".into(), |n| n.to_string_lossy().into_owned());
        let tmp = target.with_file_name(format!(".{name}.yadbe-import-{import_id}.tmp"));
        let display = target.display().to_string();
        let opened = {
            let tmp = tmp.clone();
            blocking(move || {
                std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(tmp)
            })
            .await?
        };
        let file = opened.map_err(|e| YadbeError::file_write_failed(&display, &e))?;
        let mut header: Vec<Option<&str>> = vec![Some("line"), Some("error")];
        header.extend(columns.iter().map(|c| Some(c.as_str())));
        Ok(Self {
            file: Some(file),
            tmp,
            target: target.to_path_buf(),
            buffer: csv_line(&header).into_bytes(),
        })
    }

    pub async fn push(
        &mut self,
        line: u64,
        error: &str,
        cells: &[Option<String>],
    ) -> Result<(), YadbeError> {
        let line = line.to_string();
        let mut fields: Vec<Option<&str>> = vec![Some(&line), Some(error)];
        fields.extend(cells.iter().map(Option::as_deref));
        self.buffer.extend_from_slice(csv_line(&fields).as_bytes());
        if self.buffer.len() >= FLUSH_BYTES {
            self.flush().await?;
        }
        Ok(())
    }

    async fn flush(&mut self) -> Result<(), YadbeError> {
        let Some(mut file) = self.file.take() else {
            return Err(YadbeError::internal("the rejects file is closed"));
        };
        let buffer = std::mem::take(&mut self.buffer);
        let (file, written) = blocking(move || {
            let written = file.write_all(&buffer);
            (file, written)
        })
        .await?;
        self.file = Some(file);
        written.map_err(|e| YadbeError::file_write_failed(&self.target.display().to_string(), &e))
    }

    /// Writes the rest and renames the file over the target.
    pub async fn commit(mut self) -> Result<(), YadbeError> {
        self.flush().await?;
        let file = self.file.take();
        let (tmp, target) = (self.tmp.clone(), self.target.clone());
        let done = blocking(move || {
            if let Some(file) = file {
                file.sync_all()?;
            }
            std::fs::rename(&tmp, &target)
        })
        .await?;
        done.map_err(|e| YadbeError::file_write_failed(&self.target.display().to_string(), &e))
    }

    pub async fn discard(mut self) {
        self.file = None;
        let tmp = self.tmp.clone();
        let _ = blocking(move || std::fs::remove_file(tmp)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_what_needs_it() {
        assert_eq!(
            csv_line(&[Some("12"), Some("a,b"), Some("say \"x\""), None, Some("")]),
            "12,\"a,b\",\"say \"\"x\"\"\",,\"\"\n"
        );
    }

    #[tokio::test]
    async fn writes_a_header_and_rows_then_renames() {
        let dir = tempfile::tempdir().expect("dir");
        let target = dir.path().join("rejects.csv");
        let columns = vec!["id".to_owned(), "name".to_owned()];
        let mut file = RejectsFile::create(&target, 1, &columns)
            .await
            .expect("creates");
        file.push(3, "bad id", &[Some("x".into()), None])
            .await
            .expect("pushes");
        assert!(!target.exists(), "nothing at the target before the end");
        file.commit().await.expect("commits");
        assert_eq!(
            std::fs::read_to_string(&target).expect("reads"),
            "line,error,id,name\n3,bad id,x,\n"
        );
        let leftovers: Vec<_> = std::fs::read_dir(dir.path()).expect("lists").collect();
        assert_eq!(leftovers.len(), 1);

        let mut discarded = RejectsFile::create(&dir.path().join("other.csv"), 2, &columns)
            .await
            .expect("creates");
        discarded.push(1, "x", &[]).await.expect("pushes");
        discarded.discard().await;
        assert_eq!(std::fs::read_dir(dir.path()).expect("lists").count(), 1);
    }
}

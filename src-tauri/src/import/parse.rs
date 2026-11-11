//! Reading an import file as records of text cells: format detection, the CSV and JSON
//! sources, and the preview. Nothing here holds more than a few rows of the file.

use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use super::csv::{CsvReader, RawRecord};
use super::json::{JsonCell, JsonObjects};
use super::model::{
    ImportDelimiter, ImportEncoding, ImportFormat, ImportParseOptions, ImportPreview, ImportQuote,
};
use super::text::{TextCounters, TextReader, sniff_bom, sniff_encoding};
use crate::db::errors::YadbeError;

/// Bytes of the file start read to detect its format.
const SNIFF_BYTES: usize = 64 * 1024;
/// Records examined to detect the delimiter.
const SNIFF_RECORDS: usize = 30;
/// Objects read to find the keys of a JSON file.
const JSON_SCHEMA_OBJECTS: usize = 1000;
/// Rows of a preview at most.
pub const MAX_PREVIEW_ROWS: u32 = 200;

#[derive(Debug)]
pub enum ParseError {
    Io(String),
    Invalid { line: u64, problem: String },
}

impl ParseError {
    pub fn into_yadbe(self, path: &str) -> YadbeError {
        match self {
            ParseError::Io(detail) => {
                YadbeError::file_read_failed(path, &std::io::Error::other(detail))
            }
            ParseError::Invalid { line, problem } => {
                YadbeError::import_file_invalid(line, &problem)
            }
        }
    }
}

/// One row of the file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    /// 1-based line of the row in the file.
    pub line: u64,
    /// `None` is `NULL`.
    pub cells: Vec<Option<String>>,
    /// The field count when it differs from the header's.
    pub ragged: Option<u32>,
}

pub trait RecordSource: Send {
    fn columns(&self) -> &[String];
    fn next_record(&mut self) -> Result<Option<Record>, ParseError>;
}

/// What an opened file reports while it is read.
#[derive(Clone, Default)]
pub struct SourceStats {
    pub text: TextCounters,
    /// Object keys met that are not columns (JSON).
    pub dropped_keys: Arc<AtomicU64>,
}

impl SourceStats {
    pub fn bytes_read(&self) -> u64 {
        self.text.bytes.load(Ordering::Relaxed)
    }
    pub fn invalid_bytes(&self) -> u64 {
        self.text.invalid.load(Ordering::Relaxed)
    }
    pub fn dropped_keys(&self) -> u64 {
        self.dropped_keys.load(Ordering::Relaxed)
    }
}

pub struct OpenedFile {
    pub source: Box<dyn RecordSource>,
    pub stats: SourceStats,
    pub file_size: u64,
}

fn column_name(index: usize) -> String {
    format!("Column {}", index + 1)
}

struct CsvSource<R: Read + Send> {
    reader: CsvReader<R>,
    columns: Vec<String>,
    pending: Option<RawRecord>,
    options: ImportParseOptions,
}

impl<R: Read + Send> CsvSource<R> {
    fn new(mut reader: CsvReader<R>, options: &ImportParseOptions) -> Result<Self, ParseError> {
        reader.skip_lines(options.skip_rows)?;
        let first = reader.next_record()?;
        let (columns, pending) = match first {
            None => (Vec::new(), None),
            Some(record) if options.header => {
                let names = record
                    .fields
                    .iter()
                    .enumerate()
                    .map(|(i, f)| {
                        let name = f.text.trim();
                        if name.is_empty() {
                            column_name(i)
                        } else {
                            name.to_owned()
                        }
                    })
                    .collect();
                (names, None)
            }
            Some(record) => (
                (0..record.fields.len()).map(column_name).collect(),
                Some(record),
            ),
        };
        Ok(Self {
            reader,
            columns,
            pending,
            options: options.clone(),
        })
    }

    fn cell(&self, field: super::csv::RawField) -> Option<String> {
        if field.quoted {
            return Some(field.text);
        }
        let text = if self.options.trim {
            field.text.trim().to_owned()
        } else {
            field.text
        };
        let null = (self.options.empty_as_null && text.is_empty())
            || self.options.null_token.as_deref() == Some(text.as_str());
        (!null).then_some(text)
    }
}

impl<R: Read + Send> RecordSource for CsvSource<R> {
    fn columns(&self) -> &[String] {
        &self.columns
    }

    fn next_record(&mut self) -> Result<Option<Record>, ParseError> {
        let raw = match self.pending.take() {
            Some(raw) => raw,
            None => match self.reader.next_record()? {
                Some(raw) => raw,
                None => return Ok(None),
            },
        };
        let found = raw.fields.len();
        let ragged =
            (found != self.columns.len()).then(|| u32::try_from(found).unwrap_or(u32::MAX));
        let cells = raw.fields.into_iter().map(|f| self.cell(f)).collect();
        Ok(Some(Record {
            line: raw.line,
            cells,
            ragged,
        }))
    }
}

struct JsonSource<R: Read + Send> {
    objects: JsonObjects<R>,
    columns: Vec<String>,
    index: HashMap<String, usize>,
    buffered: VecDeque<(u64, Vec<(String, JsonCell)>)>,
    dropped: Arc<AtomicU64>,
}

impl<R: Read + Send> JsonSource<R> {
    fn new(mut objects: JsonObjects<R>, dropped: Arc<AtomicU64>) -> Result<Self, ParseError> {
        let mut buffered = VecDeque::new();
        let mut columns: Vec<String> = Vec::new();
        let mut index: HashMap<String, usize> = HashMap::new();
        while buffered.len() < JSON_SCHEMA_OBJECTS {
            let Some((line, entries)) = objects.next_object()? else {
                break;
            };
            for (key, _) in &entries {
                if !index.contains_key(key) {
                    index.insert(key.clone(), columns.len());
                    columns.push(key.clone());
                }
            }
            buffered.push_back((line, entries));
        }
        Ok(Self {
            objects,
            columns,
            index,
            buffered,
            dropped,
        })
    }
}

impl<R: Read + Send> RecordSource for JsonSource<R> {
    fn columns(&self) -> &[String] {
        &self.columns
    }

    fn next_record(&mut self) -> Result<Option<Record>, ParseError> {
        let next = match self.buffered.pop_front() {
            Some(next) => next,
            None => match self.objects.next_object()? {
                Some(next) => next,
                None => return Ok(None),
            },
        };
        let (line, entries) = next;
        let mut cells: Vec<Option<String>> = vec![None; self.columns.len()];
        for (key, value) in entries {
            match self.index.get(&key) {
                Some(&at) => {
                    cells[at] = match value {
                        JsonCell::Null => None,
                        JsonCell::Text(text) => Some(text),
                    };
                }
                None => {
                    self.dropped.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
        Ok(Some(Record {
            line,
            cells,
            ragged: None,
        }))
    }
}

fn open_file(path: &Path) -> Result<(File, u64), YadbeError> {
    let display = path.display().to_string();
    let file = File::open(path).map_err(|e| YadbeError::file_read_failed(&display, &e))?;
    let size = file
        .metadata()
        .map_err(|e| YadbeError::file_read_failed(&display, &e))?
        .len();
    Ok((file, size))
}

/// Opens `path` as records. Fails on a file that cannot be read, a JSON file whose first
/// objects are malformed, or a CSV whose first row is.
pub fn open(path: &Path, options: &ImportParseOptions) -> Result<OpenedFile, YadbeError> {
    let (file, file_size) = open_file(path)?;
    let display = path.display().to_string();
    let stats = SourceStats::default();
    let text = TextReader::new(file, options.encoding, stats.text.clone());
    let source: Box<dyn RecordSource> = match options.format {
        ImportFormat::Csv => {
            let reader = CsvReader::new(text, options.delimiter.char(), options.quote.char());
            Box::new(CsvSource::new(reader, options).map_err(|e| e.into_yadbe(&display))?)
        }
        ImportFormat::Json | ImportFormat::JsonLines => {
            let objects = JsonObjects::new(text, options.format == ImportFormat::Json);
            Box::new(
                JsonSource::new(objects, Arc::clone(&stats.dropped_keys))
                    .map_err(|e| e.into_yadbe(&display))?,
            )
        }
    };
    Ok(OpenedFile {
        source,
        stats,
        file_size,
    })
}

/// The options a file seems to need: encoding from its first bytes, format from its first
/// character, and for CSV the delimiter that gives the most regular rows.
pub fn detect(path: &Path) -> Result<(ImportParseOptions, bool), YadbeError> {
    let (file, _) = open_file(path)?;
    let display = path.display().to_string();
    let mut head = Vec::with_capacity(SNIFF_BYTES);
    file.take(SNIFF_BYTES as u64)
        .read_to_end(&mut head)
        .map_err(|e| YadbeError::file_read_failed(&display, &e))?;
    let truncated = head.len() >= SNIFF_BYTES;
    let encoding = sniff_encoding(&head);
    let bom = sniff_bom(&head).is_some();
    let mut reader = TextReader::new(head.as_slice(), encoding, TextCounters::default());
    let mut sample = String::new();
    while let Ok(Some(c)) = reader.next_char() {
        sample.push(c);
    }
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let first = sample.trim_start().chars().next();
    let mut options = ImportParseOptions {
        encoding,
        ..ImportParseOptions::default()
    };
    match first {
        Some('[') => options.format = ImportFormat::Json,
        Some('{') => options.format = ImportFormat::JsonLines,
        _ if matches!(extension.as_str(), "jsonl" | "ndjson") => {
            options.format = ImportFormat::JsonLines;
        }
        _ => {
            detect_csv(&sample, truncated, &extension, &mut options);
        }
    }
    Ok((options, bom))
}

fn records_of(sample: &str, delimiter: ImportDelimiter, truncated: bool) -> Vec<RawRecord> {
    let mut reader = CsvReader::new(
        TextReader::new(
            sample.as_bytes(),
            ImportEncoding::Utf8,
            TextCounters::default(),
        ),
        delimiter.char(),
        Some('"'),
    );
    let mut records = Vec::new();
    while records.len() < SNIFF_RECORDS + 1 {
        match reader.next_record() {
            Ok(Some(record)) => records.push(record),
            Ok(None) | Err(_) => break,
        }
    }
    // The sample may end inside a row.
    if truncated {
        records.pop();
    }
    records.truncate(SNIFF_RECORDS);
    records
}

/// How many rows have the most common field count, and that count.
fn regularity(records: &[RawRecord]) -> (usize, usize) {
    let mut counts: HashMap<usize, usize> = HashMap::new();
    for record in records {
        *counts.entry(record.fields.len()).or_default() += 1;
    }
    counts
        .into_iter()
        .map(|(fields, rows)| (rows, fields))
        .max()
        .unwrap_or((0, 0))
}

fn detect_csv(sample: &str, truncated: bool, extension: &str, options: &mut ImportParseOptions) {
    let candidates = [
        ImportDelimiter::Comma,
        ImportDelimiter::Semicolon,
        ImportDelimiter::Tab,
        ImportDelimiter::Pipe,
    ];
    let mut best: Option<(ImportDelimiter, (usize, usize))> = None;
    for delimiter in candidates {
        let records = records_of(sample, delimiter, truncated);
        let (rows, fields) = regularity(&records);
        if fields < 2 {
            continue;
        }
        let prefer_tab = extension == "tsv" && delimiter == ImportDelimiter::Tab;
        let better = match best {
            None => true,
            Some((_, (best_rows, best_fields))) => {
                rows > best_rows
                    || (rows == best_rows && fields > best_fields)
                    || (rows == best_rows && fields == best_fields && prefer_tab)
            }
        };
        if better {
            best = Some((delimiter, (rows, fields)));
        }
    }
    options.delimiter = best.map_or(ImportDelimiter::Comma, |(d, _)| d);
    options.quote = ImportQuote::Double;
    let records = records_of(sample, options.delimiter, truncated);
    if let Some(first) = records.first() {
        let names: Vec<&str> = first.fields.iter().map(|f| f.text.trim()).collect();
        let unique = names
            .iter()
            .enumerate()
            .all(|(i, n)| !names[..i].contains(n));
        options.header = unique
            && names
                .iter()
                .all(|n| !n.is_empty() && n.parse::<f64>().is_err());
    }
    let unquoted = |text: &str| {
        records
            .iter()
            .flat_map(|r| &r.fields)
            .any(|f| !f.quoted && f.text == text)
    };
    options.null_token = if unquoted("\\N") {
        Some("\\N".to_owned())
    } else if unquoted("NULL") {
        Some("NULL".to_owned())
    } else {
        None
    };
}

/// The first rows of `path` under `options` (detected when `None`).
pub fn preview(
    path: &Path,
    options: Option<ImportParseOptions>,
    limit: u32,
) -> Result<ImportPreview, YadbeError> {
    let display = path.display().to_string();
    let (options, bom) = match options {
        Some(options) => {
            let (_, bom) = detect(path)?;
            (options, bom)
        }
        None => detect(path)?,
    };
    let mut opened = open(path, &options)?;
    let limit = limit.min(MAX_PREVIEW_ROWS);
    let mut rows = Vec::new();
    let mut ragged_rows = 0_u32;
    while rows.len() < limit as usize {
        match opened
            .source
            .next_record()
            .map_err(|e| e.into_yadbe(&display))?
        {
            Some(record) => {
                if record.ragged.is_some() {
                    ragged_rows += 1;
                }
                rows.push(record.cells);
            }
            None => break,
        }
    }
    Ok(ImportPreview {
        options,
        bom,
        file_size: opened.file_size as f64,
        columns: opened.source.columns().to_vec(),
        rows,
        ragged_rows,
        invalid_bytes: u32::try_from(opened.stats.invalid_bytes()).unwrap_or(u32::MAX),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn file(name: &str, bytes: &[u8]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join(name);
        std::fs::File::create(&path)
            .and_then(|mut f| f.write_all(bytes))
            .expect("writes");
        (dir, path)
    }

    #[test]
    fn detects_a_semicolon_csv_with_a_header_and_a_null_token() {
        let (_dir, path) = file(
            "data.csv",
            "id;name;note\n1;\"Doe; John\";NULL\n2;Ana;ok\n3;Bob;\n".as_bytes(),
        );
        let (options, bom) = detect(&path).expect("detects");
        assert!(!bom);
        assert_eq!(options.format, ImportFormat::Csv);
        assert_eq!(options.delimiter, ImportDelimiter::Semicolon);
        assert!(options.header);
        assert_eq!(options.null_token.as_deref(), Some("NULL"));
        let preview = preview(&path, None, 10).expect("previews");
        assert_eq!(preview.columns, ["id", "name", "note"]);
        assert_eq!(preview.rows.len(), 3);
        assert_eq!(preview.rows[0][1].as_deref(), Some("Doe; John"));
        assert_eq!(preview.rows[0][2], None);
        assert_eq!(preview.rows[2][2], None, "an empty unquoted field is NULL");
    }

    #[test]
    fn a_header_is_not_assumed_when_the_first_row_is_data() {
        let (_dir, path) = file("d.txt", b"1,2,3\n4,5,6\n");
        let (options, _) = detect(&path).expect("detects");
        assert!(!options.header);
        let preview = preview(&path, None, 10).expect("previews");
        assert_eq!(preview.columns, ["Column 1", "Column 2", "Column 3"]);
        assert_eq!(preview.rows.len(), 2);
    }

    #[test]
    fn detects_tab_pipe_and_utf16() {
        let (_d, path) = file("a.tsv", b"a\tb\n1\t2\n");
        assert_eq!(
            detect(&path).expect("detects").0.delimiter,
            ImportDelimiter::Tab
        );
        let (_d, path) = file("a.csv", b"a|b|c\n1|2|3\n4|5|6\n");
        assert_eq!(
            detect(&path).expect("detects").0.delimiter,
            ImportDelimiter::Pipe
        );
        let mut bytes = vec![0xff, 0xfe];
        for unit in "id,name\n1,é\n".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let (_d, path) = file("u.csv", &bytes);
        let (options, bom) = detect(&path).expect("detects");
        assert!(bom);
        assert_eq!(options.encoding, ImportEncoding::Utf16le);
        let preview = preview(&path, None, 10).expect("previews");
        assert_eq!(preview.columns, ["id", "name"]);
        assert_eq!(preview.rows[0][1].as_deref(), Some("é"));
    }

    #[test]
    fn counts_ragged_rows_and_invalid_bytes() {
        let (_d, path) = file("r.csv", b"a,b\n1,2\n3\n4,5,6\ncaf\xe9,x\n");
        let preview = preview(&path, None, 10).expect("previews");
        assert_eq!(preview.ragged_rows, 2);
        assert_eq!(preview.invalid_bytes, 1);
    }

    #[test]
    fn detects_json_and_json_lines() {
        let (_d, path) = file(
            "a.json",
            b" [ {\"id\": 1, \"n\": \"x\"}, {\"id\": 2, \"extra\": true} ]",
        );
        let (options, _) = detect(&path).expect("detects");
        assert_eq!(options.format, ImportFormat::Json);
        let preview = preview(&path, None, 10).expect("previews");
        assert_eq!(preview.columns, ["id", "n", "extra"]);
        assert_eq!(preview.rows[1][2].as_deref(), Some("true"));
        assert_eq!(preview.rows[1][1], None);

        let (_d, path) = file("a.jsonl", b"{\"id\": 1}\n{\"id\": 2}\n");
        let (options, _) = detect(&path).expect("detects");
        assert_eq!(options.format, ImportFormat::JsonLines);
    }

    #[test]
    fn json_keys_past_the_schema_sample_are_counted_not_lost_silently() {
        let mut text = String::from("[");
        for i in 0..1100 {
            if i > 0 {
                text.push(',');
            }
            if i == 1050 {
                text.push_str("{\"id\":1,\"late\":2}");
            } else {
                text.push_str("{\"id\":1}");
            }
        }
        text.push(']');
        let (_d, path) = file("big.json", text.as_bytes());
        let (options, _) = detect(&path).expect("detects");
        let mut opened = open(&path, &options).expect("opens");
        assert_eq!(opened.source.columns(), ["id"]);
        while opened.source.next_record().expect("reads").is_some() {}
        assert_eq!(opened.stats.dropped_keys(), 1);
    }

    #[test]
    fn a_missing_file_is_a_typed_error() {
        let error = preview(Path::new("/nonexistent/x.csv"), None, 5).expect_err("fails");
        assert_eq!(error.code, crate::db::errors::ErrorCode::FileNotFound);
    }
}

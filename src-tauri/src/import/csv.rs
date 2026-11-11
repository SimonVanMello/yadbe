//! A streaming CSV reader: quoted fields with doubled quotes and line breaks, any single
//! character delimiter, `\n`, `\r\n` and `\r` line ends. It does not guess what a stray
//! quote means: inside an unquoted field it is an ordinary character.

use std::io::Read;

use super::parse::ParseError;
use super::text::TextReader;

/// A field wider than this is taken for a quote that never closes.
const MAX_FIELD_CHARS: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawField {
    pub text: String,
    /// Written between quotes: an empty one is an empty string, not `NULL`.
    pub quoted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawRecord {
    /// 1-based line the record starts on.
    pub line: u64,
    pub fields: Vec<RawField>,
}

pub struct CsvReader<R: Read> {
    text: TextReader<R>,
    delimiter: char,
    quote: Option<char>,
    /// Line of the next character.
    line: u64,
}

impl<R: Read> CsvReader<R> {
    pub fn new(text: TextReader<R>, delimiter: char, quote: Option<char>) -> Self {
        Self {
            text,
            delimiter,
            quote,
            line: 1,
        }
    }

    fn io(&self, error: &std::io::Error) -> ParseError {
        ParseError::Io(error.to_string())
    }

    fn next_char(&mut self) -> Result<Option<char>, ParseError> {
        let c = self.text.next_char().map_err(|e| self.io(&e))?;
        if c == Some('\n') {
            self.line += 1;
        }
        Ok(c)
    }

    fn peek(&mut self) -> Result<Option<char>, ParseError> {
        self.text.peek().map_err(|e| self.io(&e))
    }

    /// Skips `lines` lines (the preamble before a header).
    pub fn skip_lines(&mut self, lines: u32) -> Result<(), ParseError> {
        for _ in 0..lines {
            loop {
                match self.next_char()? {
                    None => return Ok(()),
                    Some('\n') => break,
                    Some(_) => {}
                }
            }
        }
        Ok(())
    }

    /// The next record, `None` at the end. Blank lines are skipped.
    pub fn next_record(&mut self) -> Result<Option<RawRecord>, ParseError> {
        loop {
            let start_line = self.line;
            let mut fields: Vec<RawField> = Vec::new();
            let mut text = String::new();
            let mut quoted = false;
            let mut any = false;
            loop {
                let Some(c) = self.next_char()? else {
                    if !any {
                        return Ok(None);
                    }
                    fields.push(RawField { text, quoted });
                    break;
                };
                any = true;
                if Some(c) == self.quote && text.is_empty() && !quoted {
                    quoted = true;
                    self.read_quoted(&mut text, start_line)?;
                } else if c == self.delimiter {
                    fields.push(RawField {
                        text: std::mem::take(&mut text),
                        quoted,
                    });
                    quoted = false;
                } else if c == '\n' || c == '\r' {
                    if c == '\r' && self.peek()? == Some('\n') {
                        self.next_char()?;
                    } else if c == '\r' {
                        // A lone carriage return ends a line (old Mac files).
                        self.line += 1;
                    }
                    fields.push(RawField { text, quoted });
                    break;
                } else {
                    text.push(c);
                    if text.len() > MAX_FIELD_CHARS {
                        return Err(ParseError::Invalid {
                            line: start_line,
                            problem: "a field is larger than 16 MiB: a quote may never close"
                                .to_owned(),
                        });
                    }
                }
            }
            let blank = fields.len() == 1 && fields[0].text.is_empty() && !fields[0].quoted;
            if !blank {
                return Ok(Some(RawRecord {
                    line: start_line,
                    fields,
                }));
            }
        }
    }

    /// Reads up to the closing quote; `""` is a quote.
    fn read_quoted(&mut self, out: &mut String, start_line: u64) -> Result<(), ParseError> {
        let Some(quote) = self.quote else {
            return Ok(());
        };
        loop {
            let Some(c) = self.next_char()? else {
                return Err(ParseError::Invalid {
                    line: start_line,
                    problem: "a quoted field is never closed".to_owned(),
                });
            };
            if c == quote {
                if self.peek()? == Some(quote) {
                    self.next_char()?;
                    out.push(quote);
                } else {
                    return Ok(());
                }
            } else {
                out.push(c);
                if out.len() > MAX_FIELD_CHARS {
                    return Err(ParseError::Invalid {
                        line: start_line,
                        problem: "a field is larger than 16 MiB: a quote may never close"
                            .to_owned(),
                    });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::model::ImportEncoding;
    use crate::import::text::TextCounters;

    fn reader(text: &str, delimiter: char, quote: Option<char>) -> CsvReader<&[u8]> {
        CsvReader::new(
            TextReader::new(
                text.as_bytes(),
                ImportEncoding::Utf8,
                TextCounters::default(),
            ),
            delimiter,
            quote,
        )
    }

    fn all(text: &str) -> Vec<Vec<(String, bool)>> {
        let mut csv = reader(text, ',', Some('"'));
        let mut out = Vec::new();
        while let Some(record) = csv.next_record().expect("parses") {
            out.push(
                record
                    .fields
                    .into_iter()
                    .map(|f| (f.text, f.quoted))
                    .collect(),
            );
        }
        out
    }

    fn plain(rows: &[&[&str]]) -> Vec<Vec<(String, bool)>> {
        rows.iter()
            .map(|r| r.iter().map(|f| ((*f).to_owned(), false)).collect())
            .collect()
    }

    #[test]
    fn reads_plain_rows_with_any_line_ending() {
        assert_eq!(
            all("a,b\n1,2\r\n3,4\r5,6"),
            plain(&[&["a", "b"], &["1", "2"], &["3", "4"], &["5", "6"]])
        );
        assert_eq!(all(""), plain(&[]));
        assert_eq!(all("a,,c\n"), plain(&[&["a", "", "c"]]));
        assert_eq!(all("a,b,\n"), plain(&[&["a", "b", ""]]));
    }

    #[test]
    fn quoted_fields_keep_delimiters_quotes_and_line_breaks() {
        let rows = all("id,note\n1,\"a, \"\"b\"\"\nsecond line\"\n2,\"\"\n");
        assert_eq!(rows[1][1], ("a, \"b\"\nsecond line".to_owned(), true));
        assert_eq!(
            rows[2],
            vec![("2".to_owned(), false), (String::new(), true)]
        );
    }

    #[test]
    fn skips_blank_lines_and_reports_start_lines() {
        let mut csv = reader("a\n\n\"x\ny\"\nb\n", ',', Some('"'));
        let lines: Vec<u64> = std::iter::from_fn(|| csv.next_record().expect("parses"))
            .map(|r| r.line)
            .collect();
        assert_eq!(lines, vec![1, 3, 5]);
    }

    #[test]
    fn a_quote_inside_an_unquoted_field_is_a_character() {
        assert_eq!(all("5\" pipe,x\n"), plain(&[&["5\" pipe", "x"]]));
    }

    #[test]
    fn an_unterminated_quote_is_an_error_with_its_line() {
        let mut csv = reader("a,b\n1,\"oops\n2,3\n", ',', Some('"'));
        assert!(csv.next_record().expect("first row").is_some());
        match csv.next_record() {
            Err(ParseError::Invalid { line, .. }) => assert_eq!(line, 2),
            other => panic!("expected an error, got {other:?}"),
        }
    }

    #[test]
    fn other_delimiters_and_no_quote() {
        let mut csv = reader("a;\"b;c\"\n", ';', None);
        let record = csv.next_record().expect("parses").expect("a record");
        let texts: Vec<_> = record.fields.iter().map(|f| f.text.as_str()).collect();
        assert_eq!(texts, ["a", "\"b", "c\""]);
        let mut csv = reader("a\tb\n", '\t', Some('"'));
        assert_eq!(
            csv.next_record()
                .expect("parses")
                .expect("a record")
                .fields
                .len(),
            2
        );
    }

    #[test]
    fn skips_leading_lines() {
        let mut csv = reader("preamble\nmore\na,b\n", ',', Some('"'));
        csv.skip_lines(2).expect("skips");
        assert_eq!(
            csv.next_record().expect("parses").expect("a record").line,
            3
        );
    }
}

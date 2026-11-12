//! Decoding of import files: a byte stream in UTF-8, UTF-16 or Windows-1252, read as
//! characters without ever holding the file in memory.

use std::io::Read;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use super::model::ImportEncoding;

const CHUNK_BYTES: usize = 64 * 1024;

/// Windows-1252 characters of 0x80 to 0x9F (the undefined ones map to themselves).
const CP1252_HIGH: [char; 32] = [
    '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}',
    '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
];

/// The encoding a byte order mark announces, and the bytes it takes.
pub fn sniff_bom(head: &[u8]) -> Option<(ImportEncoding, usize)> {
    match head {
        [0xef, 0xbb, 0xbf, ..] => Some((ImportEncoding::Utf8, 3)),
        [0xff, 0xfe, ..] => Some((ImportEncoding::Utf16le, 2)),
        [0xfe, 0xff, ..] => Some((ImportEncoding::Utf16be, 2)),
        _ => None,
    }
}

/// The encoding of a file start: its byte order mark, else UTF-16 when every other byte is
/// zero (Windows tools write UTF-16 without one), else UTF-8.
pub fn sniff_encoding(head: &[u8]) -> ImportEncoding {
    if let Some((encoding, _)) = sniff_bom(head) {
        return encoding;
    }
    let sample = &head[..head.len().min(4096)];
    if sample.len() >= 4 {
        let (even, odd) = sample.chunks_exact(2).fold((0, 0), |(e, o), pair| {
            (e + usize::from(pair[0] == 0), o + usize::from(pair[1] == 0))
        });
        let pairs = sample.len() / 2;
        if odd * 10 >= pairs * 9 && even == 0 {
            return ImportEncoding::Utf16le;
        }
        if even * 10 >= pairs * 9 && odd == 0 {
            return ImportEncoding::Utf16be;
        }
    }
    ImportEncoding::Utf8
}

/// Counters a reader shares with the code that reports progress.
#[derive(Debug, Clone, Default)]
pub struct TextCounters {
    /// Bytes read from the file so far.
    pub bytes: Arc<AtomicU64>,
    /// Byte sequences replaced by `U+FFFD`.
    pub invalid: Arc<AtomicU64>,
}

/// Characters of a byte stream, decoded chunk by chunk. A leading byte order mark is
/// dropped; invalid sequences become `U+FFFD` and are counted.
pub struct TextReader<R: Read> {
    inner: R,
    encoding: ImportEncoding,
    /// Bytes read but not decoded yet (an incomplete sequence at a chunk end).
    carry: Vec<u8>,
    buf: String,
    pos: usize,
    eof: bool,
    at_start: bool,
    counters: TextCounters,
}

impl<R: Read> TextReader<R> {
    pub fn new(inner: R, encoding: ImportEncoding, counters: TextCounters) -> Self {
        Self {
            inner,
            encoding,
            carry: Vec::new(),
            buf: String::new(),
            pos: 0,
            eof: false,
            at_start: true,
            counters,
        }
    }

    fn invalid(&self) {
        self.counters.invalid.fetch_add(1, Ordering::Relaxed);
    }

    /// Decodes the next chunk into `buf`; `false` at the end of the stream.
    fn refill(&mut self) -> std::io::Result<bool> {
        self.buf.clear();
        self.pos = 0;
        while self.buf.is_empty() {
            if self.eof {
                return Ok(false);
            }
            let mut chunk = vec![0_u8; CHUNK_BYTES];
            let read = loop {
                match self.inner.read(&mut chunk) {
                    Ok(n) => break n,
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(e) => return Err(e),
                }
            };
            self.counters
                .bytes
                .fetch_add(read as u64, Ordering::Relaxed);
            if read == 0 {
                self.eof = true;
            }
            chunk.truncate(read);
            let mut bytes = std::mem::take(&mut self.carry);
            bytes.extend_from_slice(&chunk);
            self.decode(&bytes);
            if self.at_start && !self.buf.is_empty() {
                self.at_start = false;
                if self.buf.starts_with('\u{feff}') {
                    self.buf.remove(0);
                }
            }
        }
        Ok(true)
    }

    fn decode(&mut self, bytes: &[u8]) {
        match self.encoding {
            ImportEncoding::Utf8 => self.decode_utf8(bytes),
            ImportEncoding::Latin1 => {
                self.buf.extend(bytes.iter().map(|&b| match b {
                    0x80..=0x9f => CP1252_HIGH[usize::from(b - 0x80)],
                    other => char::from(other),
                }));
            }
            ImportEncoding::Utf16le | ImportEncoding::Utf16be => self.decode_utf16(bytes),
        }
    }

    fn decode_utf8(&mut self, mut bytes: &[u8]) {
        loop {
            match std::str::from_utf8(bytes) {
                Ok(valid) => {
                    self.buf.push_str(valid);
                    return;
                }
                Err(error) => {
                    let (valid, rest) = bytes.split_at(error.valid_up_to());
                    // Valid up to here by the check just made.
                    self.buf.push_str(&String::from_utf8_lossy(valid));
                    match error.error_len() {
                        Some(skip) => {
                            self.buf.push('\u{fffd}');
                            self.invalid();
                            bytes = &rest[skip..];
                        }
                        None if self.eof => {
                            self.buf.push('\u{fffd}');
                            self.invalid();
                            return;
                        }
                        None => {
                            self.carry = rest.to_vec();
                            return;
                        }
                    }
                }
            }
        }
    }

    fn decode_utf16(&mut self, bytes: &[u8]) {
        let big = self.encoding == ImportEncoding::Utf16be;
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| {
                if big {
                    u16::from_be_bytes([pair[0], pair[1]])
                } else {
                    u16::from_le_bytes([pair[0], pair[1]])
                }
            })
            .collect();
        let odd = bytes.len() % 2 == 1;
        let mut keep_from = units.len();
        // A high surrogate at the end waits for its low half.
        if !self.eof
            && let Some(last) = units.last()
            && (0xd800..0xdc00).contains(last)
        {
            keep_from -= 1;
        }
        for decoded in char::decode_utf16(units[..keep_from].iter().copied()) {
            match decoded {
                Ok(c) => self.buf.push(c),
                Err(_) => {
                    self.buf.push('\u{fffd}');
                    self.invalid();
                }
            }
        }
        let mut carry = Vec::new();
        for unit in &units[keep_from..] {
            carry.extend_from_slice(&if big {
                unit.to_be_bytes()
            } else {
                unit.to_le_bytes()
            });
        }
        if odd {
            if self.eof {
                self.buf.push('\u{fffd}');
                self.invalid();
            } else {
                carry.push(bytes[bytes.len() - 1]);
            }
        }
        if self.eof && !carry.is_empty() {
            self.buf.push('\u{fffd}');
            self.invalid();
            carry.clear();
        }
        self.carry = carry;
    }

    pub fn peek(&mut self) -> std::io::Result<Option<char>> {
        if self.pos >= self.buf.len() && !self.refill()? {
            return Ok(None);
        }
        Ok(self.buf[self.pos..].chars().next())
    }

    pub fn next_char(&mut self) -> std::io::Result<Option<char>> {
        let next = self.peek()?;
        if let Some(c) = next {
            self.pos += c.len_utf8();
        }
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_all(bytes: &[u8], encoding: ImportEncoding) -> (String, u64) {
        let counters = TextCounters::default();
        let mut reader = TextReader::new(bytes, encoding, counters.clone());
        let mut out = String::new();
        while let Some(c) = reader.next_char().expect("reads") {
            out.push(c);
        }
        (out, counters.invalid.load(Ordering::Relaxed))
    }

    #[test]
    fn utf8_drops_the_bom_and_counts_invalid_bytes() {
        let (text, invalid) = read_all(b"\xef\xbb\xbfcaf\xc3\xa9", ImportEncoding::Utf8);
        assert_eq!(text, "café");
        assert_eq!(invalid, 0);
        let (text, invalid) = read_all(b"caf\xe9 au lait", ImportEncoding::Utf8);
        assert_eq!(text, "caf\u{fffd} au lait");
        assert_eq!(invalid, 1);
        let (text, invalid) = read_all(b"cut\xc3", ImportEncoding::Utf8);
        assert_eq!(text, "cut\u{fffd}");
        assert_eq!(invalid, 1);
    }

    #[test]
    fn multibyte_sequences_survive_chunk_boundaries() {
        let mut bytes = vec![b'a'; CHUNK_BYTES - 1];
        bytes.extend("é€😀".as_bytes());
        let (text, invalid) = read_all(&bytes, ImportEncoding::Utf8);
        assert!(text.ends_with("é€😀"));
        assert_eq!(text.chars().count(), CHUNK_BYTES - 1 + 3);
        assert_eq!(invalid, 0);
    }

    #[test]
    fn latin1_maps_windows_1252() {
        let (text, invalid) = read_all(b"caf\xe9 \x80 \x92", ImportEncoding::Latin1);
        assert_eq!(text, "café € ’");
        assert_eq!(invalid, 0);
    }

    #[test]
    fn utf16_both_orders_with_surrogates() {
        let text = "a;é\u{1f600}\n";
        let mut le = vec![0xff, 0xfe];
        let mut be = vec![0xfe, 0xff];
        for unit in text.encode_utf16() {
            le.extend_from_slice(&unit.to_le_bytes());
            be.extend_from_slice(&unit.to_be_bytes());
        }
        assert_eq!(read_all(&le, ImportEncoding::Utf16le), (text.to_owned(), 0));
        assert_eq!(read_all(&be, ImportEncoding::Utf16be), (text.to_owned(), 0));
        // A lone surrogate is invalid.
        let (decoded, invalid) = read_all(&[0x00, 0xd8, b'a', 0], ImportEncoding::Utf16le);
        assert_eq!(decoded, "\u{fffd}a");
        assert_eq!(invalid, 1);
    }

    #[test]
    fn sniffs_the_encoding() {
        assert_eq!(sniff_encoding(b"\xef\xbb\xbfa,b"), ImportEncoding::Utf8);
        assert_eq!(
            sniff_encoding(&[0xff, 0xfe, b'a', 0]),
            ImportEncoding::Utf16le
        );
        assert_eq!(
            sniff_encoding(&[0xfe, 0xff, 0, b'a']),
            ImportEncoding::Utf16be
        );
        assert_eq!(
            sniff_encoding(&[b'a', 0, b',', 0, b'b', 0, b'\n', 0]),
            ImportEncoding::Utf16le
        );
        assert_eq!(
            sniff_encoding(&[0, b'a', 0, b',', 0, b'b', 0, b'\n']),
            ImportEncoding::Utf16be
        );
        assert_eq!(sniff_encoding(b"id,name\n1,a\n"), ImportEncoding::Utf8);
    }
}

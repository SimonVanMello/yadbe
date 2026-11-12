import { sqlEntry, type SqlEngine } from '../sqlEngines';
import type {
  ColumnMeta,
  CsvOptions,
  Engine,
  ExportFormat,
  JsonOptions,
  MarkdownOptions,
  SqlOptions,
  Value,
} from '../bindings';

/**
 * The mock's stand-in for the backend's row encoders (`export/csv.rs`, `export/json.rs`): the
 * same rules, so the dialog's preview and the files the mock writes look like the real ones.
 */
export interface RowEncoder {
  begin(columns: ColumnMeta[]): string;
  row(row: Value[]): string;
  end(): string;
}

const DELIMITERS = { comma: ',', semicolon: ';', tab: '\t' } as const;

function base64(hex: string): string {
  const bytes = hex.match(/../g)?.map((pair) => parseInt(pair, 16)) ?? [];
  return btoa(String.fromCharCode(...bytes));
}

function binary(hex: string, encoding: 'hex' | 'base64'): string {
  return encoding === 'hex' ? hex : base64(hex);
}

function plainText(value: Value, encoding: 'hex' | 'base64'): string {
  switch (value.kind) {
    case 'null':
    case 'missing':
      return '';
    case 'bool':
      return value.value ? 'true' : 'false';
    case 'array':
      return jsonValue(value, 'auto', encoding);
    case 'bytes':
      return binary(value.value, encoding);
    default:
      return value.value;
  }
}

function csvEncoder(options: CsvOptions): RowEncoder {
  const delimiter = DELIMITERS[options.delimiter];
  const eol = options.lineEnding === 'crlf' ? '\r\n' : '\n';
  const quote = (text: string, force: boolean) =>
    force ||
    (text === '' && options.nullText === '') ||
    text.includes(delimiter) ||
    /["\n\r]/.test(text)
      ? `"${text.replaceAll('"', '""')}"`
      : text;
  return {
    begin(columns) {
      const bom = options.bom ? '\ufeff' : '';
      if (!options.header) return bom;
      const force = options.quote !== 'minimal';
      return bom + columns.map((c) => quote(c.name, force)).join(delimiter) + eol;
    },
    row(row) {
      return (
        row
          .map((value) => {
            if (value.kind === 'null') return options.nullText;
            const numeric =
              value.kind === 'int' ||
              value.kind === 'decimal' ||
              value.kind === 'float' ||
              value.kind === 'bool';
            const force = options.quote === 'all' || (options.quote === 'nonNumeric' && !numeric);
            return quote(plainText(value, options.binary), force);
          })
          .join(delimiter) + eol
      );
    },
    end: () => '',
  };
}

const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

function significantDigits(text: string): number {
  const mantissa = text.split(/[eE]/)[0] ?? text;
  return mantissa.replace(/\D/g, '').replace(/^0+|0+$/g, '').length;
}

function jsonValue(value: Value, numbers: 'auto' | 'strings', encoding: 'hex' | 'base64'): string {
  const auto = numbers === 'auto';
  switch (value.kind) {
    case 'null':
    case 'missing':
      return 'null';
    case 'bool':
      return value.value ? 'true' : 'false';
    case 'int':
      return auto &&
        NUMBER.test(value.value) &&
        BigInt(value.value) <= 2n ** 53n &&
        BigInt(value.value) >= -(2n ** 53n)
        ? value.value
        : JSON.stringify(value.value);
    case 'decimal':
      return auto && NUMBER.test(value.value) && significantDigits(value.value) <= 15
        ? value.value
        : JSON.stringify(value.value);
    case 'float':
      return auto && NUMBER.test(value.value) ? value.value : JSON.stringify(value.value);
    case 'json':
      try {
        JSON.parse(value.value);
        return value.value.replace(
          /("(?:\\.|[^"\\])*")|\s+/g,
          (_, text: string | undefined) => text ?? '',
        );
      } catch {
        return JSON.stringify(value.value);
      }
    case 'bytes':
      return JSON.stringify(binary(value.value, encoding));
    case 'array':
      return `[${value.value.map((item) => jsonValue(item, numbers, encoding)).join(',')}]`;
    default:
      return JSON.stringify(value.value);
  }
}

function jsonEncoder(options: JsonOptions): RowEncoder {
  let keys: string[] = [];
  let rows = 0;
  const array = options.layout === 'array';
  return {
    begin(columns) {
      keys = columns.map((c) => JSON.stringify(c.name));
      return array ? '[' : '';
    },
    row(row) {
      const body = `{${row
        .map(
          (value, i) => `${keys[i] ?? '""'}:${jsonValue(value, options.numbers, options.binary)}`,
        )
        .join(',')}}`;
      const line = array ? `${rows === 0 ? '\n' : ',\n'}${body}` : `${body}\n`;
      rows += 1;
      return line;
    },
    end: () => (array ? (rows === 0 ? ']\n' : '\n]\n') : ''),
  };
}

const QUOTES: Record<SqlEngine, readonly [string, string]> = {
  postgres: ['"', '"'],
  sqlite: ['"', '"'],
  mysql: ['`', '`'],
  mssql: ['[', ']'],
};

function quoteIdentifier(engine: Engine, name: string): string {
  const [open, close] = sqlEntry(QUOTES, engine);
  return `${open}${name.replaceAll(close, close + close)}${close}`;
}

/** A value as a SQL literal of an engine (`edit_dialect.rs`, `literal`). */
function sqlLiteral(engine: Engine, value: Value): string {
  const quoted = (text: string) => `'${text.replaceAll("'", "''")}'`;
  const number = (text: string) => (/^-?\d[\d.eE+-]*$/.test(text) ? text : quoted(text));
  switch (value.kind) {
    case 'null':
    case 'missing':
      return 'NULL';
    case 'bool':
      return engine === 'postgres' ? (value.value ? 'TRUE' : 'FALSE') : value.value ? '1' : '0';
    case 'int':
    case 'decimal':
    case 'float':
      return number(value.value);
    case 'bytes':
      if (engine === 'mssql') return `0x${value.value.toUpperCase()}`;
      return engine === 'postgres'
        ? quoted(`\\x${value.value}`)
        : `X'${value.value.toUpperCase()}'`;
    case 'array':
      return quoted(plainText(value, 'hex'));
    default: {
      const text = quoted(value.value);
      if (engine === 'mssql') return `N${text}`;
      return engine === 'mysql' ? text.replaceAll('\\', '\\\\') : text;
    }
  }
}

function sqlEncoder(options: SqlOptions): RowEncoder {
  const eol = options.lineEnding === 'crlf' ? '\r\n' : '\n';
  const per = Math.min(500, Math.max(1, options.rowsPerStatement));
  const table = options.table.trim() || 'table';
  const target =
    options.schema.trim() === ''
      ? quoteIdentifier(options.engine, table)
      : `${quoteIdentifier(options.engine, options.schema.trim())}.${quoteIdentifier(options.engine, table)}`;
  let head = '';
  let inStatement = 0;
  return {
    begin(columns) {
      head = `INSERT INTO ${target} (${columns
        .map((c) => quoteIdentifier(options.engine, c.name))
        .join(', ')}) VALUES`;
      return '';
    },
    row(row) {
      let text = inStatement === 0 ? head : ',';
      text += `${eol}  (${row.map((value) => sqlLiteral(options.engine, value)).join(', ')})`;
      inStatement += 1;
      if (inStatement >= per) {
        text += `;${eol}`;
        inStatement = 0;
      }
      return text;
    },
    end() {
      if (inStatement === 0) return '';
      inStatement = 0;
      return `;${eol}`;
    },
  };
}

function markdownEncoder(options: MarkdownOptions): RowEncoder {
  const eol = options.lineEnding === 'crlf' ? '\r\n' : '\n';
  const escape = (text: string) =>
    text
      .replaceAll('\\', '\\\\')
      .replaceAll('|', '\\|')
      .replace(/\r\n|\r|\n/g, '<br>');
  return {
    begin(columns) {
      const numeric = (c: ColumnMeta) =>
        options.alignNumbers && (c.kind === 'int' || c.kind === 'decimal' || c.kind === 'float');
      return (
        `|${columns.map((c) => ` ${escape(c.name)} |`).join('')}${eol}` +
        `|${columns.map((c) => (numeric(c) ? ' ---: |' : ' --- |')).join('')}${eol}`
      );
    },
    row(row) {
      return `|${row
        .map(
          (value) =>
            ` ${escape(value.kind === 'null' ? options.nullText : plainText(value, options.binary))} |`,
        )
        .join('')}${eol}`;
    },
    end: () => '',
  };
}

export function mockEncoder(format: ExportFormat): RowEncoder {
  switch (format.format) {
    case 'csv':
      return csvEncoder(format.options);
    case 'json':
      return jsonEncoder(format.options);
    case 'jsonLines':
      // The mock has no whole documents: rows are written as objects, as the backend does for
      // a source without documents.
      return jsonEncoder({
        layout: 'ndjson',
        numbers: format.options.numbers,
        binary: format.options.binary,
      });
    case 'sql':
      return sqlEncoder(format.options);
    case 'markdown':
      return markdownEncoder(format.options);
    case 'excel':
      // The workbook is binary: the mock writes the rows as tab-separated text instead.
      return csvEncoder({
        delimiter: 'tab',
        quote: 'minimal',
        header: true,
        nullText: '',
        lineEnding: 'lf',
        bom: false,
        binary: format.options.binary,
      });
  }
}

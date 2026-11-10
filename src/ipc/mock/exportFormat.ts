import type { ColumnMeta, CsvOptions, ExportFormat, JsonOptions, Value } from '../bindings';

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

export function mockEncoder(format: ExportFormat): RowEncoder {
  return format.format === 'csv' ? csvEncoder(format.options) : jsonEncoder(format.options);
}

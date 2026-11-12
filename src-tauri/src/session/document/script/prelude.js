// The mongosh API of yadbe's document query tab (M4-3), evaluated once per run before the
// user's script. Everything that reaches the server goes through `native` (the command gate,
// in Rust): this file builds typed requests from the shell's methods, carries values as
// canonical Extended JSON both ways and prints values the way mongosh does. The script runs
// synchronously: a native call blocks until the server answers, so `db.c.find().toArray()`
// is an array, as in mongosh, without rewriting the user's code; `await` on it is harmless.
//
// Called with the native bridge; returns the hooks Rust uses (shell commands, the result of
// the last expression, the current database). Nothing here is a security boundary: a script
// can do exactly what the gate lets it do, nothing else.
(function (native, initialDatabase) {
  'use strict';

  const G = globalThis;
  const INSPECT = Symbol('yadbe.inspect');
  const TO_EJSON = Symbol('yadbe.ejson');
  const RESULT = Symbol('yadbe.result');
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  // --- Errors ---------------------------------------------------------------------------

  function makeError(name, message, extra) {
    const error = new Error(message);
    Object.defineProperty(error, 'name', { value: name, configurable: true, writable: true });
    if (extra) Object.assign(error, extra);
    return error;
  }

  /** A typed error of the bridge: Rust keeps the full error under `id`. */
  function bridgeError(info) {
    const error = makeError(info.name, info.message);
    if (info.code !== undefined) error.code = info.code;
    if (info.codeName !== undefined) error.codeName = info.codeName;
    Object.defineProperty(error, '__yadbe', { value: info.id });
    return error;
  }

  function invalid(message) {
    return makeError('MongoshInvalidInputError', message);
  }

  /** A method yadbe does not implement: thrown by name, never a silent no-op. */
  function unsupported(method, instead) {
    const id = native.unsupported(method, instead || '');
    const error = makeError('MongoshUnimplementedError', native.message(id));
    Object.defineProperty(error, '__yadbe', { value: id });
    return error;
  }

  function call(fn, request) {
    const reply = JSON.parse(fn(JSON.stringify(request)));
    if (reply.error) throw bridgeError(reply.error);
    return reply;
  }

  const op = (request) => call(native.op, request);

  // --- BSON values ----------------------------------------------------------------------

  /** A constructor that also works without `new`, as mongosh's helpers do. */
  function bsonType(name, init, methods) {
    const T = function (...args) {
      if (!new.target) return new T(...args);
      init.apply(this, args);
    };
    Object.defineProperty(T, 'name', { value: name });
    Object.defineProperty(T.prototype, '_bsontype', { value: name });
    const descriptors = Object.getOwnPropertyDescriptors(methods);
    for (const descriptor of Object.values(descriptors)) descriptor.enumerable = false;
    for (const key of Object.getOwnPropertySymbols(descriptors))
      descriptors[key].enumerable = false;
    Object.defineProperties(T.prototype, descriptors);
    return T;
  }

  const quote = (text) =>
    "'" +
    String(text)
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t') +
    "'";

  // ObjectId: 4 bytes of seconds, 5 random bytes per run, a 3-byte counter.
  const hex2 = (n) => n.toString(16).padStart(2, '0');
  let oidRandom = '';
  for (let i = 0; i < 5; i += 1) oidRandom += hex2(Math.floor(Math.random() * 256));
  let oidCounter = Math.floor(Math.random() * 0xffffff);
  const OID = /^[0-9a-fA-F]{24}$/;

  const ObjectId = bsonType(
    'ObjectId',
    function (id) {
      if (id === undefined || id === null) {
        oidCounter = (oidCounter + 1) % 0x1000000;
        const seconds = Math.floor(Date.now() / 1000);
        this.__id =
          seconds.toString(16).padStart(8, '0') +
          oidRandom +
          oidCounter.toString(16).padStart(6, '0');
      } else if (id instanceof ObjectId) {
        this.__id = id.__id;
      } else if (typeof id === 'string' && OID.test(id)) {
        this.__id = id.toLowerCase();
      } else if (typeof id === 'object' && typeof id.$oid === 'string' && OID.test(id.$oid)) {
        this.__id = id.$oid.toLowerCase();
      } else if (typeof id === 'number' && Number.isInteger(id)) {
        this.__id = (id >>> 0).toString(16).padStart(8, '0') + '0000000000000000';
      } else {
        throw makeError(
          'BSONError',
          'input must be a 24 character hex string, 12 byte Uint8Array, or an integer',
        );
      }
    },
    {
      toHexString() {
        return this.__id;
      },
      toString() {
        return this.__id;
      },
      toJSON() {
        return this.__id;
      },
      get str() {
        return this.__id;
      },
      equals(other) {
        if (other instanceof ObjectId) return other.__id === this.__id;
        return typeof other === 'string' && other.toLowerCase() === this.__id;
      },
      getTimestamp() {
        return new Date(parseInt(this.__id.slice(0, 8), 16) * 1000);
      },
      [TO_EJSON]() {
        return { $oid: this.__id };
      },
      [INSPECT]() {
        return `ObjectId(${quote(this.__id)})`;
      },
    },
  );
  ObjectId.isValid = (id) =>
    id instanceof ObjectId ||
    (typeof id === 'string' && OID.test(id)) ||
    (typeof id === 'number' && Number.isInteger(id));
  ObjectId.createFromHexString = (hex) => new ObjectId(hex);
  ObjectId.createFromTime = (seconds) =>
    new ObjectId((seconds >>> 0).toString(16).padStart(8, '0') + '0000000000000000');

  const INT64_MIN = -(2n ** 63n);
  const INT64_MAX = 2n ** 63n - 1n;

  function toBigInt(value, what) {
    let big;
    if (typeof value === 'bigint') big = value;
    else if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw invalid(`${what} needs a finite number, got ${value}`);
      big = BigInt(Math.trunc(value));
    } else if (typeof value === 'string' && /^\s*[-+]?\d+\s*$/.test(value))
      big = BigInt(value.trim());
    else if (value instanceof Long) big = value.__v;
    else if (value instanceof Int32 || value instanceof Double)
      big = BigInt(Math.trunc(value.valueOf()));
    else throw invalid(`${what} needs an integer, got ${inspect(value)}`);
    if (big < INT64_MIN || big > INT64_MAX)
      throw invalid(`${what}: ${big} is out of the 64-bit range`);
    return big;
  }

  const Long = bsonType(
    'Long',
    function (low, high) {
      if (high !== undefined && typeof low === 'number') {
        const big = (BigInt(high | 0) << 32n) | BigInt(low >>> 0);
        this.__v = BigInt.asIntN(64, big);
      } else {
        this.__v = low === undefined ? 0n : toBigInt(low, 'Long');
      }
    },
    {
      toString(radix) {
        return this.__v.toString(radix);
      },
      toNumber() {
        return Number(this.__v);
      },
      toBigInt() {
        return this.__v;
      },
      valueOf() {
        return Number(this.__v);
      },
      toJSON() {
        return this.__v.toString();
      },
      equals(other) {
        try {
          return toBigInt(other, 'Long') === this.__v;
        } catch {
          return false;
        }
      },
      add(other) {
        return new Long(BigInt.asIntN(64, this.__v + toBigInt(other, 'Long')));
      },
      subtract(other) {
        return new Long(BigInt.asIntN(64, this.__v - toBigInt(other, 'Long')));
      },
      multiply(other) {
        return new Long(BigInt.asIntN(64, this.__v * toBigInt(other, 'Long')));
      },
      compare(other) {
        const b = toBigInt(other, 'Long');
        return this.__v < b ? -1 : this.__v > b ? 1 : 0;
      },
      [TO_EJSON](relaxed) {
        if (relaxed) {
          const n = Number(this.__v);
          if (Number.isSafeInteger(n)) return n;
        }
        return { $numberLong: this.__v.toString() };
      },
      [INSPECT]() {
        return `Long(${quote(this.__v.toString())})`;
      },
    },
  );
  Long.fromString = (text, _unsigned, radix) =>
    new Long(radix && radix !== 10 ? BigInt.asIntN(64, BigInt(parseInt(text, radix))) : text);
  Long.fromNumber = (n) => new Long(n);
  Long.fromBigInt = (n) => new Long(n);
  Long.fromInt = (n) => new Long(n);
  Long.ZERO = new Long(0);
  Long.ONE = new Long(1);
  Long.MAX_VALUE = new Long(INT64_MAX);
  Long.MIN_VALUE = new Long(INT64_MIN);

  function NumberLong(value) {
    return new Long(value === undefined ? 0 : value);
  }

  const Int32 = bsonType(
    'Int32',
    function (value) {
      const n = Number(value instanceof Long ? value.toNumber() : value);
      if (!Number.isFinite(n)) throw invalid(`Int32 needs a number, got ${inspect(value)}`);
      this.__v = n | 0;
    },
    {
      valueOf() {
        return this.__v;
      },
      toString(radix) {
        return this.__v.toString(radix);
      },
      toJSON() {
        return this.__v;
      },
      [TO_EJSON](relaxed) {
        return relaxed ? this.__v : { $numberInt: String(this.__v) };
      },
      [INSPECT]() {
        return `Int32(${this.__v})`;
      },
    },
  );
  const NumberInt = (value) => new Int32(value === undefined ? 0 : value);

  function doubleText(n) {
    if (Number.isNaN(n)) return 'NaN';
    if (n === Infinity) return 'Infinity';
    if (n === -Infinity) return '-Infinity';
    if (Object.is(n, -0)) return '-0.0';
    const text = String(n);
    return Number.isInteger(n) && !/[e.]/.test(text) ? `${text}.0` : text;
  }

  const Double = bsonType(
    'Double',
    function (value) {
      this.__v = Number(value instanceof Long ? value.toNumber() : value);
    },
    {
      valueOf() {
        return this.__v;
      },
      toString(radix) {
        return this.__v.toString(radix);
      },
      toJSON() {
        return this.__v;
      },
      [TO_EJSON](relaxed) {
        if (relaxed && Number.isFinite(this.__v)) return this.__v;
        return { $numberDouble: doubleText(this.__v) };
      },
      [INSPECT]() {
        return `Double(${Object.is(this.__v, -0) ? '-0' : String(this.__v)})`;
      },
    },
  );

  const DECIMAL = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$|^[-+]?(Infinity|Inf|NaN)$/i;
  const Decimal128 = bsonType(
    'Decimal128',
    function (value) {
      const text = typeof value === 'number' ? String(value) : String(value ?? '0');
      if (!DECIMAL.test(text.trim())) throw invalid(`${text} is not a valid Decimal128 string`);
      this.__v = text.trim();
    },
    {
      toString() {
        return this.__v;
      },
      toJSON() {
        return { $numberDecimal: this.__v };
      },
      [TO_EJSON]() {
        return { $numberDecimal: this.__v };
      },
      [INSPECT]() {
        return `Decimal128(${quote(this.__v)})`;
      },
    },
  );
  Decimal128.fromString = (text) => new Decimal128(text);
  const NumberDecimal = (value) => new Decimal128(value === undefined ? '0' : value);

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function bytesToBase64(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
      out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
      out += i + 2 < bytes.length ? B64[n & 63] : '=';
    }
    return out;
  }
  function base64ToBytes(text) {
    const out = [];
    let acc = 0;
    let bits = 0;
    for (const c of String(text).replace(/[\s=]/g, '')) {
      const v = B64.indexOf(c);
      if (v < 0) throw invalid(`${text} is not valid base64`);
      acc = (acc << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push((acc >> bits) & 0xff);
      }
    }
    return Uint8Array.from(out);
  }
  const bytesToHex = (bytes) => Array.from(bytes, hex2).join('');
  function hexToBytes(text) {
    const clean = String(text);
    if (!/^([0-9a-fA-F]{2})*$/.test(clean)) throw invalid(`${text} is not valid hexadecimal`);
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  const Binary = bsonType(
    'Binary',
    function (data, subtype) {
      if (data instanceof Uint8Array) this.__b = Uint8Array.from(data);
      else if (data instanceof ArrayBuffer) this.__b = new Uint8Array(data.slice(0));
      else if (Array.isArray(data)) this.__b = Uint8Array.from(data);
      else if (typeof data === 'string') this.__b = base64ToBytes(data);
      else if (data === undefined) this.__b = new Uint8Array(0);
      else throw invalid(`Binary needs bytes or base64 text, got ${inspect(data)}`);
      this.sub_type = subtype === undefined ? 0 : Number(subtype) & 0xff;
    },
    {
      base64() {
        return bytesToBase64(this.__b);
      },
      hex() {
        return bytesToHex(this.__b);
      },
      toString(format) {
        return format === 'hex' ? this.hex() : format === 'base64' ? this.base64() : this.base64();
      },
      length() {
        return this.__b.length;
      },
      value() {
        return Uint8Array.from(this.__b);
      },
      get buffer() {
        return Uint8Array.from(this.__b);
      },
      toUUID() {
        return this;
      },
      toJSON() {
        return this.base64();
      },
      [TO_EJSON]() {
        return { $binary: { base64: this.base64(), subType: hex2(this.sub_type) } };
      },
      [INSPECT]() {
        if (this.sub_type === 4 && this.__b.length === 16) {
          const h = this.hex();
          return `UUID(${quote(`${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`)})`;
        }
        if (this.sub_type === 5) return `MD5(${quote(this.hex())})`;
        return `Binary.createFromBase64(${quote(this.base64())}, ${this.sub_type})`;
      },
    },
  );
  Binary.createFromBase64 = (text, subtype) => new Binary(text, subtype);
  Binary.createFromHexString = (text, subtype) => new Binary(hexToBytes(text), subtype);
  Binary.SUBTYPE_DEFAULT = 0;
  Binary.SUBTYPE_UUID = 4;
  Binary.SUBTYPE_MD5 = 5;
  Binary.SUBTYPE_USER_DEFINED = 128;

  const BinData = (subtype, base64) => new Binary(base64, subtype);
  const HexData = (subtype, hex) => new Binary(hexToBytes(hex), subtype);
  const MD5 = (hex) => new Binary(hexToBytes(hex), 5);
  function UUID(text) {
    if (text === undefined) {
      const bytes = new Uint8Array(16);
      for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      return new Binary(bytes, 4);
    }
    const digits = String(text).replace(/-/g, '');
    if (!/^[0-9a-fA-F]{32}$/.test(digits)) throw invalid(`${text} is not a valid UUID`);
    return new Binary(hexToBytes(digits), 4);
  }

  const Timestamp = bsonType(
    'Timestamp',
    function (t, i) {
      if (t !== null && typeof t === 'object' && !(t instanceof Long)) {
        this.t = Number(t.t ?? 0) >>> 0;
        this.i = Number(t.i ?? 0) >>> 0;
      } else if (t instanceof Long) {
        this.t = Number(t.__v >> 32n) >>> 0;
        this.i = Number(t.__v & 0xffffffffn) >>> 0;
      } else {
        this.t = Number(t ?? 0) >>> 0;
        this.i = Number(i ?? 0) >>> 0;
      }
    },
    {
      getTime() {
        return this.t;
      },
      getInc() {
        return this.i;
      },
      getHighBits() {
        return this.t;
      },
      getLowBits() {
        return this.i;
      },
      toJSON() {
        return { $timestamp: { t: this.t, i: this.i } };
      },
      [TO_EJSON]() {
        return { $timestamp: { t: this.t, i: this.i } };
      },
      [INSPECT]() {
        return `Timestamp({ t: ${this.t}, i: ${this.i} })`;
      },
    },
  );

  const MinKey = bsonType('MinKey', function () {}, {
    [TO_EJSON]() {
      return { $minKey: 1 };
    },
    [INSPECT]() {
      return 'MinKey()';
    },
  });
  const MaxKey = bsonType('MaxKey', function () {}, {
    [TO_EJSON]() {
      return { $maxKey: 1 };
    },
    [INSPECT]() {
      return 'MaxKey()';
    },
  });

  const sortedOptions = (flags) =>
    [...new Set(String(flags ?? ''))]
      .filter((f) => 'ilmsux'.includes(f))
      .sort()
      .join('');

  const BSONRegExp = bsonType(
    'BSONRegExp',
    function (pattern, options) {
      this.pattern = String(pattern);
      this.options = sortedOptions(options);
    },
    {
      [TO_EJSON]() {
        return { $regularExpression: { pattern: this.pattern, options: this.options } };
      },
      [INSPECT]() {
        return `BSONRegExp(${quote(this.pattern)}, ${quote(this.options)})`;
      },
    },
  );

  const Code = bsonType(
    'Code',
    function (code, scope) {
      this.code = typeof code === 'function' ? code.toString() : String(code ?? '');
      this.scope = scope ?? null;
    },
    {
      [TO_EJSON](relaxed) {
        return this.scope
          ? { $code: this.code, $scope: serialize(this.scope, relaxed) }
          : { $code: this.code };
      },
      [INSPECT]() {
        return this.scope
          ? `Code(${quote(this.code)}, ${inspect(this.scope)})`
          : `Code(${quote(this.code)})`;
      },
    },
  );

  const BSONSymbol = bsonType(
    'BSONSymbol',
    function (value) {
      this.value = String(value);
    },
    {
      toString() {
        return this.value;
      },
      valueOf() {
        return this.value;
      },
      [TO_EJSON]() {
        return { $symbol: this.value };
      },
      [INSPECT]() {
        return `BSONSymbol(${quote(this.value)})`;
      },
    },
  );

  /** A value kept as its canonical Extended JSON (DBPointer): written back as it was read. */
  const RawBson = bsonType(
    'RawBson',
    function (ejson) {
      this.__raw = ejson;
    },
    {
      [TO_EJSON]() {
        return this.__raw;
      },
      [INSPECT]() {
        return `EJSON.deserialize(${JSON.stringify(this.__raw)})`;
      },
    },
  );

  function DBRef(collection, id, database, fields) {
    const ref = { $ref: String(collection), $id: id };
    if (database !== undefined) ref.$db = String(database);
    return Object.assign(ref, fields ?? {});
  }

  function ISODate(text) {
    if (text === undefined) return new Date();
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) throw invalid(`${String(text)} is not a valid ISODate`);
    return date;
  }

  // --- Extended JSON ----------------------------------------------------------------------

  // mongosh's rule (js-bson): an integral number in the Int32 range is an Int32, any other a
  // Double (2 ** 40 included). A whole Double read from the server is a plain number, so it is
  // written back as an Int32, as mongosh does; `Double(3)` keeps it a Double.
  function numberEjson(n, relaxed) {
    if (Number.isInteger(n) && !Object.is(n, -0) && n >= -2147483648 && n <= 2147483647) {
      return relaxed ? n : { $numberInt: String(n) };
    }
    if (relaxed && Number.isFinite(n) && !Object.is(n, -0)) return n;
    return { $numberDouble: doubleText(n) };
  }

  function dateEjson(date, relaxed) {
    const ms = date.getTime();
    if (Number.isNaN(ms)) throw invalid('an invalid Date cannot be written');
    if (relaxed && ms > -1 && ms < 253402318800000) {
      const iso = date.toISOString();
      return { $date: date.getUTCMilliseconds() !== 0 ? iso : `${iso.slice(0, -5)}Z` };
    }
    return { $date: { $numberLong: String(ms) } };
  }

  function regexEjson(regex) {
    if (regex.__bsonSource === regex.source && regex.__bsonFlags === regex.flags) {
      return { $regularExpression: { pattern: regex.__bsonPattern, options: regex.__bsonOptions } };
    }
    return { $regularExpression: { pattern: regex.source, options: sortedOptions(regex.flags) } };
  }

  function defineKey(target, key, value) {
    if (key === '__proto__') {
      Object.defineProperty(target, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else {
      target[key] = value;
    }
  }

  /** A value as Extended JSON (canonical unless `relaxed`), plain objects and arrays. */
  function serialize(value, relaxed, seen = new Set()) {
    if (value === null || value === undefined) return null;
    switch (typeof value) {
      case 'number':
        return numberEjson(value, relaxed);
      case 'bigint':
        return new Long(value)[TO_EJSON](relaxed);
      case 'string':
      case 'boolean':
        return value;
      case 'function':
      case 'symbol':
        return null;
    }
    if (seen.has(value)) throw makeError('TypeError', 'Converting circular structure to BSON');
    if (typeof value[TO_EJSON] === 'function') return value[TO_EJSON](relaxed);
    if (value instanceof Date) return dateEjson(value, relaxed);
    if (value instanceof RegExp) return regexEjson(value);
    if (value instanceof Number || value instanceof String || value instanceof Boolean) {
      return serialize(value.valueOf(), relaxed, seen);
    }
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      const bytes =
        value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return new Binary(bytes, 0)[TO_EJSON]();
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map((item) => serialize(item, relaxed, seen));
      if (value instanceof Map) {
        const out = {};
        for (const [k, v] of value) defineKey(out, String(k), serialize(v, relaxed, seen));
        return out;
      }
      const out = {};
      for (const key of Object.keys(value)) {
        const item = value[key];
        if (typeof item === 'function' || typeof item === 'symbol') continue;
        defineKey(out, key, serialize(item, relaxed, seen));
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }

  /** A document for the server: an object, canonical Extended JSON. */
  function document(value, what) {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value) || value instanceof Date) {
      throw invalid(`${what} must be an object, got ${inspect(value)}`);
    }
    return serialize(value, false);
  }

  const WRAPPERS = new Set([
    '$oid',
    '$numberInt',
    '$numberLong',
    '$numberDouble',
    '$numberDecimal',
    '$date',
    '$binary',
    '$uuid',
    '$regularExpression',
    '$timestamp',
    '$minKey',
    '$maxKey',
    '$code',
    '$symbol',
    '$undefined',
    '$dbPointer',
  ]);

  function parseDouble(text) {
    if (text === 'NaN' || text === '-NaN') return NaN;
    if (text === 'Infinity') return Infinity;
    if (text === '-Infinity') return -Infinity;
    return Number(text);
  }

  function makeRegex(pattern, options) {
    if (/[xl]/.test(options)) return new BSONRegExp(pattern, options);
    try {
      const regex = new RegExp(pattern, options);
      for (const [key, value] of [
        ['__bsonPattern', pattern],
        ['__bsonOptions', options],
        ['__bsonSource', regex.source],
        ['__bsonFlags', regex.flags],
      ]) {
        Object.defineProperty(regex, key, { value });
      }
      return regex;
    } catch {
      return new BSONRegExp(pattern, options);
    }
  }

  /** Values from Extended JSON (canonical or relaxed), as mongosh reads them. */
  function deserialize(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(deserialize);
    const keys = Object.keys(value);
    if (keys.length === 1 && WRAPPERS.has(keys[0])) {
      const body = value[keys[0]];
      switch (keys[0]) {
        case '$oid':
          return new ObjectId(body);
        case '$numberInt':
          return Number(body);
        case '$numberDouble':
          return parseDouble(body);
        case '$numberLong':
          return new Long(String(body));
        case '$numberDecimal':
          return new Decimal128(body);
        case '$date':
          if (typeof body === 'string') return new Date(body);
          if (typeof body === 'number') return new Date(body);
          return new Date(Number(body.$numberLong));
        case '$binary':
          return new Binary(String(body.base64), parseInt(String(body.subType), 16));
        case '$uuid':
          return UUID(body);
        case '$regularExpression':
          return makeRegex(String(body.pattern), String(body.options));
        case '$timestamp':
          return new Timestamp({ t: body.t, i: body.i });
        case '$minKey':
          return new MinKey();
        case '$maxKey':
          return new MaxKey();
        case '$code':
          return new Code(body);
        case '$symbol':
          return new BSONSymbol(body);
        case '$undefined':
          return undefined;
        default:
          return new RawBson(value);
      }
    }
    if (keys.length === 2 && keys.includes('$code') && keys.includes('$scope')) {
      return new Code(value.$code, deserialize(value.$scope));
    }
    const out = {};
    for (const key of keys) defineKey(out, key, deserialize(value[key]));
    return out;
  }

  const fromText = (text) => deserialize(JSON.parse(text));

  const EJSON = {
    serialize(value, options) {
      return serialize(value, options?.relaxed !== false);
    },
    deserialize(value) {
      return deserialize(value);
    },
    stringify(value, replacer, space, options) {
      let opts = options;
      let spacing = space;
      if (replacer !== null && typeof replacer === 'object' && !Array.isArray(replacer)) {
        opts = replacer;
        spacing = undefined;
        replacer = undefined;
      } else if (space !== null && typeof space === 'object') {
        opts = space;
        spacing = undefined;
      }
      return JSON.stringify(serialize(value, opts?.relaxed !== false), replacer, spacing);
    },
    parse(text, options) {
      const parsed = JSON.parse(text);
      if (options?.relaxed === false) return deserialize(parsed);
      return deserialize(parsed);
    },
  };

  // --- Printing (mongosh's shell format) -----------------------------------------------

  const IDENT = /^[A-Za-z_$][\w$]*$/;
  const BREAK = 72;
  const MAX_DEPTH = 6;

  function inspect(value, depth = 0, seen = new Set()) {
    if (value === null) return 'null';
    switch (typeof value) {
      case 'undefined':
        return 'undefined';
      case 'string':
        return quote(value);
      case 'number':
        return Object.is(value, -0) ? '-0' : String(value);
      case 'bigint':
        return `${value}n`;
      case 'boolean':
        return String(value);
      case 'symbol':
        return value.toString();
      case 'function':
        return `[Function: ${value.name || '(anonymous)'}]`;
    }
    if (typeof value[INSPECT] === 'function') return value[INSPECT](depth, seen);
    if (value instanceof Date) {
      return Number.isNaN(value.getTime())
        ? 'Invalid Date'
        : `ISODate(${quote(value.toISOString())})`;
    }
    if (value instanceof RegExp) return String(value);
    if (value instanceof Error)
      return value.stack ? `${value.name}: ${value.message}` : String(value);
    if (seen.has(value)) return '[Circular]';
    if (depth >= MAX_DEPTH) return Array.isArray(value) ? '[Array]' : '[Object]';
    seen.add(value);
    try {
      let open = '{';
      let close = '}';
      let parts;
      if (Array.isArray(value)) {
        open = '[';
        close = ']';
        parts = value.map((item) => inspect(item, depth + 1, seen));
      } else if (value instanceof Map) {
        open = `Map(${value.size}) {`;
        parts = [...value].map(
          ([k, v]) => `${inspect(k, depth + 1, seen)} => ${inspect(v, depth + 1, seen)}`,
        );
      } else if (value instanceof Set) {
        open = `Set(${value.size}) {`;
        parts = [...value].map((v) => inspect(v, depth + 1, seen));
      } else {
        parts = Object.keys(value).map(
          (key) => `${IDENT.test(key) ? key : quote(key)}: ${inspect(value[key], depth + 1, seen)}`,
        );
      }
      if (parts.length === 0) return Array.isArray(value) ? '[]' : open === '{' ? '{}' : `${open}}`;
      const oneLine = `${open} ${parts.join(', ')} ${close}`;
      if (oneLine.length + depth * 2 <= BREAK && !oneLine.includes('\n')) return oneLine;
      const pad = '  '.repeat(depth + 1);
      return `${open}\n${parts.map((p) => pad + p.replace(/\n/g, `\n`)).join(',\n')}\n${'  '.repeat(depth)}${close}`;
    } finally {
      seen.delete(value);
    }
  }

  /** What `print` shows: strings as they are, everything else in the shell format. */
  const show = (value) => (typeof value === 'string' ? value : inspect(value));

  function print(...values) {
    native.print('print', values.map(show).join(' '));
  }
  function printjson(...values) {
    native.print('print', values.map((v) => inspect(v)).join(' '));
  }
  const tojson = (value) => inspect(value);
  const console = {
    log: print,
    info: print,
    debug: print,
    warn: (...values) => native.print('warn', values.map(show).join(' ')),
    error: (...values) => native.print('error', values.map(show).join(' ')),
  };

  function sleep(ms) {
    const reply = JSON.parse(native.sleep(Math.max(0, Number(ms) || 0)));
    if (reply.error) throw bridgeError(reply.error);
  }

  // --- Cursors ------------------------------------------------------------------------------

  const CURSOR_OPTIONS = {
    sort: 'sort',
    limit: 'limit',
    skip: 'skip',
    projection: 'projection',
    hint: 'hint',
    collation: 'collation',
    batchSize: 'batchSize',
    maxTimeMS: 'maxTimeMS',
    comment: 'comment',
    allowDiskUse: 'allowDiskUse',
  };

  function encodeOptions(options, allowed, method) {
    const out = {};
    for (const [key, value] of Object.entries(options ?? {})) {
      if (value === undefined) continue;
      if (!allowed.includes(key)) {
        throw unsupported(`the option ${key} of ${method}()`, `db.runCommand()`);
      }
      out[key] = serialize(value, false);
    }
    return out;
  }

  /**
   * A lazy cursor, as mongosh's: options are recorded until it is first read; it then opens on
   * the server (through the gate) and reads batch by batch. `explain`: reading it returns the
   * plan instead.
   */
  function Cursor(source) {
    this._source = source;
    this._options = {};
    this._id = null;
    this._buffer = [];
    this._done = false;
    this._closed = false;
    this._transform = null;
    this._explain = null;
  }

  function cursorOption(name) {
    return function (value) {
      if (this._id !== null || this._done) {
        throw makeError(
          'MongoshInvalidInputError',
          `Cannot call ${name}() on a cursor that was already read`,
        );
      }
      this._options[CURSOR_OPTIONS[name] ?? name] = value;
      return this;
    };
  }

  Object.assign(Cursor.prototype, {
    sort: cursorOption('sort'),
    limit: cursorOption('limit'),
    skip: cursorOption('skip'),
    hint: cursorOption('hint'),
    collation: cursorOption('collation'),
    batchSize: cursorOption('batchSize'),
    maxTimeMS: cursorOption('maxTimeMS'),
    comment: cursorOption('comment'),
    allowDiskUse(value) {
      return cursorOption('allowDiskUse').call(this, value === undefined ? true : value);
    },
    projection: cursorOption('projection'),
    project: cursorOption('projection'),
    pretty() {
      return this;
    },
    readPref() {
      throw unsupported('cursor.readPref()');
    },
    readConcern() {
      throw unsupported('cursor.readConcern()');
    },
    noCursorTimeout() {
      throw unsupported('cursor.noCursorTimeout()');
    },
    min() {
      throw unsupported('cursor.min()', 'a filter');
    },
    max() {
      throw unsupported('cursor.max()', 'a filter');
    },
    returnKey() {
      throw unsupported('cursor.returnKey()', 'db.runCommand({ find: … })');
    },
    showRecordId() {
      throw unsupported('cursor.showRecordId()', 'db.runCommand({ find: … })');
    },
    addOption() {
      throw unsupported('cursor.addOption()');
    },
    tailable() {
      throw unsupported('cursor.tailable()');
    },
    map(fn) {
      const previous = this._transform;
      this._transform = previous ? (doc) => fn(previous(doc)) : fn;
      return this;
    },
    _request() {
      const s = this._source;
      if (s.kind === 'find') {
        const options = { ...s.options };
        for (const [key, value] of Object.entries(this._options)) options[key] = value;
        return {
          op: 'find',
          db: s.db,
          coll: s.coll,
          filter: document(s.filter, 'The filter'),
          options: encodeFindOptions(options),
        };
      }
      return {
        op: 'aggregate',
        db: s.db,
        coll: s.coll,
        pipeline: s.pipeline.map((stage) => document(stage, 'A pipeline stage')),
        options: encodeOptions(
          { ...s.options, ...this._options },
          ['allowDiskUse', 'batchSize', 'hint', 'collation', 'maxTimeMS', 'comment', 'let'],
          'aggregate',
        ),
      };
    },
    _open() {
      if (this._explain) return;
      if (this._id === null && !this._done) {
        const reply = call(native.cursorOpen, this._request());
        this._id = reply.id;
        this._take(reply);
      }
    },
    _take(reply) {
      if (reply.done) {
        this._done = true;
        this._id = null;
      } else {
        for (const doc of reply.documents) this._buffer.push(deserialize(doc));
      }
    },
    _fill() {
      if (this._explain) {
        if (!this._done) {
          this._buffer.push(this._explainNow(this._explain));
          this._done = true;
        }
        return;
      }
      this._open();
      while (this._buffer.length === 0 && !this._done) {
        const reply = JSON.parse(native.cursorNext(this._id));
        if (reply.error) {
          this._done = true;
          throw bridgeError(reply.error);
        }
        this._take(reply);
      }
    },
    hasNext() {
      if (this._closed) return false;
      this._fill();
      return this._buffer.length > 0;
    },
    next() {
      if (!this.hasNext()) throw makeError('MongoshInvalidInputError', 'Cursor is exhausted');
      const doc = this._buffer.shift();
      return this._transform ? this._transform(doc) : doc;
    },
    tryNext() {
      return this.hasNext() ? this.next() : null;
    },
    toArray() {
      const out = [];
      while (this.hasNext()) out.push(this.next());
      return out;
    },
    forEach(fn) {
      while (this.hasNext()) {
        const result = fn(this.next());
        if (result === false) break;
        if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
          // An async callback: the rest is chained, and the script's `await` waits for it.
          return (async () => {
            if ((await result) === false) return;
            while (this.hasNext()) if ((await fn(this.next())) === false) return;
          })();
        }
      }
      return undefined;
    },
    itcount() {
      let n = 0;
      while (this.hasNext()) {
        this.next();
        n += 1;
      }
      return n;
    },
    objsLeftInBatch() {
      return this._buffer.length;
    },
    isExhausted() {
      return this._done && this._buffer.length === 0;
    },
    isClosed() {
      return this._closed || this._done;
    },
    close() {
      if (this._id !== null) native.cursorClose(this._id);
      this._id = null;
      this._closed = true;
      this._done = true;
      this._buffer = [];
    },
    count(applySkipLimit) {
      const s = this._source;
      if (s.kind !== 'find') throw invalid('count() is a method of find cursors');
      const options = { ...s.options, ...this._options };
      const filter = document(s.filter, 'The filter');
      if (applySkipLimit && (options.skip || options.limit)) {
        const pipeline = [{ $match: filter }];
        if (options.skip) pipeline.push({ $skip: numberEjson(Number(options.skip), false) });
        if (options.limit)
          pipeline.push({ $limit: numberEjson(Math.abs(Number(options.limit)), false) });
        pipeline.push({ $count: 'n' });
        const docs = op({ op: 'aggregateAll', db: s.db, coll: s.coll, pipeline }).documents;
        return docs.length ? Number(deserialize(docs[0]).n) : 0;
      }
      return countOf(op({ op: 'count', db: s.db, coll: s.coll, filter }));
    },
    size() {
      return this.count(true);
    },
    explain(verbosity) {
      return this._explainNow(verbosityOf(verbosity));
    },
    _explainNow(verbosity) {
      const s = this._source;
      let command;
      if (s.kind === 'find') {
        const request = this._request();
        command = { find: s.coll, filter: request.filter, ...request.options };
        if (command.limit && typeof command.limit === 'object') {
          const n = Number(command.limit.$numberInt ?? command.limit.$numberLong ?? 0);
          if (n < 0) {
            command.limit = numberEjson(-n, false);
            command.singleBatch = true;
          }
        }
      } else {
        const request = this._request();
        command = {
          aggregate: s.coll === null ? numberEjson(1, false) : s.coll,
          pipeline: request.pipeline,
          cursor: {},
          ...request.options,
        };
      }
      return explainCommand(s.db, command, verbosity);
    },
    [Symbol.iterator]() {
      return {
        next: () =>
          this.hasNext() ? { value: this.next(), done: false } : { value: undefined, done: true },
        [Symbol.iterator]() {
          return this;
        },
      };
    },
    [Symbol.asyncIterator]() {
      const it = this[Symbol.iterator]();
      return {
        next: () => Promise.resolve(it.next()),
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    },
    [INSPECT](depth, seen) {
      const docs = [];
      while (docs.length < 20 && this.hasNext()) docs.push(this.next());
      return inspect(docs, depth, seen);
    },
    [RESULT]() {
      if (this._explain || this._transform) return { kind: 'documents', value: this.toArray() };
      this._open();
      return {
        kind: 'cursor',
        id: this._id,
        buffered: this._buffer.map((doc) => serialize(doc, false)),
        done: this._done,
      };
    },
  });

  function encodeFindOptions(options) {
    const out = {};
    for (const [key, value] of Object.entries(options)) {
      if (value === undefined || value === null) continue;
      switch (key) {
        case 'projection':
        case 'sort':
        case 'collation':
          out[key] = document(value, `The ${key}`);
          break;
        case 'hint':
          out.hint = typeof value === 'string' ? value : document(value, 'The hint');
          break;
        case 'skip':
        case 'limit':
        case 'batchSize':
        case 'maxTimeMS':
          if (!Number.isFinite(Number(value)))
            throw invalid(`${key} needs a number, got ${inspect(value)}`);
          out[key] = numberEjson(Math.trunc(Number(value)), false);
          break;
        case 'comment':
          out.comment = serialize(value, false);
          break;
        case 'allowDiskUse':
          out.allowDiskUse = Boolean(value);
          break;
        default:
          throw unsupported(`the option ${key} of find()`, 'db.runCommand({ find: … })');
      }
    }
    return out;
  }

  const countOf = (reply) => Number(deserialize(reply.reply).count);

  function verbosityOf(verbosity) {
    if (verbosity === undefined || verbosity === null) return 'queryPlanner';
    if (verbosity === true) return 'allPlansExecution';
    if (verbosity === false) return 'queryPlanner';
    const text = String(verbosity);
    if (!['queryPlanner', 'executionStats', 'allPlansExecution'].includes(text)) {
      throw invalid(
        `explain verbosity must be queryPlanner, executionStats or allPlansExecution, got ${text}`,
      );
    }
    return text;
  }

  function explainCommand(db, command, verbosity) {
    return deserialize(op({ op: 'explain', db, command, verbosity }).reply);
  }

  // --- Collections ------------------------------------------------------------------------

  function Collection(database, name) {
    this._db = database;
    this._name = name;
  }

  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  function updateDocument(update, method) {
    if (Array.isArray(update)) return update.map((stage) => document(stage, 'A pipeline stage'));
    if (!isObject(update)) throw invalid(`${method}: the update must be an object or a pipeline`);
    const keys = Object.keys(update);
    if (keys.length === 0 || !keys[0].startsWith('$')) {
      throw invalid(`${method}: the update document requires atomic operators ($set, $inc…)`);
    }
    return document(update, 'The update');
  }

  function replacementDocument(replacement, method) {
    if (!isObject(replacement)) throw invalid(`${method}: the replacement must be an object`);
    if (Object.keys(replacement).some((key) => key.startsWith('$'))) {
      throw invalid(`${method}: the replacement document must not contain atomic operators`);
    }
    return document(replacement, 'The replacement');
  }

  function checkOptions(options, allowed, method) {
    for (const key of Object.keys(options ?? {})) {
      if (options[key] === undefined) continue;
      if (!allowed.includes(key))
        throw unsupported(`the option ${key} of ${method}()`, 'db.runCommand()');
    }
  }

  function withId(doc, method) {
    if (!isObject(doc))
      throw invalid(`${method}: a document must be an object, got ${inspect(doc)}`);
    if (!hasOwn(doc, '_id')) doc._id = new ObjectId();
    return doc;
  }

  function updateResult(reply) {
    const r = deserialize(reply);
    const upserted = Array.isArray(r.upserted) ? r.upserted : [];
    const n = Number(r.n ?? 0);
    return {
      acknowledged: true,
      insertedId: upserted.length ? upserted[0]._id : null,
      matchedCount: n - upserted.length,
      modifiedCount: Number(r.nModified ?? 0),
      upsertedCount: upserted.length,
    };
  }

  /** `name_1_other_-1`, as the drivers name an index from its keys. */
  function indexName(keys) {
    return Object.entries(keys)
      .map(
        ([k, v]) =>
          `${k}_${v instanceof Int32 || v instanceof Double || v instanceof Long ? v.valueOf() : v}`,
      )
      .join('_');
  }

  function indexModel(keys, options, method) {
    if (!isObject(keys) || Object.keys(keys).length === 0) {
      throw invalid(`${method}: the index keys must be a non-empty object`);
    }
    const model = { key: keys, name: indexName(keys) };
    for (const [k, v] of Object.entries(options ?? {})) if (v !== undefined) model[k] = v;
    return document(model, 'The index');
  }

  const COLLECTION_UNSUPPORTED = {
    watch: ['collection.watch()', ''],
    mapReduce: ['collection.mapReduce()', 'collection.aggregate()'],
    initializeOrderedBulkOp: ['collection.initializeOrderedBulkOp()', 'collection.bulkWrite()'],
    initializeUnorderedBulkOp: ['collection.initializeUnorderedBulkOp()', 'collection.bulkWrite()'],
    getShardDistribution: ['collection.getShardDistribution()', 'db.adminCommand()'],
    getShardVersion: ['collection.getShardVersion()', 'db.adminCommand()'],
    createSearchIndex: [
      'collection.createSearchIndex()',
      'db.runCommand({ createSearchIndexes: … })',
    ],
    createSearchIndexes: [
      'collection.createSearchIndexes()',
      'db.runCommand({ createSearchIndexes: … })',
    ],
    getSearchIndexes: [
      'collection.getSearchIndexes()',
      'collection.aggregate([{ $listSearchIndexes: {} }])',
    ],
    dropSearchIndex: ['collection.dropSearchIndex()', 'db.runCommand({ dropSearchIndex: … })'],
    updateSearchIndex: [
      'collection.updateSearchIndex()',
      'db.runCommand({ updateSearchIndex: … })',
    ],
    configureQueryAnalyzer: ['collection.configureQueryAnalyzer()', 'db.adminCommand()'],
  };

  const collectionMethods = {
    getName() {
      return this._name;
    },
    getFullName() {
      return `${this._db._name}.${this._name}`;
    },
    getDB() {
      return dbProxy(this._db);
    },
    toString() {
      return this.getFullName();
    },
    _ns() {
      return { db: this._db._name, coll: this._name };
    },
    find(filter, projection, options) {
      if (filter !== undefined && filter !== null && !isObject(filter)) {
        throw invalid(`find: the filter must be an object, got ${inspect(filter)}`);
      }
      const merged = { ...(options ?? {}) };
      if (projection !== undefined && projection !== null) merged.projection = projection;
      return new Cursor({ kind: 'find', ...this._ns(), filter: filter ?? {}, options: merged });
    },
    findOne(filter, projection, options) {
      const cursor = this.find(filter, projection, options).limit(-1);
      return cursor.hasNext() ? cursor.next() : null;
    },
    aggregate(...args) {
      let pipeline = args[0];
      let options = args[1];
      if (!Array.isArray(pipeline)) {
        pipeline = args.filter((a) => isObject(a) && Object.keys(a)[0]?.startsWith('$'));
        options = undefined;
      }
      const cursor = new Cursor({
        kind: 'aggregate',
        ...this._ns(),
        pipeline,
        options: options ?? {},
      });
      if (options?.explain) {
        const { explain, ...rest } = options;
        cursor._source.options = rest;
        return cursor.explain(explain === true ? 'queryPlanner' : explain);
      }
      // An aggregation runs at once in mongosh ($out / $merge write even if never read).
      cursor._open();
      return cursor;
    },
    countDocuments(filter, options) {
      checkOptions(options, ['limit', 'skip', 'maxTimeMS', 'hint', 'collation'], 'countDocuments');
      const f = document(filter, 'The filter');
      if (options && Object.values(options).some((v) => v !== undefined)) {
        const pipeline = [{ $match: f }];
        if (options.skip) pipeline.push({ $skip: numberEjson(Number(options.skip), false) });
        if (options.limit) pipeline.push({ $limit: numberEjson(Number(options.limit), false) });
        pipeline.push({
          $group: { _id: numberEjson(1, false), n: { $sum: numberEjson(1, false) } },
        });
        const aggOptions = encodeOptions(
          { hint: options.hint, collation: options.collation, maxTimeMS: options.maxTimeMS },
          ['hint', 'collation', 'maxTimeMS'],
          'countDocuments',
        );
        const docs = op({
          op: 'aggregateAll',
          ...this._ns(),
          pipeline,
          options: aggOptions,
        }).documents;
        return docs.length ? Number(deserialize(docs[0]).n) : 0;
      }
      return countOf(op({ op: 'count', ...this._ns(), filter: f }));
    },
    estimatedDocumentCount(options) {
      checkOptions(options, [], 'estimatedDocumentCount');
      return countOf(op({ op: 'estimatedCount', ...this._ns() }));
    },
    count(filter, options) {
      checkOptions(options, ['limit', 'skip', 'maxTimeMS', 'hint', 'collation'], 'count');
      if (
        (filter === undefined || (isObject(filter) && Object.keys(filter).length === 0)) &&
        !options
      ) {
        return this.estimatedDocumentCount();
      }
      return this.countDocuments(filter, options);
    },
    distinct(key, filter, options) {
      checkOptions(options, [], 'distinct');
      if (typeof key !== 'string') throw invalid('distinct: the key must be a string');
      const reply = deserialize(
        op({ op: 'distinct', ...this._ns(), key, filter: document(filter, 'The filter') }).reply,
      );
      return reply.values ?? [];
    },
    insertOne(doc, options) {
      checkOptions(options, [], 'insertOne');
      const d = withId(doc, 'insertOne');
      op({ op: 'insert', ...this._ns(), documents: [document(d, 'The document')], ordered: true });
      return { acknowledged: true, insertedId: d._id };
    },
    insertMany(docs, options) {
      checkOptions(options, ['ordered'], 'insertMany');
      if (!Array.isArray(docs)) throw invalid('insertMany: the documents must be an array');
      const ready = docs.map((d) => withId(d, 'insertMany'));
      op({
        op: 'insert',
        ...this._ns(),
        documents: ready.map((d) => document(d, 'A document')),
        ordered: options?.ordered !== false,
      });
      const insertedIds = {};
      ready.forEach((d, i) => {
        insertedIds[i] = d._id;
      });
      return { acknowledged: true, insertedIds };
    },
    insert(docs, options) {
      if (Array.isArray(docs)) {
        const r = this.insertMany(docs, options);
        return { acknowledged: true, insertedIds: r.insertedIds };
      }
      const r = this.insertOne(docs, options);
      return { acknowledged: true, insertedIds: { 0: r.insertedId } };
    },
    _update(filter, update, options, many, method) {
      checkOptions(options, ['upsert', 'arrayFilters'], method);
      const request = {
        op: 'update',
        ...this._ns(),
        filter: document(filter, 'The filter'),
        update: updateDocument(update, method),
        many,
        upsert: Boolean(options?.upsert),
      };
      if (options?.arrayFilters)
        request.arrayFilters = options.arrayFilters.map((f) => document(f, 'An array filter'));
      return updateResult(op(request).reply);
    },
    updateOne(filter, update, options) {
      return this._update(filter, update, options, false, 'updateOne');
    },
    updateMany(filter, update, options) {
      return this._update(filter, update, options, true, 'updateMany');
    },
    update(filter, update, options) {
      const { multi, ...rest } = options ?? {};
      if (isObject(update) && !Object.keys(update)[0]?.startsWith('$')) {
        if (multi) throw invalid('update: a replacement document cannot update many documents');
        return this.replaceOne(filter, update, rest);
      }
      return this._update(filter, update, rest, Boolean(multi), 'update');
    },
    replaceOne(filter, replacement, options) {
      checkOptions(options, ['upsert'], 'replaceOne');
      return updateResult(
        op({
          op: 'replace',
          ...this._ns(),
          filter: document(filter, 'The filter'),
          replacement: replacementDocument(replacement, 'replaceOne'),
          upsert: Boolean(options?.upsert),
        }).reply,
      );
    },
    _delete(filter, options, many, method) {
      checkOptions(options, [], method);
      if (filter === undefined)
        throw invalid(`${method}: a filter is required ({} for every document)`);
      const reply = deserialize(
        op({ op: 'delete', ...this._ns(), filter: document(filter, 'The filter'), many }).reply,
      );
      return { acknowledged: true, deletedCount: Number(reply.n ?? 0) };
    },
    deleteOne(filter, options) {
      return this._delete(filter, options, false, 'deleteOne');
    },
    deleteMany(filter, options) {
      return this._delete(filter, options, true, 'deleteMany');
    },
    remove(filter, justOne) {
      const one = isObject(justOne) ? Boolean(justOne.justOne) : Boolean(justOne);
      return this._delete(filter ?? {}, undefined, !one, 'remove');
    },
    _findAndModify(filter, action, body, options, method) {
      checkOptions(
        options,
        [
          'projection',
          'sort',
          'upsert',
          'returnDocument',
          'returnNewDocument',
          'arrayFilters',
          'includeResultMetadata',
        ],
        method,
      );
      const request = {
        op: 'findAndModify',
        ...this._ns(),
        filter: document(filter, 'The filter'),
        action,
        upsert: Boolean(options?.upsert),
        returnNew: options?.returnDocument === 'after' || options?.returnNewDocument === true,
      };
      if (body !== undefined) request.update = body;
      if (options?.sort) request.sort = document(options.sort, 'The sort');
      if (options?.projection) request.projection = document(options.projection, 'The projection');
      if (options?.arrayFilters)
        request.arrayFilters = options.arrayFilters.map((f) => document(f, 'An array filter'));
      const reply = deserialize(op(request).reply);
      if (options?.includeResultMetadata) return reply;
      return reply.value ?? null;
    },
    findOneAndUpdate(filter, update, options) {
      return this._findAndModify(
        filter,
        'update',
        updateDocument(update, 'findOneAndUpdate'),
        options,
        'findOneAndUpdate',
      );
    },
    findOneAndReplace(filter, replacement, options) {
      return this._findAndModify(
        filter,
        'replace',
        replacementDocument(replacement, 'findOneAndReplace'),
        options,
        'findOneAndReplace',
      );
    },
    findOneAndDelete(filter, options) {
      return this._findAndModify(filter, 'remove', undefined, options, 'findOneAndDelete');
    },
    findAndModify(spec) {
      if (!isObject(spec))
        throw invalid('findAndModify takes one object ({ query, update | remove, … })');
      const options = {
        sort: spec.sort,
        projection: spec.fields,
        upsert: spec.upsert,
        returnNewDocument: spec.new,
        arrayFilters: spec.arrayFilters,
      };
      if (spec.remove)
        return this.findOneAndDelete(spec.query, { sort: spec.sort, projection: spec.fields });
      if (isObject(spec.update) && !Object.keys(spec.update)[0]?.startsWith('$')) {
        return this.findOneAndReplace(spec.query, spec.update, options);
      }
      return this.findOneAndUpdate(spec.query, spec.update, options);
    },
    bulkWrite(operations, options) {
      checkOptions(options, ['ordered'], 'bulkWrite');
      if (!Array.isArray(operations)) throw invalid('bulkWrite: the operations must be an array');
      const insertedIds = {};
      const encoded = operations.map((entry, index) => {
        if (!isObject(entry) || Object.keys(entry).length !== 1) {
          throw invalid(
            `bulkWrite: operation ${index} must be { insertOne | updateOne | … : { … } }`,
          );
        }
        const [kind, body] = Object.entries(entry)[0];
        const filterOf = (b) => document(b.filter, 'The filter');
        switch (kind) {
          case 'insertOne': {
            const d = withId(body.document ?? body, 'bulkWrite insertOne');
            insertedIds[index] = d._id;
            return { kind: 'insertOne', document: document(d, 'A document') };
          }
          case 'updateOne':
          case 'updateMany': {
            const op_ = {
              kind: 'update',
              filter: filterOf(body),
              update: updateDocument(body.update, `bulkWrite ${kind}`),
              many: kind === 'updateMany',
              upsert: Boolean(body.upsert),
            };
            if (body.arrayFilters)
              op_.arrayFilters = body.arrayFilters.map((f) => document(f, 'An array filter'));
            return op_;
          }
          case 'replaceOne':
            return {
              kind: 'replaceOne',
              filter: filterOf(body),
              replacement: replacementDocument(body.replacement, 'bulkWrite replaceOne'),
              upsert: Boolean(body.upsert),
            };
          case 'deleteOne':
          case 'deleteMany':
            return { kind: 'delete', filter: filterOf(body), many: kind === 'deleteMany' };
          default:
            throw invalid(`bulkWrite: unknown operation ${kind}`);
        }
      });
      const reply = deserialize(
        op({
          op: 'bulkWrite',
          ...this._ns(),
          operations: encoded,
          ordered: options?.ordered !== false,
        }).reply,
      );
      return {
        acknowledged: true,
        insertedCount: Number(reply.insertedCount),
        insertedIds,
        matchedCount: Number(reply.matchedCount),
        modifiedCount: Number(reply.modifiedCount),
        deletedCount: Number(reply.deletedCount),
        upsertedCount: Number(reply.upsertedCount),
        upsertedIds: reply.upsertedIds ?? {},
      };
    },
    createIndex(keys, options) {
      op({
        op: 'createIndexes',
        ...this._ns(),
        indexes: [indexModel(keys, options, 'createIndex')],
      });
      return options?.name ?? indexName(keys);
    },
    ensureIndex(keys, options) {
      return this.createIndex(keys, options);
    },
    createIndexes(list, options) {
      if (!Array.isArray(list))
        throw invalid('createIndexes: the indexes must be an array of key objects');
      const models = list.map((keys) => indexModel(keys, options, 'createIndexes'));
      op({ op: 'createIndexes', ...this._ns(), indexes: models });
      return list.map((keys) => options?.name ?? indexName(keys));
    },
    getIndexes() {
      return op({ op: 'listIndexes', ...this._ns() }).documents.map(deserialize);
    },
    getIndexSpecs() {
      return this.getIndexes();
    },
    getIndices() {
      return this.getIndexes();
    },
    getIndexKeys() {
      return this.getIndexes().map((index) => index.key);
    },
    dropIndex(index) {
      let name = index;
      if (isObject(index)) {
        const wanted = JSON.stringify(serialize(index, true));
        const found = this.getIndexes().find(
          (i) => JSON.stringify(serialize(i.key, true)) === wanted,
        );
        if (!found)
          throw makeError('MongoServerError', `can't find index with key: ${inspect(index)}`, {
            code: 27,
            codeName: 'IndexNotFound',
          });
        name = found.name;
      }
      if (typeof name !== 'string') throw invalid('dropIndex: give an index name or its keys');
      if (name === '*') throw invalid('dropIndex("*") drops every index: use dropIndexes()');
      return deserialize(op({ op: 'dropIndexes', ...this._ns(), name }).reply);
    },
    dropIndexes(names) {
      if (names === undefined || names === '*') {
        return deserialize(op({ op: 'dropIndexes', ...this._ns(), name: '*' }).reply);
      }
      const list = Array.isArray(names) ? names : [names];
      let reply = null;
      for (const one of list) reply = this.dropIndex(one);
      return reply;
    },
    drop() {
      try {
        op({ op: 'dropCollection', ...this._ns() });
        return true;
      } catch (error) {
        if (error.codeName === 'NamespaceNotFound') return false;
        throw error;
      }
    },
    renameCollection(target, dropTarget) {
      if (typeof target !== 'string' || target === '')
        throw invalid('renameCollection: the new name must be a string');
      return deserialize(
        op({
          op: 'renameCollection',
          ...this._ns(),
          toDb: this._db._name,
          to: target,
          dropTarget: Boolean(dropTarget),
        }).reply,
      );
    },
    stats(options) {
      const scale = typeof options === 'number' ? options : options?.scale;
      const command = { collStats: this._name };
      if (scale) command.scale = numberEjson(Number(scale), false);
      return runCommandOn(this._db._name, command);
    },
    dataSize() {
      return this.stats().size;
    },
    storageSize() {
      return this.stats().storageSize;
    },
    totalIndexSize() {
      return this.stats().totalIndexSize;
    },
    totalSize() {
      const s = this.stats();
      return Number(s.storageSize ?? 0) + Number(s.totalIndexSize ?? 0);
    },
    isCapped() {
      return Boolean(this.stats().capped);
    },
    exists() {
      const infos = this._db.getCollectionInfos({ name: this._name });
      return infos.length ? infos[0] : null;
    },
    validate(options) {
      const command = { validate: this._name };
      if (options === true) command.full = true;
      else if (isObject(options)) Object.assign(command, options);
      return runCommandOn(this._db._name, command);
    },
    hideIndex(index) {
      const target = typeof index === 'string' ? { name: index } : { keyPattern: index };
      return runCommandOn(this._db._name, {
        collMod: this._name,
        index: { ...target, hidden: true },
      });
    },
    unhideIndex(index) {
      const target = typeof index === 'string' ? { name: index } : { keyPattern: index };
      return runCommandOn(this._db._name, {
        collMod: this._name,
        index: { ...target, hidden: false },
      });
    },
    latencyStats(options) {
      return this.aggregate([{ $collStats: { latencyStats: options ?? {} } }]).toArray();
    },
    explain(verbosity) {
      return new Explainable(this, verbosityOf(verbosity));
    },
    getCollection(name) {
      return this._db.getCollection(`${this._name}.${name}`);
    },
    [INSPECT]() {
      return this.getFullName();
    },
  };
  for (const [method, [name, instead]] of Object.entries(COLLECTION_UNSUPPORTED)) {
    collectionMethods[method] = function () {
      throw unsupported(name, instead);
    };
  }
  for (const key of Reflect.ownKeys(collectionMethods)) {
    Object.defineProperty(Collection.prototype, key, {
      value: collectionMethods[key],
      writable: true,
      configurable: true,
    });
  }

  /** `db.c.explain(verbosity).find(…)` and friends: the plan of the operation, nothing run. */
  function Explainable(collection, verbosity) {
    this._collection = collection;
    this._verbosity = verbosity;
  }
  Object.assign(Explainable.prototype, {
    find(filter, projection, options) {
      const cursor = this._collection.find(filter, projection, options);
      cursor._explain = this._verbosity;
      return cursor;
    },
    findOne(filter, projection, options) {
      return this.find(filter, projection, options).limit(-1).next();
    },
    aggregate(pipeline, options) {
      const cursor = new Cursor({
        kind: 'aggregate',
        ...this._collection._ns(),
        pipeline: Array.isArray(pipeline) ? pipeline : [...arguments],
        options: options ?? {},
      });
      return cursor.explain(this._verbosity);
    },
    count(filter) {
      const c = this._collection;
      return explainCommand(
        c._db._name,
        { count: c._name, query: document(filter, 'The filter') },
        this._verbosity,
      );
    },
    countDocuments(filter) {
      return this.count(filter);
    },
    distinct(key, filter) {
      const c = this._collection;
      return explainCommand(
        c._db._name,
        { distinct: c._name, key, query: document(filter, 'The filter') },
        this._verbosity,
      );
    },
    _write(command) {
      const c = this._collection;
      return explainCommand(c._db._name, { ...command }, this._verbosity);
    },
    deleteOne(filter) {
      return this._write({
        delete: this._collection._name,
        deletes: [{ q: document(filter, 'The filter'), limit: numberEjson(1, false) }],
      });
    },
    deleteMany(filter) {
      return this._write({
        delete: this._collection._name,
        deletes: [{ q: document(filter, 'The filter'), limit: numberEjson(0, false) }],
      });
    },
    remove(filter, justOne) {
      return justOne ? this.deleteOne(filter) : this.deleteMany(filter);
    },
    updateOne(filter, update, options) {
      return this._write({
        update: this._collection._name,
        updates: [
          {
            q: document(filter, 'The filter'),
            u: updateDocument(update, 'updateOne'),
            multi: false,
            upsert: Boolean(options?.upsert),
          },
        ],
      });
    },
    updateMany(filter, update, options) {
      return this._write({
        update: this._collection._name,
        updates: [
          {
            q: document(filter, 'The filter'),
            u: updateDocument(update, 'updateMany'),
            multi: true,
            upsert: Boolean(options?.upsert),
          },
        ],
      });
    },
    findOneAndUpdate(filter, update) {
      return this._write({
        findAndModify: this._collection._name,
        query: document(filter, 'The filter'),
        update: updateDocument(update, 'findOneAndUpdate'),
      });
    },
    findOneAndDelete(filter) {
      return this._write({
        findAndModify: this._collection._name,
        query: document(filter, 'The filter'),
        remove: true,
      });
    },
    [INSPECT]() {
      return `Explainable(${this._collection.getFullName()})`;
    },
  });

  function collectionProxy(collection) {
    return new Proxy(collection, {
      get(target, prop, receiver) {
        if (typeof prop === 'symbol' || prop in target) return Reflect.get(target, prop, receiver);
        if (typeof prop === 'string' && !prop.startsWith('_')) return target.getCollection(prop);
        return undefined;
      },
    });
  }

  // --- Databases ----------------------------------------------------------------------

  function runCommandOn(db, command) {
    const reply = op({ op: 'runCommand', db, command: serialize(command, false) });
    if (reply.documents) {
      return {
        cursor: { firstBatch: reply.documents.map(deserialize), id: new Long(0), ns: db },
        ok: 1,
      };
    }
    return deserialize(reply.reply);
  }

  function commandOf(command) {
    if (typeof command === 'string') return { [command]: 1 };
    if (!isObject(command) || Object.keys(command).length === 0) {
      throw invalid('runCommand takes a command document ({ ping: 1 }) or a command name');
    }
    return command;
  }

  const USER_HELPERS = [
    'createUser',
    'updateUser',
    'dropUser',
    'dropAllUsers',
    'getUser',
    'getUsers',
    'grantRolesToUser',
    'revokeRolesFromUser',
    'changeUserPassword',
    'createRole',
    'updateRole',
    'dropRole',
    'dropAllRoles',
    'getRole',
    'getRoles',
    'grantPrivilegesToRole',
    'revokePrivilegesFromRole',
    'grantRolesToRole',
    'revokeRolesFromRole',
    'auth',
    'logout',
  ];

  function Database(name) {
    this._name = name;
    this._collections = new Map();
  }
  const databaseMethods = {
    getName() {
      return this._name;
    },
    toString() {
      return this._name;
    },
    getSiblingDB(name) {
      if (typeof name !== 'string' || name === '')
        throw invalid('getSiblingDB: the name must be a non-empty string');
      return dbProxy(databaseOf(name));
    },
    getCollection(name) {
      if (typeof name !== 'string' || name === '')
        throw invalid('getCollection: the name must be a non-empty string');
      let collection = this._collections.get(name);
      if (!collection) {
        collection = collectionProxy(new Collection(this, name));
        this._collections.set(name, collection);
      }
      return collection;
    },
    getCollectionInfos(filter, options) {
      checkOptions(options, [], 'getCollectionInfos');
      const request = { op: 'listCollections', db: this._name };
      if (filter !== undefined) request.filter = document(filter, 'The filter');
      return op(request).documents.map(deserialize);
    },
    getCollectionNames() {
      return this.getCollectionInfos()
        .map((info) => info.name)
        .sort();
    },
    createCollection(name, options) {
      if (typeof name !== 'string' || name === '')
        throw invalid('createCollection: the name must be a non-empty string');
      op({
        op: 'createCollection',
        db: this._name,
        name,
        options: document(options, 'The options'),
      });
      return { ok: 1 };
    },
    createView(name, source, pipeline, options) {
      return this.createCollection(name, {
        ...(options ?? {}),
        viewOn: source,
        pipeline: pipeline ?? [],
      });
    },
    dropDatabase() {
      return deserialize(op({ op: 'dropDatabase', db: this._name }).reply);
    },
    runCommand(command) {
      return runCommandOn(this._name, commandOf(command));
    },
    adminCommand(command) {
      return runCommandOn('admin', commandOf(command));
    },
    aggregate(pipeline, options) {
      if (!Array.isArray(pipeline)) throw invalid('db.aggregate: the pipeline must be an array');
      const cursor = new Cursor({
        kind: 'aggregate',
        db: this._name,
        coll: null,
        pipeline,
        options: options ?? {},
      });
      cursor._open();
      return cursor;
    },
    stats(options) {
      const scale = typeof options === 'number' ? options : options?.scale;
      const command = { dbStats: 1 };
      if (scale) command.scale = numberEjson(Number(scale), false);
      return runCommandOn(this._name, command);
    },
    version() {
      return String(runCommandOn('admin', { buildInfo: 1 }).version);
    },
    serverBuildInfo() {
      return runCommandOn('admin', { buildInfo: 1 });
    },
    serverStatus(options) {
      return runCommandOn('admin', { serverStatus: 1, ...(options ?? {}) });
    },
    hostInfo() {
      return runCommandOn('admin', { hostInfo: 1 });
    },
    hello() {
      return runCommandOn('admin', { hello: 1 });
    },
    isMaster() {
      return runCommandOn('admin', { isMaster: 1 });
    },
    serverCmdLineOpts() {
      return runCommandOn('admin', { getCmdLineOpts: 1 });
    },
    listCommands() {
      return runCommandOn('admin', { listCommands: 1 });
    },
    currentOp(filter) {
      const options = filter === true ? { $all: true } : (filter ?? {});
      return runCommandOn('admin', { currentOp: 1, ...options });
    },
    killOp(opid) {
      return runCommandOn('admin', { killOp: 1, op: opid });
    },
    getProfilingStatus() {
      return runCommandOn(this._name, { profile: -1 });
    },
    setProfilingLevel(level, options) {
      const extra = typeof options === 'number' ? { slowms: options } : (options ?? {});
      return runCommandOn(this._name, { profile: level, ...extra });
    },
    getLogComponents() {
      return runCommandOn('admin', { getParameter: 1, logComponentVerbosity: 1 })
        .logComponentVerbosity;
    },
    getMongo() {
      return mongo;
    },
    watch() {
      throw unsupported('db.watch()');
    },
    help() {
      throw unsupported('db.help()');
    },
    [INSPECT]() {
      return this._name;
    },
  };
  for (const helper of USER_HELPERS) {
    databaseMethods[helper] = function () {
      throw unsupported(
        `db.${helper}()`,
        `db.runCommand({ ${helper === 'getUsers' ? 'usersInfo' : helper}: … })`,
      );
    };
  }
  for (const key of Reflect.ownKeys(databaseMethods)) {
    Object.defineProperty(Database.prototype, key, {
      value: databaseMethods[key],
      writable: true,
      configurable: true,
    });
  }

  const databases = new Map();
  function databaseOf(name) {
    let database = databases.get(name);
    if (!database) {
      database = new Database(name);
      databases.set(name, database);
    }
    return database;
  }

  const proxies = new WeakMap();
  function dbProxy(database) {
    let proxy = proxies.get(database);
    if (!proxy) {
      proxy = new Proxy(database, {
        get(target, prop, receiver) {
          if (typeof prop === 'symbol' || prop in target)
            return Reflect.get(target, prop, receiver);
          if (typeof prop === 'string' && !prop.startsWith('_')) return target.getCollection(prop);
          return undefined;
        },
      });
      proxies.set(database, proxy);
    }
    return proxy;
  }

  let current = databaseOf(initialDatabase);

  const mongo = {
    getDB(name) {
      return dbProxy(databaseOf(name));
    },
    getDBNames() {
      return listDatabases().map((d) => d.name);
    },
    getDBs() {
      return runCommandOn('admin', { listDatabases: 1 });
    },
    startSession() {
      throw unsupported('Mongo.startSession()', '#sessions');
    },
    watch() {
      throw unsupported('Mongo.watch()');
    },
    setReadPref() {
      throw unsupported('Mongo.setReadPref()', '#connection');
    },
    getReadPref() {
      throw unsupported('Mongo.getReadPref()', '#connection');
    },
    [INSPECT]() {
      return 'Mongo()';
    },
  };

  function listDatabases() {
    const reply = deserialize(op({ op: 'listDatabases' }).reply);
    return (reply.databases ?? []).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  function size(bytes) {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let n = Number(bytes ?? 0);
    let unit = 0;
    while (n >= 1024 && unit < units.length - 1) {
      n /= 1024;
      unit += 1;
    }
    return `${n.toFixed(2)} ${units[unit]}`;
  }

  /** `name` → a stand-in whose every method throws the typed "not available" error. */
  function unavailable(name, instead) {
    return new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop === 'symbol') return undefined;
          return function () {
            throw unsupported(`${name}.${String(prop)}()`, instead);
          };
        },
      },
    );
  }

  function unavailableFunction(name, instead) {
    return function () {
      throw unsupported(`${name}()`, instead);
    };
  }

  // --- Globals ----------------------------------------------------------------------------

  const globals = {
    print,
    printjson,
    tojson,
    console,
    sleep,
    EJSON,
    ObjectId,
    Long,
    NumberLong,
    Int32,
    NumberInt,
    Double,
    Decimal128,
    NumberDecimal,
    Binary,
    BinData,
    HexData,
    MD5,
    UUID,
    Timestamp,
    MinKey,
    MaxKey,
    BSONRegExp,
    BSONSymbol,
    Code,
    DBRef,
    ISODate,
    rs: unavailable('rs', 'db.adminCommand({ replSetGetStatus: 1 })'),
    sh: unavailable('sh', 'db.adminCommand()'),
    sp: unavailable('sp', 'db.adminCommand()'),
    Mongo: unavailableFunction('Mongo', '#connection'),
    connect: unavailableFunction('connect', '#connection'),
    load: unavailableFunction('load', '#files'),
    require: unavailableFunction('require', '#modules'),
    quit: unavailableFunction('quit', '#cancel'),
    exit: unavailableFunction('exit', '#cancel'),
    isInteractive: () => false,
  };
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(G, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
  Object.defineProperty(G, 'db', {
    get: () => dbProxy(current),
    set: (value) => {
      if (value instanceof Database) current = value;
      else if (value && typeof value.getName === 'function') current = databaseOf(value.getName());
      else throw invalid('db can only be set to a database (db = db.getSiblingDB("name"))');
    },
    configurable: true,
    enumerable: false,
  });
  // Atomics.wait could block this thread where neither cancel nor the timeout reach it.
  if (G.Atomics) delete G.Atomics.wait;

  // --- Hooks for Rust ---------------------------------------------------------------------

  function shell(command, argument) {
    switch (command) {
      case 'use': {
        if (!argument) throw invalid('use needs a database name');
        current = databaseOf(argument);
        return `switched to db ${argument}`;
      }
      case 'show': {
        switch (argument) {
          case 'dbs':
          case 'databases': {
            const list = listDatabases();
            const width = Math.max(0, ...list.map((d) => d.name.length));
            return list.map((d) => `${d.name.padEnd(width)}  ${size(d.sizeOnDisk)}`).join('\n');
          }
          case 'collections':
          case 'tables':
            return current.getCollectionNames().join('\n');
          case 'users':
            return inspect(runCommandOn(current._name, { usersInfo: 1 }).users ?? []);
          case 'roles':
            return inspect(
              runCommandOn(current._name, { rolesInfo: 1, showBuiltinRoles: true }).roles ?? [],
            );
          default:
            throw unsupported(`show ${argument}`, 'show dbs / show collections');
        }
      }
      case 'it':
        throw unsupported('it', '#grid');
      default:
        throw unsupported(command);
    }
  }

  const isDocument = (value) =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;

  /** What the last expression shows: documents, a cursor to drain, or text. */
  function result(value) {
    let v = value;
    if (v !== null && typeof v === 'object' && typeof v[RESULT] === 'function') {
      const r = v[RESULT]();
      if (r.kind === 'cursor') return JSON.stringify(r);
      v = r.value;
    }
    if (v === undefined) return JSON.stringify({ kind: 'none' });
    if (isDocument(v))
      return JSON.stringify({ kind: 'documents', documents: [serialize(v, false)], single: true });
    if (Array.isArray(v) && v.length > 0 && v.every(isDocument)) {
      return JSON.stringify({
        kind: 'documents',
        documents: v.map((d) => serialize(d, false)),
        single: false,
      });
    }
    return JSON.stringify({ kind: 'text', text: show(v) });
  }

  return {
    shell,
    result,
    database: () => current._name,
    isError: (value) => value instanceof Error,
    describe: (value) =>
      value instanceof Error ? `${value.name}: ${value.message}` : `Uncaught ${inspect(value)}`,
    yadbeId: (value) =>
      value !== null && typeof value === 'object' && typeof value.__yadbe === 'number'
        ? value.__yadbe
        : -1,
  };
});

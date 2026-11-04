import { Errors } from "./errors.js";

const number = (x) => +x;
const bool = (x) => x === "t";
const json = (x) => JSON.parse(x);
const string = (x) => {
  if (x instanceof Date) {
    return serializeDate(x);
  }
  if (Array.isArray(x)) {
    return serializeArray(x, string);
  }
  if (literal(x)) {
    return JSON.stringify(x);
  }
  return `${x}`;
};
const literal = (x) =>
  x !== null &&
  typeof x === "object" &&
  (Object.getPrototypeOf(x) === Object.prototype ||
    Object.getPrototypeOf(x) === null);

// oxlint-disable-next-line unicorn/prefer-spread -- a type's from is one oid or name or an array of them: concat takes both, a spread only the array
const listOf = (from) => [].concat(from || []);

const arrays = {
  1033: 1034,
  1042: 1014,
  1043: 1015,
  1082: 1182,
  1083: 1183,
  1114: 1115,
  114: 199,
  1184: 1185,
  1186: 1187,
  1266: 1270,
  142: 143,
  1560: 1561,
  1562: 1563,
  16: 1000,
  17: 1001,
  1700: 1231,
  1790: 2201,
  18: 1002,
  19: 1003,
  20: 1016,
  21: 1005,
  22: 1006,
  2202: 2207,
  2203: 2208,
  2204: 2209,
  2205: 2210,
  2206: 2211,
  2249: 2287,
  2275: 1263,
  23: 1007,
  24: 1008,
  25: 1009,
  26: 1028,
  27: 1010,
  28: 1011,
  29: 1012,
  2950: 2951,
  2970: 2949,
  30: 1013,
  3220: 3221,
  3614: 3643,
  3615: 3645,
  3734: 3735,
  3769: 3770,
  3802: 3807,
  3904: 3905,
  3906: 3907,
  3908: 3909,
  3910: 3911,
  3912: 3913,
  3926: 3927,
  4072: 4073,
  4089: 4090,
  4096: 4097,
  5038: 5039,
  5069: 271,
  600: 1017,
  601: 1018,
  602: 1019,
  603: 1020,
  604: 1027,
  628: 629,
  650: 651,
  700: 1021,
  701: 1022,
  718: 719,
  774: 775,
  790: 791,
  829: 1040,
  869: 1041,
};

const serializeDate = (x) => {
  if (x === Infinity) {
    return "infinity";
  }
  if (x === -Infinity) {
    return "-infinity";
  }
  return (x instanceof Date ? x : new Date(x)).toISOString();
};

export const types = {
  boolean: {
    from: [16],
    parse: bool,
    serialize: (x) => (x === true ? "t" : "f"),
    to: 16,
  },
  bytea: {
    from: [17],
    parse: (x) => Buffer.from(x.slice(2), "hex"),
    serialize: (x) => `\\x${Buffer.from(x).toString("hex")}`,
    to: 17,
  },
  date: {
    from: [1082, 1114, 1184],
    parse: null,
    serialize: serializeDate,
    to: 1184,
  },
  json: {
    from: [114, 3802],
    parse: json,
    serialize: (x) => JSON.stringify(x),
    to: 114,
  },
  number: {
    from: [21, 23, 26, 700, 701],
    parse: number,
    serialize: string,
    to: 0,
  },
  string: { from: null, serialize: string, to: 25 },
};

const timestamp =
  /^(?<year>\d{4,})-(?<month>\d\d)-(?<day>\d\d)(?: (?<hour>\d\d):(?<minute>\d\d):(?<second>\d\d)(?:\.(?<fraction>\d+))?)?(?:(?<sign>[+-])(?<offsetHours>\d\d)(?::(?<offsetMinutes>\d\d))?(?::(?<offsetSeconds>\d\d))?)?(?<bc> BC)?$/u;

const parts = (x) => {
  const m = x.match(timestamp);
  if (!m) {
    return null;
  }

  const { groups } = m;
  const year = groups.bc ? 1 - groups.year : +groups.year;
  const ms = groups.fraction ? +`${groups.fraction}00`.slice(0, 3) : 0;
  const offset = groups.sign
    ? (groups.sign === "-" ? -1 : 1) *
      ((groups.offsetHours * 60 + +(groups.offsetMinutes || 0)) * 60 +
        +(groups.offsetSeconds || 0)) *
      1000
    : 0;

  return {
    day: +groups.day,
    hour: +(groups.hour || 0),
    minute: +(groups.minute || 0),
    month: groups.month - 1,
    ms,
    offset,
    second: +(groups.second || 0),
    year,
  };
};

const infinite = (x) => {
  if (x === "infinity") {
    return Infinity;
  }
  if (x === "-infinity") {
    return -Infinity;
  }
  return null;
};

const utc = (x) => {
  const date = new Date(
    Date.UTC(2000, x.month, x.day, x.hour, x.minute, x.second, x.ms)
  );
  date.setUTCFullYear(x.year);
  return date;
};

const plain = (x) => {
  const n = x.length;
  return (
    x.codePointAt(0) !== 48 &&
    x.codePointAt(n - 1) !== 67 &&
    !(x.codePointAt(n - 3) === 58 && x.codePointAt(n - 6) === 58) &&
    x.codePointAt(0) !== 45 &&
    x.codePointAt(0) !== 105
  );
};

const parseTimestamptz = (x) => {
  if (plain(x)) {
    return new Date(x);
  }

  const p = infinite(x) || parts(x);
  if (!p) {
    return new Date(x);
  }

  if (typeof p === "number") {
    return p;
  }

  const date = utc(p);
  date.setTime(date.getTime() - p.offset);
  return date;
};

const parseDate = (x) => {
  const p = infinite(x) || parts(x);
  if (!p) {
    return new Date(x);
  }
  if (typeof p === "number") {
    return p;
  }
  return utc(p);
};

const parseTimestamp = (x) => {
  const p = infinite(x) || parts(x);
  if (!p || typeof p === "number") {
    return p || new Date(x);
  }

  const date = new Date(2000, p.month, p.day, p.hour, p.minute, p.second, p.ms);
  date.setFullYear(p.year);
  return date;
};

const dates = { 1082: parseDate, 1114: parseTimestamp, 1184: parseTimestamptz };

const elementsOf = { 1000: 16, 1005: 21, 1007: 23, 1016: 20 };

const int32 = (x, i) =>
  (x[i] << 24) | (x[i + 1] << 16) | (x[i + 2] << 8) | x[i + 3];

const binaryArray = (read) => (x, i) => {
  const dims = int32(x, i);
  if (dims === 0) {
    return [];
  }

  const sizes = [];
  for (let d = 0; d < dims; d += 1) {
    sizes.push(int32(x, i + 12 + d * 8));
  }

  let at = i + 12 + dims * 8;

  const level = (d) => {
    const n = sizes[d];
    const xs = [];

    if (d < dims - 1) {
      for (let k = 0; k < n; k += 1) {
        xs.push(level(d + 1));
      }
      return xs;
    }

    for (let k = 0; k < n; k += 1) {
      const length = int32(x, at);
      at += 4;
      if (length === -1) {
        xs.push(null);
      } else {
        xs.push(read(x, at));
        at += length;
      }
    }
    return xs;
  };

  return level(0);
};

const readers = {
  16: binaryArray((x, i) => x[i] === 1),
  20: binaryArray((x, i) => x.readBigInt64BE(i).toString()),
  21: binaryArray((x, i) => ((x[i] << 24) | (x[i + 1] << 16)) >> 16),
  23: binaryArray(
    (x, i) => (x[i] << 24) | (x[i + 1] << 16) | (x[i + 2] << 8) | x[i + 3]
  ),
};

const bytes = (x, i, end) => Buffer.from(x.subarray(i, end));

const integer = (x, start, end) => {
  const negative = x[start] === 45;
  let n = 0;
  for (let i = negative ? start + 1 : start; i < end; i += 1) {
    n = n * 10 + x[i] - 48;
  }
  return negative ? -n : n;
};

const boolean = (x, i) => x[i] === 116;

const latin1 =
  typeof Buffer.prototype.latin1Slice === "function"
    ? (x, start, end) => x.latin1Slice(start, end)
    : (x, start, end) => x.toString("latin1", start, end);

const digits = (x, start, n) => {
  let v = 0;
  const end = start + n;
  for (let i = start; i < end; i += 1) {
    const d = x[i] - 48;
    if (d < 0 || d > 9) {
      return -1;
    }
    v = v * 10 + d;
  }
  return v;
};

// oxlint-disable-next-line complexity -- one pass over the bytes of each timestamp in the decoding hot path; helpers would add calls per value
const clock = (x, i, end, zoned) => {
  const year = digits(x, i, 4);
  if (year < 1000 || x[i + 4] !== 45 || x[i + 7] !== 45) {
    return Number.NaN;
  }

  const month = digits(x, i + 5, 2);
  const day = digits(x, i + 8, 2);

  if (end - i === 10) {
    return zoned || month < 1 || day < 1
      ? Number.NaN
      : Date.UTC(year, month - 1, day);
  }

  if (x[i + 10] !== 32 || x[i + 13] !== 58 || x[i + 16] !== 58) {
    return Number.NaN;
  }

  const hour = digits(x, i + 11, 2);
  const minute = digits(x, i + 14, 2);
  const second = digits(x, i + 17, 2);

  let at = i + 19;
  let ms = 0;

  if (x[at] === 46) {
    let scale = 100;
    for (at += 1; at < end && x[at] >= 48 && x[at] <= 57; at += 1) {
      ms += (x[at] - 48) * scale;
      scale = Math.trunc(scale / 10);
    }
  }

  let offset = 0;
  if (zoned) {
    const sign = x[at];
    if (
      (sign !== 43 && sign !== 45) ||
      (end - at !== 3 && (end - at !== 6 || x[at + 3] !== 58))
    ) {
      return Number.NaN;
    }
    offset =
      digits(x, at + 1, 2) * 60 + (end - at === 6 ? digits(x, at + 4, 2) : 0);
    if (
      offset < 0 ||
      digits(x, at + 1, 2) < 0 ||
      (end - at === 6 && digits(x, at + 4, 2) < 0)
    ) {
      return Number.NaN;
    }
    if (sign === 45) {
      offset = -offset;
    }
    at = end;
  }

  if (
    at !== end ||
    month < 1 ||
    day < 1 ||
    hour < 0 ||
    minute < 0 ||
    second < 0
  ) {
    return Number.NaN;
  }

  return (
    Date.UTC(year, month - 1, day, hour, minute, second, ms) - offset * 60_000
  );
};

const timestamptz = (x, i, end) => {
  const t = clock(x, i, end, true);
  return Number.isNaN(t) ? parseTimestamptz(latin1(x, i, end)) : new Date(t);
};

const utcStamp = (x, i, end) => {
  const t = clock(x, i, end, false);
  return Number.isNaN(t) ? parseDate(latin1(x, i, end)) : new Date(t);
};

const shaped = (is, serialize) => (x) => (is(x) ? serialize(x) : string(x));

const shapedTypes = {
  ...types,
  boolean: {
    ...types.boolean,
    serialize: shaped((x) => typeof x === "boolean", types.boolean.serialize),
  },
  bytea: {
    ...types.bytea,
    serialize: shaped((x) => x instanceof Uint8Array, types.bytea.serialize),
  },
  date: {
    ...types.date,
    serialize: shaped((x) => x instanceof Date, types.date.serialize),
  },
};

const decoder = (oid, parse) => {
  if (parse === number && (oid === 21 || oid === 23 || oid === 26)) {
    return integer;
  }
  if (parse === bool && oid === 16) {
    return boolean;
  }
  if (parse === parseTimestamptz && oid === 1184) {
    return timestamptz;
  }
  if (parse === parseDate && (oid === 1114 || oid === 1082)) {
    return utcStamp;
  }
  return null;
};

export const Types = (options = {}) => {
  const parsers = {};
  const serializers = {};
  const elements = {};
  const undefinedValue = options.transform && options.transform.undefined;

  const register = (xs) => {
    for (const x of Object.values(xs)) {
      const from = listOf(x.from);
      if (x.parse) {
        for (const oid of from) {
          parsers[oid] = x.parse;
        }
      }
      if (x.serialize) {
        serializers[x.to] = x.serialize;
        for (const oid of from) {
          serializers[oid] = x.serialize;
        }
      }
    }
  };

  for (const [oid, array] of Object.entries(arrays)) {
    elements[array] = [+oid, +oid === 603 ? ";" : ","];
  }
  register(options.infer === false ? shapedTypes : types);
  Object.assign(parsers, dates);
  if (options.infer === false) {
    parsers[1114] = parseDate;
  }
  const custom = Object.values(options.types || {});
  const named = custom.filter((x) =>
    [x.to, ...listOf(x.from)].some((y) => typeof y === "string")
  );
  const oids = {};
  const own = new Set();

  register(custom.filter((x) => !named.includes(x)));
  for (const x of custom) {
    for (const oid of [x.to, ...listOf(x.from)]) {
      own.add(oid);
    }
  }

  const keys =
    options.transform && options.transform.json && options.transform.column.to;
  if (keys) {
    for (const oid of [114, 3802]) {
      if (!own.has(oid)) {
        serializers[oid] = renamed(serializers[oid], keys);
      }
    }
  }

  const bases = {};

  const binary = (oid) => {
    if (own.has(oid)) {
      return null;
    }

    if (oid === 17) {
      return parsers[17] === types.bytea.parse ? bytes : null;
    }

    const element = elementsOf[oid];
    return element !== undefined &&
      !own.has(element) &&
      (element !== 20 || !(20 in parsers))
      ? readers[element]
      : null;
  };

  const unknown = (list) => {
    for (const oid of list) {
      if (
        oid >= 16_384 &&
        !(oid in parsers) &&
        !(oid in serializers) &&
        !(oid in elements) &&
        !(oid in bases)
      ) {
        return true;
      }
    }
    return false;
  };

  const known = (oid) => oid in serializers || oid in elements;

  const resolve = (type) => (typeof type === "string" ? oids[type] || 0 : type);

  const parser = (oid) => {
    if (oid in parsers) {
      return parsers[oid];
    }

    if (oid in bases) {
      return (parsers[oid] = parser(bases[oid]));
    }

    if (oid in elements) {
      const [element, delimiter] = elements[oid];
      const parse = parser(element);
      return (parsers[oid] = (x) =>
        parseArray(x, parse === identity ? null : parse, delimiter));
    }

    return identity;
  };

  const serializer = (oid) => {
    if (oid in serializers) {
      return serializers[oid];
    }

    if (oid in bases) {
      return (serializers[oid] = serializer(bases[oid]));
    }

    if (oid in elements) {
      const [element, delimiter] = elements[oid];
      const serialize = serializer(element);
      return (serializers[oid] = (xs) =>
        Array.isArray(xs)
          ? serializeArray(xs, serialize, delimiter, undefinedValue)
          : serialize(xs));
    }

    return string;
  };

  const names = async (run) => {
    const wanted = [
      ...new Set(
        named
          .flatMap((x) => [x.to, ...listOf(x.from)])
          .filter((x) => typeof x === "string")
      ),
    ];
    const list = wanted
      .map((x) => `'${x.split(".").pop().replaceAll("'", "''")}'`)
      .join(",");
    const rows = await run(
      `select t.oid::int, t.typarray::int as array, t.typdelim as delimiter, t.typname as name, n.nspname as schema, ` +
        `pg_catalog.pg_type_is_visible(t.oid) as visible from pg_catalog.pg_type t ` +
        `join pg_catalog.pg_namespace n on n.oid = t.typnamespace where t.typname in (${
          list
        })`
    );
    const missing = [];
    for (const x of wanted) {
      const [schema, name] = x.includes(".") ? x.split(".") : [null, x];
      const row = rows.find(
        (r) => r.name === name && (schema ? r.schema === schema : r.visible)
      );
      if (row) {
        oids[x] = row.oid;
        if (row.array && !(row.array in elements)) {
          elements[row.array] = [row.oid, row.delimiter];
        }
      } else {
        missing.push(x);
      }
    }
    if (missing.length) {
      throw Errors.generic(
        "TYPE_NOT_FOUND",
        missing.length > 1
          ? `The types ${missing.join(", ")} do not exist`
          : `The type ${missing[0]} does not exist`
      );
    }
    register(
      named.map((x) => ({
        ...x,
        from: listOf(x.from).map(resolve),
        to: resolve(x.to),
      }))
    );
    for (const x of named) {
      for (const y of [x.to, ...listOf(x.from)]) {
        own.add(resolve(y));
      }
    }
  };

  const learn = (rows) => {
    for (const { oid, element, delimiter, base, kind } of rows) {
      if (oid in parsers || oid in serializers) {
        continue;
      }
      if (kind === "d") {
        bases[oid] = base;
      } else if (element && !(oid in elements)) {
        elements[oid] = [element, delimiter];
      }
    }
  };

  const fetched = (run) =>
    run(
      "select oid::int, typelem::int as element, typdelim as delimiter, typbasetype::int as base, typtype as kind " +
        "from pg_catalog.pg_type where typtype = 'd' or (typcategory = 'A' and oid >= 16384)"
    ).then(learn);

  const load = (run) => Promise.all([fetched(run), named.length && names(run)]);

  return {
    binary,
    decoder,
    infer,
    known,
    load,
    named: named.length > 0,
    parser,
    parsers,
    plain: !custom.some((x) => x.serialize),
    resolve,
    serializer,
    serializers,
    unknown,
  };
};

const identity = (x) => x;
identity.identity = true;

// oxlint-disable-next-line typescript/no-extraneous-class -- public: users wrap values in it and the serializer tests instanceof Parameter
export class Parameter {
  constructor(value, type) {
    this.value = value;
    this.type = type;
  }
}

export const infer = (x) => {
  if (x instanceof Parameter) {
    return x.type;
  }
  if (x instanceof Date) {
    return 1184;
  }
  if (x instanceof Uint8Array) {
    return 17;
  }
  if (x === true || x === false) {
    return 16;
  }
  if (typeof x === "bigint") {
    return 20;
  }
  if (Array.isArray(x)) {
    return arrays[infer(x[0])] || 0;
  }
  return 0;
};

export const parseArray = (x, parse, delimiter = ",") => {
  let i = x[0] === "[" ? x.indexOf("=") + 1 : 0;

  const level = () => {
    const xs = [];
    i += 1;
    while (i < x.length && x[i] !== "}") {
      if (x[i] === "{") {
        xs.push(level());
      } else if (x[i] === '"') {
        let s = "";
        for (i += 1; x[i] !== '"'; i += 1) {
          if (x[i] === "\\") {
            i += 1;
          }
          s += x[i];
        }
        i += 1;
        xs.push(parse ? parse(s) : s);
      } else {
        const start = i;
        while (x[i] !== delimiter && x[i] !== "}") {
          i += 1;
        }
        const s = x.slice(start, i);
        if (s === "NULL") {
          xs.push(null);
        } else {
          xs.push(parse ? parse(s) : s);
        }
      }
      if (x[i] === delimiter) {
        i += 1;
      }
    }
    i += 1;
    return xs;
  };

  return level();
};

export const serializeArray = (xs, serialize, delimiter, undefinedValue) => {
  // Defaults applied here, as default parameters would: undefinedValue comes after them.
  const serializeItem = serialize === undefined ? string : serialize;
  const separator = delimiter === undefined ? "," : delimiter;
  return `{${xs
    .map((item) => {
      const typed = item instanceof Parameter;
      let x = typed ? item.value : item;
      if (x === undefined) {
        x = undefinedValue;
      }
      if (x === undefined) {
        throw Errors.generic(
          "UNDEFINED_VALUE",
          "Undefined values are not allowed"
        );
      }
      if (Array.isArray(x) && !typed) {
        return serializeArray(x, serializeItem, separator, undefinedValue);
      }
      if (x === null) {
        return "NULL";
      }
      return `"${`${serializeItem(x)}`.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    })
    .join(separator)}}`;
};

export const toCamel = (x) => {
  let str = x.at(0);
  for (let i = 1; i < x.length; i += 1) {
    if (x[i] === "_") {
      i += 1;
      str += x[i].toUpperCase();
    } else {
      str += x[i];
    }
  }
  return str;
};

export const toPascal = (x) => {
  let str = x[0].toUpperCase();
  for (let i = 1; i < x.length; i += 1) {
    if (x[i] === "_") {
      i += 1;
      str += x[i].toUpperCase();
    } else {
      str += x[i];
    }
  }
  return str;
};

export const toKebab = (x) => x.replaceAll("_", "-");

export const fromCamel = (x) => x.replaceAll(/[A-Z]/gu, "_$&").toLowerCase();
export const fromPascal = (x) =>
  (x.slice(0, 1) + x.slice(1).replaceAll(/[A-Z]/gu, "_$&")).toLowerCase();
export const fromKebab = (x) => x.replaceAll("-", "_");

const rename = (x, fn) => {
  if (Array.isArray(x)) {
    return x.map((item) => rename(item, fn));
  }

  if (
    x === null ||
    typeof x !== "object" ||
    (Object.getPrototypeOf(x) !== Object.prototype &&
      Object.getPrototypeOf(x) !== null)
  ) {
    return x;
  }

  const out = {};
  for (const k in x) {
    if (Object.hasOwn(x, k)) {
      Object.defineProperty(out, fn(k), {
        configurable: true,
        enumerable: true,
        value: rename(x[k], fn),
        writable: true,
      });
    }
  }
  return out;
};

const renamed = (serialize, fn) => (x) => serialize(rename(x, fn));

const createJsonTransform = (fn) => {
  const jsonTransform = (x, column) => {
    if (
      typeof x !== "object" ||
      x === null ||
      (column.type !== 114 && column.type !== 3802)
    ) {
      return x;
    }
    if (Array.isArray(x)) {
      return x.map((item) => jsonTransform(item, column));
    }
    // Object.assign, not fromEntries: a key renamed to __proto__ goes through its setter as before.
    const out = {};
    for (const [k, v] of Object.entries(x)) {
      Object.assign(out, { [fn(k)]: jsonTransform(v, column) });
    }
    return out;
  };
  jsonTransform.keys = true;
  return jsonTransform;
};

toCamel.column = { from: toCamel };
toCamel.value = { from: createJsonTransform(toCamel) };
fromCamel.column = { to: fromCamel };

export const camel = { ...toCamel };
camel.column.to = fromCamel;

toPascal.column = { from: toPascal };
toPascal.value = { from: createJsonTransform(toPascal) };
fromPascal.column = { to: fromPascal };

export const pascal = { ...toPascal };
pascal.column.to = fromPascal;

toKebab.column = { from: toKebab };
toKebab.value = { from: createJsonTransform(toKebab) };
fromKebab.column = { to: fromKebab };

export const kebab = { ...toKebab };
kebab.column.to = fromKebab;

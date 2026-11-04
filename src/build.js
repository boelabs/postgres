// oxlint-disable-next-line max-classes-per-file -- the kinds of interpolated value are classes that instanceof tells apart
import { Errors } from "./errors.js";
import { Parameter, infer } from "./types.js";

export const isQuery = Symbol("query");

class NotTagged {
  // oxlint-disable-next-line class-methods-use-this, unicorn/no-thenable -- awaiting a helper by mistake must throw, not hang
  then() {
    notTagged();
  }
  // oxlint-disable-next-line class-methods-use-this -- as then(): calling it by mistake must throw
  catch() {
    notTagged();
  }
  // oxlint-disable-next-line class-methods-use-this -- as then(): calling it by mistake must throw
  finally() {
    notTagged();
  }
}

export class Identifier extends NotTagged {
  constructor(name) {
    super();
    this.value = escapeIdentifier(name);
  }
}

// oxlint-disable-next-line typescript/no-extraneous-class -- part() tells a join apart with instanceof
export class Join {
  constructor(separator, items) {
    this.separator = separator;
    this.items = items;
  }
}

export const joinStrings = Object.assign(["", ""], { raw: ["", ""] });

export class Builder extends NotTagged {
  constructor(first, rest) {
    super();
    this.first = first;
    this.rest = rest;
  }
}

export const build = (query, options) => {
  const parameters = [];
  const oids = [];
  const o = {
    dynamic: !query.tagged,
    infer: options.infer !== false,
    oids,
    resolve: options.resolve,
    transform: options.transform,
    values: parameters,
  };

  let text;
  if (query.tagged) {
    text = stringify(query, o);
  } else {
    for (const x of query.args) {
      value(x, o);
    }
    text = `${query.strings[0]}`;
  }

  if (parameters.length >= 65_534) {
    throw Errors.generic(
      "MAX_PARAMETERS_EXCEEDED",
      "Max number of parameters (65534) exceeded"
    );
  }

  const types = oids.join(",");
  return {
    dynamic: o.dynamic,
    oids,
    strings: query.strings,
    text,
    types,
    values: parameters,
  };
};

const stringify = (q, o) => {
  let [string] = q.strings;

  for (let i = 1; i < q.strings.length; i += 1) {
    string += part(string, q.args[i - 1], o, q.strings[i]) + q.strings[i];
  }

  return string;
};

const part = (before, x, o, after = "") => {
  if (
    x instanceof Builder ||
    x instanceof Identifier ||
    isFragment(x) ||
    (Array.isArray(x) && isFragment(x[0]))
  ) {
    o.dynamic = true;
  }

  if (isFragment(x) && x.strings === joinStrings) {
    return joined(x.args[0], o, before, after);
  }
  if (x instanceof Join) {
    return joined(x, o, "", "");
  }
  if (x instanceof Builder) {
    return helper(before, x, o);
  }
  if (isFragment(x)) {
    return fragment(x, o);
  }
  if (x instanceof Identifier) {
    return x.value;
  }
  if (Array.isArray(x) && isFragment(x[0])) {
    let text = "";
    for (const item of x) {
      text = `${text} ${fragment(item, o)}`;
    }
    return text;
  }
  return value(x, o);
};

const joined = (join, o, before, after) => {
  let text = "";
  for (const [i, item] of join.items.entries()) {
    if (i > 0) {
      text = spaced(text, fragment(join.separator, o));
    }
    text = spaced(text, part("", item, o));
  }
  if (before && text && !/\s$/u.test(before) && !/^\s/u.test(text)) {
    text = ` ${text}`;
  }
  if (after && text && !/^\s/u.test(after) && !/\s$/u.test(text)) {
    text += " ";
  }
  return text;
};

const spaced = (a, b) =>
  a && b && !/\s$/u.test(a) && !/^\s/u.test(b) ? `${a} ${b}` : a + b;

const isFragment = (x) => !!x && x[isQuery] === true;

const fragment = (q, o) => (q.tagged ? stringify(q, o) : q.strings[0]);

export const value = (input, o) => {
  let x = input;
  let v = x instanceof Parameter ? x.value : x;
  if (v === undefined) {
    v = o.transform.undefined;
    if (v === undefined) {
      throw Errors.generic(
        "UNDEFINED_VALUE",
        "Undefined values are not allowed"
      );
    }
    if (!(x instanceof Parameter)) {
      x = v;
    }
  }
  o.values.push(v);
  let oid = 0;
  if (x instanceof Parameter) {
    oid = o.resolve(x.type);
  } else if (o.infer) {
    oid = infer(x);
  }
  o.oids.push(oid);
  return `$${o.values.length}`;
};

const call = (first, rest, o) => {
  if (
    first === null ||
    typeof first !== "object" ||
    Array.isArray(first) ||
    isFragment(first)
  ) {
    return select(first, rest, o);
  }

  return columns(first, rest)
    .map(
      (x) =>
        `${escapeIdentifier(column(x, o))} => ${part("values", first[x], o)}`
    )
    .join(",");
};

const clauses = {
  distinct: "select",
  in: "in",
  returning: "select",
  select: "select",
  set: "update",
  values: "values",
};
const stops = new Set([
  "from",
  "where",
  "on",
  "to",
  "join",
  "group",
  "order",
  "by",
  "having",
  "limit",
  "offset",
  "union",
  "intersect",
  "except",
  "using",
  "and",
  "or",
  "when",
  "then",
  "else",
  "with",
  "table",
  "grant",
  "revoke",
  "delete",
  "update",
  "case",
  "not",
  "like",
  "ilike",
  "between",
  "is",
  "exists",
  "conflict",
  "do",
  "nothing",
  "window",
  "over",
  "partition",
  "filter",
  "lateral",
  "cross",
  "inner",
  "left",
  "right",
  "full",
  "outer",
  "natural",
  "into",
]);

const helper = (before, x, o) => {
  const kind = context(before);
  return kind
    ? builders[kind](x.first, x.rest, o)
    : identifiers(
        typeof x.first === "string" ? [x.first, ...x.rest] : x.first,
        o
      );
};

// What a parenthesis right after word opens: an in or values list, a call's named arguments, or
// a select list.
const opened = (word) => {
  if (word === "in" || word === "values") {
    return word;
  }
  return word && !clauses[word] && !stops.has(word) ? "call" : "select";
};

// The index just before the quoted name or string whose closing quote c is at end; a doubled quote
// inside it is part of it.
const quoted = (sql, end, c) => {
  let i = end - 1;
  while (i >= 0 && !(sql[i] === c && sql[i - 1] !== c)) {
    i -= sql[i] === c ? 2 : 1;
  }
  return i - 1;
};

// The index just before the word, schema qualified or not, whose last character is at end.
const wordStart = (sql, end) => {
  let i = end;
  while (i >= 0 && /[\w$.]/u.test(sql[i])) {
    i -= 1;
  }
  return i;
};

const context = (sql) => {
  const words = [];

  let i = sql.length - 1;
  let depth = 0;

  while (i >= 0) {
    const c = sql[i];
    if (c === ")") {
      depth += 1;
      i -= 1;
    } else if (c === "(") {
      if (depth === 0) {
        const word = previous(sql, i - 1);
        return words.length === 0 ? opened(word) : "select";
      }
      depth -= 1;
      i -= 1;
    } else if (c === "'" || c === '"') {
      const end = i;
      i = quoted(sql, end, c);
      if (sql[i] === ".") {
        i -= 1;
      } else if (depth === 0 && c === '"') {
        words.push(sql.slice(i + 1, end + 1));
      }
    } else if (/[\w$]/u.test(c)) {
      const end = i + 1;
      i = wordStart(sql, i);
      const word = depth === 0 && sql.slice(i + 1, end).toLowerCase();
      if (word && clauses[word]) {
        return clauses[word];
      }
      if (word === "into") {
        return insert_into(words, sql, i) ? "insert" : null;
      }
      if (word && stops.has(word)) {
        return null;
      }
      if (word) {
        words.push(word);
      }
    } else {
      i -= 1;
    }
  }
  return null;
};

const previous = (sql, from) => {
  let i = from;
  while (i >= 0 && /\s/u.test(sql[i])) {
    i -= 1;
  }

  if (sql[i] === '"') {
    return '"';
  }

  const end = i + 1;
  i = wordStart(sql, i);

  return sql.slice(i + 1, end).toLowerCase();
};

const insert_into = (words, sql, i) => {
  const target =
    words.length === 1 || (words.length === 3 && words[1] === "as");
  return target && previous(sql, i) === "insert";
};

const valuesBuilder = (first, picked, o) =>
  first
    .map((row) => `(${picked.map((x) => part("values", row[x], o)).join(",")})`)
    .join(",");

const values = (first, rest, o) => {
  const rows =
    Array.isArray(first) &&
    first.length > 0 &&
    first[0] !== null &&
    typeof first[0] === "object" &&
    !isFragment(first[0]);
  const picked = columns(rows ? first[0] : first, rest);

  return valuesBuilder(rows ? first : [first], picked, o);
};

const update = (first, rest, o) => {
  const picked = columns(first, rest);
  if (!picked.length) {
    empty("update");
  }

  return picked.map(
    (x) => `${escapeIdentifier(column(x, o))}=${part("values", first[x], o)}`
  );
};

const insert = (first, rest, o) => {
  if (Array.isArray(first) && first.every((x) => typeof x === "string")) {
    return `(${escapeIdentifiers([...first, ...rest.flat()], o)})`;
  }

  const picked = columns(Array.isArray(first) ? first[0] || {} : first, rest);
  if (!picked.length) {
    empty("insert");
  }

  return `(${escapeIdentifiers(picked, o)})values${valuesBuilder(
    Array.isArray(first) ? first : [first],
    picked,
    o
  )}`;
};

const columns = (first, rest) =>
  rest.length ? rest.flat() : Object.keys(first);

const empty = (x) => {
  throw Errors.generic("NO_COLUMNS", `The ${x} helper got no columns`);
};

const identifiers = (first, o) =>
  Array.isArray(first)
    ? first.map((x) => member(x, o)).join(",")
    : member(first, o);

const member = (x, o) => {
  if (isFragment(x)) {
    return fragment(x, o);
  }
  if (x instanceof Identifier) {
    return x.value;
  }
  return escapeIdentifier(column(x, o));
};

// A selected value: a fragment or an identifier as it is, anything else as a parameter.
const selected = (v, o) => {
  if (isFragment(v)) {
    return fragment(v, o);
  }
  if (v instanceof Identifier) {
    return v.value;
  }
  return value(v, o);
};

const select = (first, rest, o) => {
  const picked = typeof first === "string" ? [first, ...rest] : first;
  if (Array.isArray(picked)) {
    return identifiers(picked, o);
  }

  return columns(picked, rest)
    .map(
      (x) => `${selected(picked[x], o)} as ${escapeIdentifier(column(x, o))}`
    )
    .join(",");
};

// After the helpers it names: an object literal reads them when the module loads.
const builders = {
  call,
  in: (...xs) => {
    const x = values(...xs);
    return x === "()" ? "(null)" : x;
  },
  insert,
  select,
  update,
  values,
};

const column = (x, o) => (o.transform.column.to ? o.transform.column.to(x) : x);

const escapeIdentifiers = (xs, o) =>
  xs.map((x) => escapeIdentifier(column(x, o))).join(",");

export const escapeIdentifier = (x) =>
  `"${x.replaceAll('"', '""').replaceAll(".", '"."')}"`;

export const notTagged = () => {
  throw Errors.generic(
    "NOT_TAGGED_CALL",
    "Query not called as a tagged template literal"
  );
};

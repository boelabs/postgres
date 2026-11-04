export const Writer = (size = 16_384) => {
  let b = Buffer.allocUnsafe(size);
  let i = 0;
  let at = 0;

  const fit = (n) => {
    if (b.length - i >= n) {
      return;
    }

    const prev = b;
    b = Buffer.allocUnsafe(Math.max(size, prev.length * 2, i + n));
    prev.copy(b, 0, 0, i);
  };

  const w = {
    bytes(x) {
      if (typeof x === "string") {
        fit(x.length * 3);
        i += b.write(x, i);
      } else {
        fit(x.length);
        b.set(x, i);
        i += x.length;
      }
      return w;
    },
    end() {
      b.writeInt32BE(i - at - 1, at + 1);
      return w;
    },
    endUntyped() {
      b.writeInt32BE(i - at, at);
      return w;
    },
    i16(x) {
      fit(2);
      b.writeInt16BE(x, i);
      i += 2;
      return w;
    },
    i32(x) {
      fit(4);
      b.writeInt32BE(x, i);
      i += 4;
      return w;
    },
    get length() {
      return i;
    },
    str(x) {
      fit(x.length * 3 + 1);
      i += b.write(x, i);
      b[i] = 0;
      i += 1;
      return w;
    },
    take() {
      const out = i < 4096 ? Buffer.from(b.subarray(0, i)) : b.subarray(0, i);
      if (i >= 4096) {
        b = Buffer.allocUnsafe(size);
      }
      at = 0;
      i = 0;
      return out;
    },
    truncate(n) {
      i = n;
      return w;
    },
    type(x) {
      fit(5);
      at = i;
      b[i] = x;
      i += 5;
      return w;
    },
    u16(x) {
      fit(2);
      b.writeUInt16BE(x, i);
      i += 2;
      return w;
    },
    u8(x) {
      fit(1);
      b[i] = x;
      i += 1;
      return w;
    },
    untyped() {
      fit(4);
      at = i;
      i += 4;
      return w;
    },
    value(x) {
      if (x === null || x === undefined) {
        return w.i32(-1);
      }
      const n = i;
      i += 4;
      w.bytes(x);
      b.writeInt32BE(i - n - 4, n);
      return w;
    },
  };

  return w;
};

const own = Writer(1024);

const S = 83;
const H = 72;
const X = 88;
const c = 99;
const Q = 81;
const p = 112;
const d = 100;
const f = 102;
const D = 68;
const C = 67;
const E = 69;
const P = 80;
const B = 66;

export const sync = (w) => w.type(S).end();
export const flush = (w) => w.type(H).end();
export const terminate = (w) => w.type(X).end();
export const copyDone = (w) => w.type(c).end();
export const sslRequest = (w) => w.untyped().i32(80_877_103).endUntyped();
export const query = (w, text) => w.type(Q).str(text).end();
export const password = (w, x) => w.type(p).str(x).end();
export const saslResponse = (w, x) => w.type(p).bytes(x).end();
export const copyData = (w, x) => w.type(d).bytes(x).end();
export const copyFail = (w, x) => w.type(f).str(x).end();
export const describe = (w, kind, name) =>
  w.type(D).u8(kind.codePointAt(0)).str(name).end();
export const close = (w, kind, name) =>
  w.type(C).u8(kind.codePointAt(0)).str(name).end();
export const execute = (w, portal, rows = 0) =>
  w.type(E).str(portal).i32(rows).end();
export const cancel = (w, pid, secret) =>
  w.untyped().i32(80_877_102).i32(pid).i32(secret).endUntyped();

const unbroken = (k, x) => {
  if (x.includes("\0")) {
    throw Object.assign(
      new Error(`The connection parameter ${k} contains a NUL character`),
      { code: "NUL_CHARACTER" }
    );
  }

  return x;
};

export const startup = (w, parameters) => {
  w.untyped().i32(196_608);
  for (const k of Object.keys(parameters)) {
    if (parameters[k]) {
      w.str(unbroken(k, k)).str(unbroken(k, `${parameters[k]}`));
    }
  }

  return w.u8(0).endUntyped();
};

export const sasl = (w, mechanism, initial) =>
  w.type(p).str(mechanism).i32(Buffer.byteLength(initial)).bytes(initial).end();

export const parse = (w, name, text, oids = []) => {
  w.type(P).str(name).str(text).u16(oids.length);
  for (const oid of oids) {
    // oxlint-disable-next-line unicorn/prefer-math-trunc -- ToInt32: an oid above 2^31 must wrap to the signed value the wire takes
    w.i32(oid | 0);
  }

  return w.end();
};

export const bind = (
  w,
  portal,
  name,
  values = [],
  formats = [],
  resultFormats = []
) => {
  w.type(B).str(portal).str(name).i16(formats.length);
  for (const format of formats) {
    w.i16(format);
  }

  w.u16(values.length);
  for (const x of values) {
    w.value(x);
  }

  w.i16(resultFormats.length);
  for (const format of resultFormats) {
    w.i16(format);
  }

  return w.end();
};

export const run = (w, portal, name, values, rows, flushing, formats) => {
  bind(w, portal, name, values, undefined, formats || undefined);
  execute(w, portal, rows);
  return flushing ? flush(w) : sync(w);
};

const one =
  (fn) =>
  (...xs) => {
    try {
      fn(own, ...xs);
    } catch (writeError) {
      own.truncate(0);
      throw writeError;
    }
    return own.take();
  };

export const Sync = one(sync);
export const Flush = one(flush);
export const Terminate = one(terminate);
export const CopyDone = one(copyDone);
export const SSLRequest = one(sslRequest);
export const Query = one(query);
export const Password = one(password);
export const SASLResponse = one(saslResponse);
export const CopyData = one(copyData);
export const CopyFail = one(copyFail);
export const Describe = one(describe);
export const Close = one(close);
export const Execute = one(execute);
export const Cancel = one(cancel);
export const Startup = one(startup);
export const SASL = one(sasl);
export const Parse = one(parse);
export const Bind = one(bind);
export const Run = one(run);

const largest = 0x40_00_00_00;

export const Frames = (onframe, shared = false, onerror = null) => {
  const chunks = [];
  const owned = new WeakSet();

  let data = null;
  let owning = false;
  let at = 0;
  let part = null;
  let filled = 0;
  let paused = false;
  let running = false;
  let broken = false;

  const keep = (x) => {
    const copy = Buffer.from(x);
    owned.add(copy);
    return copy;
  };

  const settle = () => {
    if (!shared) {
      return;
    }

    if (data && at < data.length && !owned.has(data)) {
      data = keep(data.subarray(at));
      at = 0;
    }
    for (let i = 0; i < chunks.length; i += 1) {
      if (!owned.has(chunks[i])) {
        chunks[i] = keep(chunks[i]);
      }
    }
  };

  const consume = () => {
    if (running) {
      return;
    }

    running = true;
    try {
      while (true) {
        if (broken || paused || !((data && at < data.length) || nextChunk())) {
          break;
        }
        if (part) {
          fill();
        } else {
          frame();
        }
      }
    } finally {
      running = false;
    }
  };

  const invalid = (length) => {
    if (length >= 4 && length <= largest) {
      return false;
    }

    broken = true;
    chunks.length = 0;
    part = null;
    data = null;
    filled = 0;
    at = 0;
    const lengthError = Object.assign(
      new Error(`The server sent a message with an invalid length (${length})`),
      { code: "PROTOCOL_ERROR" }
    );
    if (onerror) {
      onerror(lengthError);
    }
    return true;
  };

  const nextChunk = () => {
    data = chunks.shift() || null;
    at = 0;
    return data !== null;
  };

  const frame = () => {
    const left = data.length - at;
    if (left < 5) {
      return start(5);
    }

    const length = data.readInt32BE(at + 1);
    if (invalid(length)) {
      return;
    }

    const end = at + 1 + length;
    if (end > data.length) {
      return start(end - at);
    }

    const begin = at;
    at = end;
    onframe(data[begin], data, begin, end);
  };

  const start = (length) => {
    part = Buffer.allocUnsafe(length);
    if (shared) {
      owned.add(part);
    }
    filled = data.copy(part, 0, at);
    at = data.length;
  };

  const fill = () => {
    const n = data.copy(part, filled, at, at + part.length - filled);
    filled += n;
    at += n;
    if (filled < part.length) {
      return;
    }

    if (part.length === 5) {
      const head = part;
      const length = head.readInt32BE(1);
      if (invalid(length)) {
        return;
      }

      part = Buffer.allocUnsafe(1 + length);
      if (shared) {
        owned.add(part);
      }
      filled = head.copy(part);
      if (filled === part.length) {
        done();
      }
      return;
    }
    done();
  };

  const done = () => {
    const x = part;
    part = null;
    onframe(x[0], x, 0, x.length);
  };

  return {
    own(x) {
      owning = x;
      if (x) {
        settle();
      }
    },
    owns(x) {
      return !shared || owned.has(x);
    },
    pause() {
      paused = true;
      settle();
    },
    get paused() {
      return paused;
    },
    push(x) {
      if (broken) {
        return;
      }

      chunks.push(shared && (paused || owning) ? keep(x) : x);
      consume();
    },
    resume() {
      paused = false;
      consume();
    },
  };
};

const errorFields = {
  100: "data_type_name",
  110: "constraint_name",
  112: "internal_position",
  113: "internal_query",
  115: "schema_name",
  116: "table_name",
  67: "code",
  68: "detail",
  70: "file",
  72: "hint",
  76: "line",
  77: "message",
  80: "position",
  82: "routine",
  83: "severity_local",
  86: "severity",
  87: "where",
  99: "column_name",
};

export const error = (x, start, end) => {
  const fields = {};
  for (let i = start + 5; i < end - 1;) {
    const zero = x.indexOf(0, i + 1);
    fields[errorFields[x[i]] || String.fromCodePoint(x[i])] = x.toString(
      "utf-8",
      i + 1,
      zero
    );
    i = zero + 1;
  }
  // The non-localized V field is optional: some servers and poolers send only S.
  fields.severity ||= fields.severity_local;
  return fields;
};

export const text =
  typeof Buffer.prototype.utf8Slice === "function"
    ? (x, start, end) => x.utf8Slice(start, end)
    : (x, start, end) => x.toString("utf-8", start, end);

const u32 = (x, i) =>
  ((x[i] << 24) | (x[i + 1] << 16) | (x[i + 2] << 8) | x[i + 3]) >>> 0;
const u16 = (x, i) => (x[i] << 8) | x[i + 1];
const field = (name, table, number, type) => ({ name, number, table, type });

export const rowDescription = (x, start, end, make = field) => {
  const count = (x[start + 5] << 8) | x[start + 6];
  const columns = [];
  for (let i = start + 7, j = 0; j < count; j += 1) {
    let zero = i;
    while (x[zero] !== 0) {
      zero += 1;
    }
    columns.push(
      make(
        text(x, i, zero),
        u32(x, zero + 1),
        u16(x, zero + 5),
        u32(x, zero + 7)
      )
    );
    i = zero + 19;
  }
  return columns;
};

export const parameterDescription = (x, start) => {
  const count = x.readUInt16BE(start + 5);
  const oids = [];
  for (let j = 0; j < count; j += 1) {
    oids.push(x.readUInt32BE(start + 7 + j * 4));
  }

  return oids;
};

export const commandComplete = (x, start, end) => {
  const first = start + 5;

  let e = end - 1;
  let count = null;

  while (true) {
    let s = e - 1;
    while (s >= first && x[s] >= 48 && x[s] <= 57) {
      s -= 1;
    }
    if (s === e - 1 || s < first || x[s] !== 32) {
      break;
    }
    if (count === null) {
      count = +text(x, s + 1, e);
    }
    e = s;
  }

  return { command: text(x, first, e), count };
};

// oxlint-disable-next-line unicorn/prefer-code-point -- past the end of a short message the byte is undefined, which fromCharCode reads as 0 and fromCodePoint throws on
export const readyForQuery = (x, start) => String.fromCharCode(x[start + 5]);

export const notification = (x, start) => {
  const zero = x.indexOf(0, start + 9);
  return {
    channel: x.toString("utf-8", start + 9, zero),
    payload: x.toString("utf-8", zero + 1, x.indexOf(0, zero + 1)),
    pid: x.readInt32BE(start + 5),
  };
};

export const parameterStatus = (x, start) => {
  const zero = x.indexOf(0, start + 5);
  return [
    x.toString("utf-8", start + 5, zero),
    x.toString("utf-8", zero + 1, x.indexOf(0, zero + 1)),
  ];
};

export const backendKeyData = (x, start) => ({
  pid: x.readInt32BE(start + 5),
  secret: x.readInt32BE(start + 9),
});

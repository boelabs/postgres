import { own } from "./connection.js";

const noop = () => {
  // Swallows a rejection that is handled elsewhere, or stands in for a callback nobody passed.
};
const statusInterval = 10_000;
const epoch = BigInt(Date.UTC(2000, 0, 1)) * 1000n;

const lsnToString = (x) =>
  `${(x >> 32n).toString(16).toUpperCase()}/${(x & 0xff_ff_ff_ffn)
    .toString(16)
    .toUpperCase()}`;

export default function Subscribe(postgres, options) {
  const subscribers = new Map();
  const persistent = !!options.slot;
  const slot =
    options.slot || `postgresjs_${Math.random().toString(36).slice(2)}`;
  const state = {};
  const { timers } = options;

  let connection;
  let current = null;
  let ended = false;
  let retries = 0;

  // Async, so that a bad event rejects instead of throwing.
  const subscribe = async (event, fn, onsubscribe, onerror) => {
    const name = parseEvent(event);

    connection ||= init();

    const subscriber = {
      fn,
      onerror,
      onsubscribe: onsubscribe === undefined ? noop : onsubscribe,
    };
    const fns = subscribers.has(name)
      ? subscribers.get(name).add(subscriber)
      : subscribers.set(name, new Set([subscriber])).get(name);

    const unsubscribe = () => {
      fns.delete(subscriber);
      if (fns.size === 0) {
        subscribers.delete(name);
      }
    };

    return connection.then(
      () => {
        subscriber.onsubscribe();
        return { sql, state, unsubscribe };
      },
      (error) => {
        unsubscribe();
        connection = null;
        throw error;
      }
    );
  };

  const restart = () => {
    const delay = Math.min(100 * 2 ** retries, 10_000);
    retries += 1;
    const { promise: waited, resolve } = Promise.withResolvers();
    timers.setTimeout(resolve, retries === 1 ? 0 : delay);
    connection = waited
      .then(() => ended || init())
      .then(
        (x) => {
          retries = 0;
          if (!ended) {
            for (const event of subscribers.values()) {
              for (const { onsubscribe } of event) {
                onsubscribe();
              }
            }
          }
          return x;
        },
        (error) => {
          report(error);
          if (!ended) {
            restart();
          }
        }
      );
    connection.catch(noop);
  };

  const init = async () => {
    if (!options.publications) {
      throw new Error("Missing publication names");
    }

    await sql
      .unsafe(
        `CREATE_REPLICATION_SLOT ${slot}${persistent ? "" : " TEMPORARY"} LOGICAL pgoutput NOEXPORT_SNAPSHOT`
      )
      .catch((error) => {
        if (!persistent || error.code !== "42710") {
          throw error;
        }
      });

    const query = sql.unsafe(
      `START_REPLICATION SLOT ${slot} LOGICAL 0/0 (proto_version '1', publication_names '${options.publications}')`
    );
    query.catch(noop);
    const stream = await query.writable();
    current = Stream(stream);
    state.pid = query.state && query.state.pid;
    state.secret = query.state && query.state.secret;
    return current;
  };

  const Stream = (stream) => {
    const relations = {};
    let acked = 0n;
    let received = 0n;
    let transaction = null;
    let queue = null;
    let failed = false;
    let stopped = false;
    let timer = null;
    let soon = null;

    const idle = () => !transaction && !queue;

    const status = () => {
      if (stopped || stream.destroyed || !stream.writable) {
        return;
      }

      const x = Buffer.alloc(34);
      x[0] = 0x72;
      x.writeBigUInt64BE(acked, 1);
      x.writeBigUInt64BE(acked, 9);
      x.writeBigUInt64BE(acked, 17);
      x.writeBigInt64BE(BigInt(Date.now()) * 1000n - epoch, 25);
      stream.write(x);
    };

    const tick = () => {
      timer = null;
      if (stopped) {
        return;
      }

      status();
      timer = timers.setTimeout(tick, statusInterval);
    };

    const stop = () => {
      if (stopped) {
        return;
      }

      stopped = true;
      if (timer) {
        timers.clearTimeout(timer);
      }
      if (soon) {
        timers.clearImmediate(soon);
      }
      timer = null;
      soon = null;
    };

    const fail = (error, subscriber) => {
      report(error, subscriber);
      if (!persistent || failed) {
        return;
      }

      failed = true;
      queue = null;
      stop();
      stream.destroy(
        new Error("A subscriber failed, so the transaction is delivered again")
      );
      close();
    };

    const call = (pending, event, row, info) => {
      if (!subscribers.has(event)) {
        return;
      }
      for (const subscriber of subscribers.get(event)) {
        let result;
        try {
          result = subscriber.fn(row, info, event);
        } catch (error) {
          fail(error, subscriber);
          continue;
        }
        if (result && typeof result.then === "function") {
          pending.push(result.catch((error) => fail(error, subscriber)));
        }
      }
    };

    const handle = (row, info) => {
      const path = `${info.relation.schema}.${info.relation.table}`;
      const key =
        row && info.relation.keys.length
          ? `=${info.relation.keys.map((x) => row[x.name])}`
          : "";
      const pending = [];

      call(pending, "*", row, info);
      call(pending, `*:${path}`, row, info);
      if (key) {
        call(pending, `*:${path}${key}`, row, info);
      }
      call(pending, info.command, row, info);
      call(pending, `${info.command}:${path}`, row, info);
      if (key) {
        call(pending, `${info.command}:${path}${key}`, row, info);
      }
      return pending.length ? Promise.all(pending) : null;
    };

    const commit = (done) => {
      acked = max(acked, done.end);
      if (persistent && !soon) {
        soon = timers.setImmediate(() => {
          soon = null;
          status();
        });
      }
    };

    // The queue is always a native promise, so awaiting it resumes on the same tick as then().
    const drain = async () => {
      const at = queue;
      try {
        await at;
      } catch {
        return;
      }
      if (queue !== at) {
        if (queue) {
          drain();
        }
        return;
      }

      queue = null;
      if (!stopped && !failed) {
        stream.resume();
      }
    };

    const run = (fn) => {
      if (failed || stopped) {
        return;
      }

      if (queue) {
        queue = queue.then(() => (failed || stopped ? null : fn()));
        return;
      }

      const result = fn();
      if (result && typeof result.then === "function") {
        queue = result;
        stream.pause();
        drain();
      }
    };

    const message = (kind, x, info) => {
      if (kind === "begin") {
        transaction = {
          end: null,
          lsn: x.lsn,
          time: x.time,
          xid: x.xid,
        };
        return transaction;
      }

      if (kind === "commit") {
        const done = transaction;
        done.end = x.end;
        transaction = null;
        return run(() => commit(done));
      }

      const at = transaction || {};
      info.lsn = at.lsn && lsnToString(at.lsn);
      info.time = at.time;
      info.xid = at.xid;
      run(() => handle(x, info));
    };

    const data = (x) => {
      if (x[0] === 0x77) {
        received = max(received, x.readBigUInt64BE(9));
        parse(
          x.subarray(25),
          relations,
          sql.options.parsers,
          message,
          options.transform
        );
      } else if (x[0] === 0x6b) {
        received = max(received, x.readBigUInt64BE(1));
        if (idle()) {
          acked = max(acked, received);
        }
        if (x[17]) {
          status();
        }
      }
    };

    const finish = async () => {
      if (queue) {
        await queue.catch(noop);
      }
      if (!failed) {
        if (idle()) {
          acked = max(acked, received);
        }
        status();
      }
      stop();
      if (!stream.destroyed) {
        const { promise: closed, resolve } = Promise.withResolvers();
        stream.once("close", resolve);
        stream.end();
        await closed;
      }
    };

    timer = timers.setTimeout(tick, statusInterval);

    stream.on("data", data);
    stream.on("error", (error) => failed || report(error));
    stream.on("close", () => {
      const unexpected = !stopped;
      stop();
      if (unexpected) {
        close();
      }
    });

    return { finish, stop };
  };

  const report = (error, subscriber) => {
    const handlers = subscriber
      ? [subscriber.onerror]
      : [...subscribers.values()].flatMap((set) =>
          [...set].map((x) => x.onerror)
        );

    const listeners = handlers.filter(Boolean);
    if (listeners.length) {
      for (const fn of listeners) {
        fn(error);
      }
    } else {
      // With no onerror to call, the error must not vanish.
      console.error("@boelabs/postgres: logical replication error", error);
    }
  };

  const sql = postgres({
    ...options,
    connection: {
      ...options.connection,
      replication: "database",
    },
    eager_types: true,
    idle_timeout: null,
    max: 1,
    max_lifetime: null,
    no_subscribe: true,
    onclose: () => {
      if (current) {
        current.stop();
      }
      current = null;
      state.secret = undefined;
      state.pid = undefined;
      if (!ended) {
        restart();
      }
    },
    query_timeout: 0,
    transform: { column: {}, row: {}, value: {} },
  });
  subscribe.sql = sql;

  const { end, close } = sql;

  sql.end = async () => {
    ended = true;
    if (current) {
      await current.finish();
    }
    return end();
  };

  sql.close = async () => {
    if (current) {
      await current.finish();
    }
    return close();
  };

  return subscribe;
}

const max = (a, b) => (a > b ? a : b);

const Time = (x) => new Date(Date.UTC(2000, 0, 1) + Number(x / 1000n));

const parse = (x, relations, parsers, message, transform) => {
  const [type] = x;
  if (type === 82) {
    let i = 1;
    const id = x.readUInt32BE(i);
    i += 4;
    const schemaEnd = x.indexOf(0, i);
    const schema = x.toString("utf-8", i, schemaEnd) || "pg_catalog";
    i = schemaEnd;
    const tableEnd = x.indexOf(0, i + 1);
    const table = x.toString("utf-8", i + 1, tableEnd);
    i = tableEnd + 2;
    const columns = Array.from({ length: x.readUInt16BE(i) });
    const r = { columns, keys: [], schema, table };
    relations[id] = r;
    i += 2;

    let columnIndex = 0;

    while (i < x.length) {
      const key = x[i];
      i += 1;
      const nameEnd = x.indexOf(0, i);
      const raw = x.toString("utf-8", i, nameEnd);
      i = nameEnd;
      const name = transform.column.from ? transform.column.from(raw) : raw;
      i += 1;
      const columnType = x.readUInt32BE(i);
      const parser = parsers[x.readUInt32BE(i)];
      i += 4;
      const atttypmod = x.readUInt32BE(i);
      const column = { atttypmod, key, name, parser, type: columnType };
      r.columns[columnIndex] = column;
      columnIndex += 1;

      if (column.key) {
        r.keys.push(column);
      }
      i += 4;
    }
  } else if (type === 66) {
    message("begin", {
      lsn: x.readBigUInt64BE(1),
      time: Time(x.readBigInt64BE(9)),
      xid: x.readUInt32BE(17),
    });
  } else if (type === 67) {
    const lsn = x.readBigUInt64BE(2);
    const end = x.readBigUInt64BE(10);
    message("commit", { end, lsn });
  } else if (type === 73) {
    const relation = relations[x.readUInt32BE(1)];
    message("change", tuples(x, relation.columns, 8, transform).row, {
      command: "insert",
      relation,
    });
  } else if (type === 68) {
    let i = 1;
    const relation = relations[x.readUInt32BE(i)];
    i += 4;
    const key = x[i] === 75;
    message(
      "change",
      key || x[i] === 79
        ? tuples(x, relation.columns, (i += 3), transform).row
        : null,
      { command: "delete", key, relation }
    );
  } else if (type === 85) {
    let i = 1;
    const relation = relations[x.readUInt32BE(i)];
    i += 4;
    const key = x[i] === 75;
    const xs =
      key || x[i] === 79
        ? tuples(x, relation.columns, (i += 3), transform)
        : null;

    if (xs) {
      ({ i } = xs);
    }

    const { row } = tuples(x, relation.columns, i + 3, transform);
    message("change", row, {
      command: "update",
      key,
      old: xs && xs.row,
      relation,
    });
  } else if (type === 84) {
    const count = x.readUInt32BE(1);
    const flags = x.at(5);
    for (let i = 0; i < count; i += 1) {
      message("change", null, {
        cascade: (flags & 1) === 1,
        command: "truncate",
        relation: relations[x.readUInt32BE(6 + i * 4)],
        restartIdentity: (flags & 2) === 2,
      });
    }
  }
};

const tuples = (x, columns, start, transform) => {
  let xi = start;
  const row = {};
  for (const column of columns) {
    const type = x[xi];
    xi += 1;
    let value;
    if (type === 110) {
      value = null;
    } else if (type === 117) {
      value = undefined;
    } else {
      const end = xi + 4 + x.readUInt32BE(xi);
      const text = x.toString("utf-8", xi + 4, end);
      xi = end;
      value = column.parser(text);
    }

    value = transform.value.from ? transform.value.from(value, column) : value;
    if (column.name === "__proto__") {
      own(row, column.name, value);
    } else {
      row[column.name] = value;
    }
  }

  return { i: xi, row: transform.row.from ? transform.row.from(row) : row };
};

const parseEvent = (x) => {
  const { command, path, key } = x.match(
    /^(?<command>\*|insert|update|delete|truncate)?:?(?<path>[^.]+?\.?[^=]+)?=?(?<key>.+)?/iu
  ).groups;

  return (
    (command || "*") +
    (path ? `:${path.includes(".") ? path : `public.${path}`}` : "") +
    (key ? `=${key}` : "")
  );
};

import { Pipe } from "./net.js";

const select =
  /^select (?<id>\S+) as id, (?<scope>\S+) as scope(?: from rows\((?<rows>\S+)\))?(?: fail\((?<fail>\S+)\))?(?: sleep\((?<sleep>\S+)\))?$/iu;
const control =
  /^(?<command>begin|commit|end|rollback|savepoint \w+|release savepoint \w+|rollback to savepoint \w+)\b/iu;

const str = (x) => Buffer.from(`${x}\0`);
const i16 = (x) => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(x);
  return b;
};
const i32 = (x) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(x);
  return b;
};
const msg = (type, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from(type), i32(body.length + 4), body]);
};

const columns = (shape) => {
  const column = (name, type) =>
    Buffer.concat([
      str(name),
      i32(0),
      i16(0),
      i32(type),
      i16(4),
      i32(-1),
      i16(0),
    ]);
  return msg(
    "T",
    i16(3),
    column("id", 23),
    column("scope", 23),
    column("shape", shape === "a" ? 23 : 25)
  );
};

const cell = (x) => {
  if (x === null || x === undefined) {
    return [i32(-1)];
  }

  const b = Buffer.from(String(x));
  return [i32(b.length), b];
};

const error = (severity, code, message) =>
  msg(
    "E",
    Buffer.from(`S${severity}\0V${severity}\0C${code}\0M${message}\0\0`)
  );

const reader = (b, start) => {
  let i = start;
  return {
    byte: () => {
      const at = i;
      i += 1;
      return String.fromCodePoint(b[at]);
    },
    bytes() {
      const n = this.i32();
      if (n === -1) {
        return null;
      }
      i += n;
      return b.subarray(i - n, i);
    },
    i16: () => {
      i += 2;
      return b.readInt16BE(i - 2);
    },
    i16s() {
      return Array.from({ length: this.i16() }, () => this.i16());
    },
    i32: () => {
      i += 4;
      return b.readInt32BE(i - 4);
    },
    str: () => {
      const end = b.indexOf(0, i);
      const x = b.toString("utf-8", i, end);
      i = end + 1;
      return x;
    },
  };
};

const parse = (text) => {
  const c = text.trim().match(control);
  if (c) {
    return { control: c[1], params: 0, select: false };
  }

  const m = text.trim().match(select);
  if (!m) {
    return null;
  }

  const [, id, scope, rows = null, fail = null, sleep = null] = m.map(
    (part) => part && part.replace(/::int$/u, "")
  );
  const params = Math.max(
    0,
    ...[id, scope, rows, fail, sleep]
      .filter((v) => v && v[0] === "$")
      .map((v) => +v.slice(1))
  );
  return { fail, id, params, rows, scope, select: true, sleep };
};

// The ParameterStatus messages a session starts with, in the order they are sent.
const parameters = [
  ["server_version", "16.0"],
  ["client_encoding", "utf-8"],
  ["DateStyle", "ISO, MDY"],
  ["TimeZone", "UTC"],
  ["integer_datetimes", "on"],
  ["standard_conforming_strings", "on"],
];

export const Server = ({
  clock,
  random,
  delay,
  split,
  hosts = 1,
  log = null,
}) => {
  const { setTimeout } = clock.timers;
  const sessions = new Set();
  const violations = [];
  const attempts = [];
  const scopes = new Map();
  const outcomes = new Map();
  const stale = new Map();
  const latest = new Map();
  const startup = Array.from({ length: hosts }, () => "ready");
  let pids = 1000;
  let peak = 0;

  const violation = (x) => {
    violations.push(x);
  };

  const order = (id, scope) => {
    if (!scope) {
      return;
    }

    if (latest.get(scope) > id) {
      violation(
        `query ${id} of scope ${
          scope
        } reached the server after query ${latest.get(scope)}`
      );
    }
    latest.set(scope, Math.max(id, latest.get(scope) || 0));
  };

  const Session = (end, host) => {
    const prepared = new Map();
    const portals = new Map();
    const queue = [];
    let incoming = Buffer.alloc(0);
    let started = false;
    let busy = false;
    let discard = false;
    let status = "I";
    let txScope = 0;
    let txScopes = new Set();
    let sleeping = null;
    let gone = false;

    const reply = (data) => {
      if (!gone) {
        end.write(data);
      }
    };

    const ready = () => msg("Z", Buffer.from(status));

    const fail = (code, message) => {
      if (status === "T") {
        status = "E";
      }
      discard = true;
      reply(error("ERROR", code, message));
    };

    const fatal = (code, message) => {
      if (!gone) {
        end.end(error("FATAL", code, message));
      }
    };

    pids += 1;
    const x = {
      commitRollback: false,
      end,
      fatal,
      id: pids,
      prepared,
      secret: random.int(1, 1e9),
      shape: "a",
      get status() {
        return status;
      },
      wiped: new Set(),
    };

    const first = (message) => {
      const code = message.readInt32BE(4);
      if (code === 80_877_103) {
        return end.write("N");
      }

      if (code === 80_877_102) {
        const pid = message.readInt32BE(8);
        const secret = message.readInt32BE(12);
        for (const s of sessions) {
          if (s.id === pid && s.secret === secret && s.cancel) {
            s.cancel();
          }
        }
        return end.end();
      }
      started = true;
      const mode = startup[host];
      if (mode !== "ready") {
        attempts.push(clock.now);
      }
      if (mode === "close") {
        return end.end();
      }

      if (mode === "error") {
        return end.end(
          error("FATAL", "53300", "sorry, too many clients already")
        );
      }

      if (mode === "hang") {
        return;
      }

      sessions.add(x);
      peak = Math.max(peak, [...sessions].filter((s) => s.end.writable).length);
      x.cancel = () => sleeping && sleeping.cancel(true);
      end.write(
        Buffer.concat([
          msg("R", i32(0)),
          ...parameters.map(([k, v]) => msg("S", str(k), str(v))),
          msg("K", i32(x.id), i32(x.secret)),
          ready(),
        ])
      );
    };

    const check = (id, scope) => {
      const retry = stale.get(id);
      if (retry) {
        retry.retries += 1;
        if (retry.status !== "I") {
          violation(
            `stale plan for query ${id} retried while the session was ${
              retry.status
            }`
          );
        }
        if (retry.retries > 1) {
          violation(
            `stale plan for query ${id} retried ${retry.retries} times`
          );
        }
      }

      if (scope && scopes.has(scope) && scopes.get(scope) !== x.id) {
        violation(
          `scope ${scope} reached session ${x.id} after session ${scopes.get(
            scope
          )}`
        );
      }
      if (scope) {
        scopes.set(scope, x.id);
      }

      if (status !== "I" && scope !== txScope) {
        violation(
          `query ${id} of scope ${scope} reached session ${
            x.id
          } inside the transaction of scope ${txScope}`
        );
      }
    };

    const transaction = (command) => {
      const c = command.toLowerCase();
      if (c === "begin") {
        if (status === "I") {
          txScope = -1;
          txScopes = new Set();
        }
        status = status === "I" ? "T" : status;
        reply(msg("C", str("BEGIN")));
      } else if (c === "commit" || c === "end") {
        const rolled = status === "E" || x.commitRollback;
        x.commitRollback = false;
        for (const s of txScopes) {
          outcomes.set(s, rolled ? "rollback" : "commit");
        }
        status = "I";
        txScope = 0;
        portals.clear();
        reply(msg("C", str(rolled ? "ROLLBACK" : "COMMIT")));
      } else if (c === "rollback") {
        for (const s of txScopes) {
          outcomes.set(s, "rollback");
        }
        status = "I";
        txScope = 0;
        portals.clear();
        reply(msg("C", str("ROLLBACK")));
      } else if (c.startsWith("rollback to")) {
        if (status === "I") {
          fail("25P01", "no transaction");
        } else {
          status = "T";
          reply(msg("C", str("ROLLBACK")));
        }
      } else if (status === "I") {
        fail("25P01", "SAVEPOINT can only be used in transaction blocks");
      } else if (status === "E") {
        fail("25P02", "current transaction is aborted");
      } else {
        reply(msg("C", str(c.startsWith("release") ? "RELEASE" : "SAVEPOINT")));
      }
    };

    const bind = (scope) => {
      if (txScope === -1 && scope) {
        txScope = scope;
        txScopes.add(scope);
      }
    };

    const pump = () => {
      while (true) {
        if (busy || gone || !queue.length) {
          break;
        }
        handle(queue.shift());
      }
    };

    const execute = (portal, limit, simple) => {
      const { ast } = portal.p;
      const value = (v) => {
        if (v === null) {
          return null;
        }
        if (v[0] === "$") {
          return +portal.values[+v.slice(1) - 1];
        }
        return +v;
      };
      const done = () => {
        if (simple) {
          discard = false;
          reply(ready());
        }
      };

      if (ast.control) {
        transaction(ast.control);
        return done();
      }

      const id = value(ast.id);
      const scope = value(ast.scope);
      const rows = ast.rows ? value(ast.rows) : 1;
      const at = ast.fail === null ? -1 : value(ast.fail);
      const ms = ast.sleep === null ? 0 : value(ast.sleep);

      bind(scope);
      check(id, scope);
      if (!portal.ordered) {
        order(id, scope);
      }
      portal.ordered = true;

      if (portal.p.stale || (ast.select && portal.p.shape !== x.shape)) {
        if (!stale.has(id)) {
          stale.set(id, { retries: 0, status });
        }
        fail("0A000", "cached plan must not change result type");
        return done();
      }

      if (status === "E") {
        fail(
          "25P02",
          "current transaction is aborted, commands ignored until end of transaction block"
        );
        return done();
      }

      if (ms && !portal.slept) {
        busy = true;
        let timer = null;
        sleeping = {
          cancel: (cancelled) => {
            clock.timers.clearTimeout(timer);
            sleeping = null;
            busy = false;
            if (cancelled) {
              fail("57014", "canceling statement due to user request");
              done();
              pump();
            }
          },
        };
        timer = setTimeout(() => {
          sleeping = null;
          busy = false;
          portal.slept = true;
          execute(portal, limit, simple);
          pump();
        }, ms);
        return;
      }

      if (simple) {
        reply(columns(x.shape));
      }
      const out = [];
      while (portal.row < rows) {
        if (portal.row === at) {
          reply(Buffer.concat(out));
          fail("22012", "division by zero");
          return done();
        }
        if (limit && out.length === limit) {
          reply(Buffer.concat([...out, msg("s")]));
          return;
        }
        out.push(
          msg(
            "D",
            i16(3),
            ...cell(id),
            ...cell(scope),
            ...cell(x.shape === "a" ? 1 : "b")
          )
        );
        portal.row += 1;
      }
      reply(Buffer.concat([...out, msg("C", str(`SELECT ${out.length}`))]));
      done();
    };

    const onParse = (r) => {
      const name = r.str();
      const text = r.str();
      const ast = parse(text);
      if (!ast) {
        return fail("42601", `syntax error at or near "${text.slice(0, 10)}"`);
      }

      if (status === "E" && !ast.control) {
        return fail(
          "25P02",
          "current transaction is aborted, commands ignored until end of transaction block"
        );
      }

      if (name && prepared.has(name)) {
        violation(
          `parse of statement "${name}" that already exists in session ${x.id}`
        );
        return fail("42P05", `prepared statement "${name}" already exists`);
      }
      prepared.set(name, { ast, shape: x.shape, stale: false, text });
      x.wiped.delete(name);
      reply(msg("1"));
    };

    const onBind = (r) => {
      const portal = r.str();
      const name = r.str();
      // The parameter formats, which the simulator does not use.
      r.i16s();
      const n = r.i16();
      const values = Array.from({ length: n }, () => r.bytes());
      const p = prepared.get(name);
      if (!p) {
        if (name && !x.wiped.has(name)) {
          violation(
            `bind of statement "${name}" that session ${x.id} never had`
          );
        }
        return fail("26000", `prepared statement "${name}" does not exist`);
      }
      portals.set(portal, {
        p,
        row: 0,
        values: values.map((v) => (v === null ? null : v.toString())),
      });
      reply(msg("2"));
    };

    const onDescribe = (r) => {
      const kind = r.byte();
      const name = r.str();
      const p =
        kind === "S"
          ? prepared.get(name)
          : portals.get(name) && portals.get(name).p;
      if (!p) {
        if (kind === "S" && name && !x.wiped.has(name)) {
          violation(
            `describe of statement "${name}" that session ${x.id} never had`
          );
        }
        return fail(kind === "S" ? "26000" : "34000", "does not exist");
      }
      if (p.ast.select && p.shape !== x.shape) {
        return fail("0A000", "cached plan must not change result type");
      }

      if (kind === "S") {
        reply(
          msg(
            "t",
            i16(p.ast.params),
            ...Array.from({ length: p.ast.params }, () => i32(23))
          )
        );
      }
      reply(p.ast.select ? columns(x.shape) : msg("n"));
    };

    const onExecute = (r) => {
      const name = r.str();
      const limit = r.i32();
      const portal = portals.get(name);
      if (!portal) {
        violation(
          `execute of portal "${name}" that does not exist in session ${x.id}`
        );
        return fail("34000", `portal "${name}" does not exist`);
      }
      execute(portal, limit, false);
    };

    const onQuery = (r) => {
      const text = r.str();
      const ast = parse(text);
      if (!ast) {
        fail("42601", "syntax error");
        discard = false;
        return reply(ready());
      }
      execute(
        { p: { ast, shape: x.shape, text }, row: 0, values: [] },
        0,
        true
      );
    };

    const onClose = (r) => {
      if (r.byte() === "S") {
        prepared.delete(r.str());
      } else {
        portals.delete(r.str());
      }
      reply(msg("3"));
    };

    const handle = (m) => {
      const type = String.fromCodePoint(m[0]);
      const r = reader(m, 5);

      if (log) {
        log(
          `${x.id} ${status}${discard ? " discard " : " "}${type} ${m
            .subarray(5)
            .toString()
            .replaceAll(/[^ -~]+/gu, ".")
            .slice(0, 90)}`
        );
      }
      if (discard && type !== "S") {
        return;
      }

      if (type === "P") {
        onParse(r);
      } else if (type === "B") {
        onBind(r);
      } else if (type === "D") {
        onDescribe(r);
      } else if (type === "E") {
        onExecute(r);
      } else if (type === "Q") {
        onQuery(r);
      } else if (type === "S") {
        discard = false;
        if (status === "I") {
          portals.clear();
        }
        reply(ready());
      } else if (type === "C") {
        onClose(r);
      } else if (type === "X") {
        end.end();
      } else if (type !== "H") {
        fail("08P01", `unsupported message ${type}`);
      }
    };

    end.on("data", (data) => {
      incoming = Buffer.concat([incoming, data]);
      while (incoming.length >= (started ? 5 : 4)) {
        const length = started
          ? incoming.readInt32BE(1) + 1
          : incoming.readInt32BE(0);
        if (incoming.length < length) {
          break;
        }

        const message = incoming.subarray(0, length);
        incoming = incoming.subarray(length);
        if (started) {
          queue.push(message);
          pump();
        } else {
          first(message);
        }
      }
    });
    end.on("close", () => {
      gone = true;
      if (status !== "I") {
        for (const s of txScopes) {
          outcomes.set(s, "rollback");
        }
      }
      sessions.delete(x);
      if (sleeping) {
        sleeping.cancel();
      }
    });
    end.on("error", () => {
      // The close that follows is what the session acts on.
    });

    return x;
  };

  const socket = (host = 0) => {
    const { client, server } = Pipe({ clock, delay, random, split });
    Session(server, host);
    return client;
  };

  return {
    attempts,
    close: (x, reset) => (reset ? x.end.destroy() : x.end.end()),
    commitRollback: (x) => (x.commitRollback = true),
    deallocate: (x) => {
      for (const name of x.prepared.keys()) {
        x.wiped.add(name);
      }
      x.prepared.clear();
    },
    kill: (x) =>
      x.fatal("57P01", "terminating connection due to administrator command"),
    outcomes,
    get peak() {
      return peak;
    },
    retype: (x) => (x.shape = x.shape === "a" ? "b" : "a"),
    sessions,
    socket,
    stale: (x) => {
      for (const p of x.prepared.values()) {
        p.stale = true;
      }
    },
    startup,
    violations,
  };
};

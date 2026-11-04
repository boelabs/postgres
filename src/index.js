import fs from "node:fs";
import os from "node:os";

import { Identifier, Builder } from "./build.js";
import { channels, active, start, finish, userName } from "./diagnostics.js";
import { Errors, PostgresError } from "./errors.js";
import largeObject from "./large.js";
import { Pool } from "./pool.js";
import { Query, CLOSE } from "./query.js";
import Subscribe from "./subscribe.js";
import {
  Types,
  Parameter,
  toPascal,
  pascal,
  toCamel,
  camel,
  toKebab,
  kebab,
  fromPascal,
  fromCamel,
  fromKebab,
} from "./types.js";

export { PostgresError } from "./errors.js";

const noop = () => {
  // Only the outcome matters, not the value: a rollback resolves with nothing, and the error
  // of a rollback that failed was seen where it was sent.
};

// A function expression, not an arrow, so that postgres() can still be called with new.
const Postgres = function Postgres(a, b) {
  const options = parseOptions(a, b);
  const types = options.shared_types || Types(options);
  const pool = Pool(options, types);
  const subscribe =
    options.no_subscribe ||
    Subscribe(Postgres, { ...options, shared_types: types });
  const listener = Listen(options);

  if (types.named && options.fetch_types === false) {
    throw Errors.generic(
      "TYPE_NOT_FOUND",
      "Custom types given by name need fetch_types to look them up"
    );
  }

  options.resolve = types.resolve;
  options.parsers = view(types.parsers, types.parser);
  options.serializers = view(types.serializers, types.serializer);

  const handle = (q) => {
    pool.query(q);
  };

  const Sql = (handler) => {
    handler.debug = options.debug;
    handler.options = options;
    handler.cancel ||= pool.cancel;

    // oxlint-disable-next-line unicorn/consistent-function-scoping -- one per sql instance: its custom types are added to it below
    const typed = (value, type) => new Parameter(value, type);

    for (const [name, type] of Object.entries(options.types)) {
      typed[name] = (x) => new Parameter(x, type.to);
    }

    const sql = function sql(strings, ...args) {
      if (strings && Array.isArray(strings.raw)) {
        return new Query(strings, args, handler);
      }
      if (typeof strings === "string" && !args.length) {
        return new Identifier(
          options.transform.column.to
            ? options.transform.column.to(strings)
            : strings
        );
      }
      return new Builder(strings, args);
    };

    const unsafe = function unsafe(string, args = [], queryOptions = {}) {
      let values = args;
      let settings = queryOptions;
      if (arguments.length === 2 && !Array.isArray(args)) {
        settings = args;
        values = [];
      }
      return new Query([string], values, handler, {
        prepare: false,
        ...settings,
        simple: "simple" in settings ? settings.simple : values.length === 0,
      });
    };

    const batch = (queries) => {
      if (!Array.isArray(queries)) {
        throw Errors.generic(
          "BATCH_NOT_ARRAY",
          "sql.batch takes an array of queries"
        );
      }

      // A hole in the array is passed over, as forEach did; the pool fails it when it builds it.
      for (const [i, x] of queries.entries()) {
        if (i in queries) {
          if (!(x instanceof Query)) {
            throw Errors.generic(
              "BATCH_NOT_QUERY",
              `Item ${i} of the batch is not a query`
            );
          }
          if (x.executed) {
            throw Errors.generic(
              "BATCH_EXECUTED",
              `Item ${i} of the batch has already run`
            );
          }
          if (
            x.cursorFn ||
            x.cursorRows ||
            x.streaming ||
            x.forEachFn ||
            x.onlyDescribe
          ) {
            throw Errors.generic(
              "BATCH_UNSUPPORTED",
              `Item ${i} of the batch is a cursor, stream, forEach or describe`
            );
          }
        }
      }

      const q = new Query([], [], handler, {});
      q.parts = queries;
      for (const [i, x] of queries.entries()) {
        if (i in queries) {
          x.executed = true;
          x.cancel = () => q.cancel();
        }
      }
      return q;
    };

    const notify = async (channel, payload) =>
      await sql`select pg_notify(${channel}, ${`${payload}`})`;

    const file = function file(path, args = [], queryOptions = {}) {
      let values = args;
      let settings = queryOptions;
      if (arguments.length === 2 && !Array.isArray(args)) {
        settings = args;
        values = [];
      }
      const fileHandler = (query) =>
        fs.readFile(path, "utf-8", (err, string) => {
          if (err) {
            return query.reject(err);
          }
          query.strings = [string];
          handler(query);
        });
      Object.assign(fileHandler, handler);
      return new Query([], values, fileHandler, {
        ...settings,
        simple: "simple" in settings ? settings.simple : values.length === 0,
      });
    };

    Object.assign(sql, {
      array,
      batch,
      file,
      json,
      notify,
      typed,
      types: typed,
      unsafe,
    });

    return sql;
  };

  const reserve = async () => {
    const lease = await pool.lease("reserve");
    const reserved = Sql(
      Object.assign((q) => lease.send(q), { cancel: pool.cancel })
    );

    reserved.release = () => lease.release();
    if (Symbol.dispose) {
      reserved[Symbol.dispose] = reserved.release;
    }
    if (Symbol.asyncDispose) {
      // oxlint-disable-next-line require-await -- asyncDispose returns a promise, which what release throws rejects
      reserved[Symbol.asyncDispose] = async () => reserved.release();
    }
    return reserved;
  };

  // Runs fn while this process holds a session advisory lock, on a connection kept for the lock alone,
  // so that the unlock reaches the session that locked. fn gets that connection's sql. The lock is
  // let go when fn settles, and goes with the connection should that be lost first.
  const lock = async (key, fn, { wait = true, signal } = {}) => {
    if (typeof fn !== "function") {
      throw Errors.generic(
        "LOCK_NO_FUNCTION",
        "sql.lock takes a key and a function to run while it holds the lock"
      );
    }

    const id = lockKey(key);
    const lease = await pool.lease("lock");
    const held = Sql(
      Object.assign((q) => lease.send(q), { cancel: pool.cancel })
    );

    let acquired = false;
    try {
      const take = wait
        ? held`select true as acquired from pg_advisory_lock(${id})`
        : held`select pg_try_advisory_lock(${id}) as acquired`;
      if (signal) {
        take.signal(signal);
      }
      const [row] = await take;
      ({ acquired } = row);
      if (!acquired) {
        throw Errors.generic(
          "LOCK_NOT_AVAILABLE",
          `The advisory lock ${key} is held by another session`
        );
      }
      return await fn(held);
    } finally {
      const unlocked =
        acquired &&
        (await held`select pg_advisory_unlock(${id}) as x`.then(
          ([x]) => x.x,
          () => false
        ));
      // A connection that may still hold the lock never goes back to the pool.
      if (acquired && !unlocked) {
        lease.connection.close();
      }
      lease.release();
    }
  };

  // An integer or bigint is the key itself; the server hashes a string into one.
  const lockKey = (x) => {
    if (
      typeof x === "bigint" ||
      (typeof x === "number" && Number.isSafeInteger(x))
    ) {
      return instance`${String(x)}::int8`;
    }
    if (typeof x === "string" && x) {
      return instance`hashtextextended(${x}, 0)`;
    }
    throw Errors.generic(
      "LOCK_KEY",
      "An advisory lock key is an integer, a bigint or a non-empty string"
    );
  };

  const begin = (mode, fn) => {
    const body = fn || mode;
    const level = fn ? mode : "";
    if (!active(channels.transaction)) {
      return transaction(level, body, null);
    }

    // oxlint-disable-next-line sort-keys -- a diagnostics context for subscribers, its key order shows in their logs and JSON
    const context = {
      mode: level,
      database: options.database,
      user: userName(options),
      connection: null,
      host: null,
      port: null,
      outcome: null,
    };
    let promise;
    start(channels.transaction, context, () => {
      promise = transaction(level, body, context);
      return promise;
    });

    return promise.then(
      (result) => {
        finish(channels.transaction, context, null, result);
        return result;
      },
      (transactionError) => {
        finish(channels.transaction, context, transactionError);
        throw transactionError;
      }
    );
  };

  const transaction = async (mode, fn, context) => {
    const lease = await pool.lease("transaction");

    let savepoints = 0;
    let prepare = null;

    if (context) {
      Object.assign(context, {
        connection: lease.connection.id,
        host: lease.connection.host,
        port: lease.connection.port,
      });
    }

    // oxlint-disable-next-line complexity -- one transaction or savepoint from start to end; parts of it in helpers would await on other ticks
    const scope = async (body, name, inside, above = () => false) => {
      let uncaught;
      let result;
      let rolled = null;
      let after = null;

      if (above()) {
        throw rolledBack();
      }

      const stopped = () => !!rolled || above();
      const scoped = Sql(
        Object.assign(
          (q) => {
            if (stopped()) {
              return q.reject((after ||= rolledBack()));
            }
            q.catch((queryError) => (uncaught ||= queryError));
            lease.send(q);
          },
          { cancel: pool.cancel }
        )
      );

      const savepoint = (...args) => {
        const [label, run] = args;
        if (label && Array.isArray(label.raw)) {
          return savepoint((tx) => tx(...args));
        }

        const named = args.length === 1 ? null : label;
        const block = args.length === 1 ? label : run;
        const id = savepoints;
        savepoints += 1;
        return scope(
          block,
          `s${id}${named ? `_${named}` : ""}`,
          false,
          stopped
        );
      };

      // oxlint-disable-next-line require-await -- a wrong mode rejects the promise it returns, it does not throw
      const nested = async (inner, run) => {
        const block = run || inner;
        const level = run ? inner : "";

        if (normal(level) && normal(level) !== normal(mode)) {
          throw Errors.generic(
            "NESTED_TRANSACTION_MODE",
            "A nested transaction runs in a savepoint, which can not change the transaction mode"
          );
        }

        const id = savepoints;
        savepoints += 1;
        return scope(block, `s${id}`, true, stopped);
      };

      scoped.savepoint = savepoint;
      scoped.begin = nested;
      scoped.rollback = () =>
        (rolled ||= control(lease, rollbackOf(name)).then(noop));
      scoped.prepare = (x) => {
        if (inside) {
          throw Errors.generic(
            "NESTED_TRANSACTION_MODE",
            "A nested transaction can not be prepared, only the outermost one"
          );
        }
        prepare = x.replaceAll(/[^A-Za-z0-9$\-_. ]/gu, "");
      };

      if (name) {
        await control(lease, `savepoint ${identifier(name)}`);
      }
      try {
        const { promise, resolve, reject } = Promise.withResolvers();
        // What this throws rejects the promise, as from a promise executor.
        try {
          const x = body(scoped);
          Promise.resolve(Array.isArray(x) ? Promise.all(x) : x).then(
            resolve,
            reject
          );
        } catch (error) {
          reject(error);
        }
        result = await promise;
        if (uncaught && !stopped()) {
          throw uncaught;
        }
        if (lease.connection.closed) {
          throw lease.error || lease.connection.closed;
        }
      } catch (error) {
        if (context && !name) {
          context.outcome = "rollback";
        }
        if (stopped()) {
          if (rolled) {
            await rolled.catch(noop);
          }
        } else if (!lease.connection.closed) {
          await control(lease, rollbackOf(name));
        }
        throw (
          (error instanceof PostgresError &&
            error.code === "25P02" &&
            uncaught) ||
          error
        );
      }

      if (stopped()) {
        if (rolled) {
          await rolled;
        }
        if (context && !name) {
          context.outcome = "rollback";
        }

        if (after) {
          throw after;
        }

        return result;
      }

      if (!name) {
        const done = await control(
          lease,
          prepare
            ? `prepare transaction '${prepare.replaceAll("'", "''")}'`
            : "commit"
        );
        if (context) {
          context.outcome = outcome(prepare, done);
        }

        if (!prepare && done.command !== "COMMIT") {
          throw Errors.generic(
            "TRANSACTION_ROLLED_BACK",
            "The server rolled back the transaction instead of committing it"
          );
        }
      }

      return result;
    };

    try {
      await control(lease, `begin ${mode.replaceAll(/[^A-Za-z ]/gu, "")}`);
      const done = scope(fn);
      done.catch(noop);
      return await Promise.race([done, lease.closed]);
    } finally {
      lease.release();
    }
  };

  const control = (lease, text) => {
    const q = new Query(
      [text],
      [],
      Object.assign((query) => lease.send(query), {
        cancel: pool.cancel,
        options,
      }),
      { simple: true }
    );
    return q.execute();
  };

  const end = async (settings) => {
    await Promise.all([
      listener.end(),
      subscribe.sql ? subscribe.sql.end({ timeout: 0 }) : null,
    ]);
    return pool.end(settings);
  };

  const close = () => pool.close();

  const instance = Sql(handle);

  Object.defineProperties(instance, {
    parameters: { enumerable: true, get: () => options.parameters },
    stats: { enumerable: true, get: () => pool.stats },
  });

  Object.assign(instance, {
    CLOSE,
    END: CLOSE,
    PostgresError,
    begin,
    close,
    end,
    largeObject: largeObject.bind(null, instance),
    listen: listener.listen,
    lock,
    options,
    reserve,
    subscribe,
  });

  if (Symbol.asyncDispose) {
    instance[Symbol.asyncDispose] = () => end();
  }

  return instance;
};

Object.assign(Postgres, {
  BigInt: {
    from: [20],
    parse: BigInt,
    serialize: (x) => x.toString(),
    to: 20,
  },
  PostgresError,
  camel,
  fromCamel,
  fromKebab,
  fromPascal,
  kebab,
  pascal,
  toCamel,
  toKebab,
  toPascal,
});

export default Postgres;

const json = (x) => new Parameter(x, 3802);

const array = () => {
  throw Errors.generic(
    "ARRAY_REMOVED",
    "sql.array() is removed in v4, pass the array as it is"
  );
};

const rolledBack = () =>
  Errors.generic(
    "TRANSACTION_ROLLED_BACK",
    "The query was not sent, the transaction was rolled back with sql.rollback()"
  );

// What a commit or prepare ended in, for the diagnostics context.
const outcome = (prepared, done) => {
  if (prepared) {
    return "prepare";
  }
  if (done.command === "COMMIT") {
    return "commit";
  }
  return "rollback";
};

const normal = (x) =>
  (x || "")
    .toLowerCase()
    .replaceAll(/[^a-z ]/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim();

const identifier = (x) => `"${x.replaceAll('"', '""')}"`;

// The statement that undoes a scope: all of the transaction, or back to its savepoint.
const rollbackOf = (name) =>
  name ? `rollback to ${identifier(name)}` : "rollback";

// A channel listened to again after its connection was lost.
const relistened = (channel, result) => {
  Object.assign(channel.state, result.state);
  for (const l of channel.listeners) {
    if (l.onlisten) {
      l.onlisten();
    }
  }
};

const Listen = (options) => {
  const subscriptions = new Map();
  let sql = null;
  let closing = null;

  const connection = () =>
    (sql ||= Postgres({
      ...options,
      fetch_types: false,
      idle_timeout: null,
      max: 1,
      max_lifetime: null,
      no_subscribe: true,
      onclose() {
        if (closing) {
          return;
        }

        for (const [name, channel] of subscriptions) {
          relisten(channel, name);
        }
      },
      onnotify(channel, payload) {
        if (subscriptions.has(channel)) {
          const listeners = [...subscriptions.get(channel).listeners];
          for (const l of listeners) {
            l.fn(payload);
          }
        }
      },
      query_timeout: 0,
    }));

  const relisten = (channel, name, retries = 0) => {
    channel.timer = null;
    channel.result = listenTo(name);
    channel.result.then(
      (result) => relistened(channel, result),
      () => {
        if (closing || subscriptions.get(name) !== channel) {
          return;
        }

        const attempt = retries + 1;
        const seconds =
          typeof options.backoff === "function"
            ? options.backoff(attempt)
            : options.backoff;
        channel.timer = options.timers.setTimeout(() => {
          if (!closing && subscriptions.get(name) === channel) {
            relisten(channel, name, attempt);
          }
        }, seconds * 1000);
      }
    );
  };

  const listenTo = (name) => {
    const x = connection();
    return x`listen ${x.unsafe(`"${name.replaceAll('"', '""')}"`)}`;
  };

  const listen = async (name, fn, onlisten) => {
    const listener = { fn, onlisten };
    if (!subscriptions.has(name)) {
      subscriptions.set(name, {
        listeners: new Set(),
        result: listenTo(name),
        state: {},
      });
    }

    const channel = subscriptions.get(name);
    channel.listeners.add(listener);
    let result;
    try {
      result = await channel.result;
    } catch (error) {
      channel.listeners.delete(listener);
      if (!channel.listeners.size) {
        subscriptions.delete(name);
      }
      throw error;
    }
    Object.assign(channel.state, result.state);
    if (listener.onlisten) {
      listener.onlisten();
    }

    const unlisten = async () => {
      if (!channel.listeners.delete(listener) || channel.listeners.size) {
        return;
      }

      if (subscriptions.get(name) === channel) {
        subscriptions.delete(name);
      }
      const x = sql;

      if (closing || !x) {
        return;
      }

      await x`unlisten ${x.unsafe(`"${name.replaceAll('"', '""')}"`)}`.catch(
        (error) => {
          if (!error.code.startsWith("CONNECTION_")) {
            throw error;
          }
        }
      );
      if (subscriptions.size === 0 && sql === x) {
        sql = null;
        await x.end();
      }
    };

    return { state: channel.state, unlisten };
  };

  return {
    end: () => {
      for (const channel of subscriptions.values()) {
        if (channel.timer) {
          options.timers.clearTimeout(channel.timer);
        }
      }
      return (
        closing ||
        (sql ? (closing = sql.end({ timeout: 0 })) : Promise.resolve())
      );
    },
    listen,
  };
};

const parseOptions = (a, b) => {
  if (a && a.shared) {
    return a;
  }

  const { env } = process;
  const o = given(a, b);
  const url = parseUrl(a);
  const query = params(url.url.searchParams);
  const targets = hosts(o, query, url, env);
  const port = portOf(o, query, env);
  const user = userOf(o, url, env);

  if (o.no_prepare) {
    o.prepare = false;
  }
  if (query.sslmode) {
    query.ssl = query.sslmode;
    delete query.sslmode;
  }
  if ("timeout" in o) {
    console.log("The timeout option is deprecated, use idle_timeout instead");
    o.idle_timeout = o.timeout;
  }
  if (!("ssl" in query) && env.PGSSLMODE) {
    query.ssl = env.PGSSLMODE;
  }

  const ints = new Set([
    "idle_timeout",
    "connect_timeout",
    "max_lifetime",
    "max_pipeline",
    "backoff",
    "keep_alive",
    "min",
    "queue_timeout",
    "query_timeout",
    "cancel_timeout",
  ]);
  // oxlint-disable-next-line sort-keys -- read in this order with Object.entries, which is the order of these keys in sql.options
  const defaults = {
    max: globalThis.Cloudflare ? 3 : 10,
    min: 0,
    ssl: false,
    sslnegotiation: null,
    channel_binding: "prefer",
    idle_timeout: null,
    connect_timeout: 30,
    queue_timeout: 0,
    query_timeout: 0,
    cancel_timeout: 5,
    max_lifetime,
    max_pipeline: 100,
    scheduler: true,
    backoff,
    keep_alive: 60,
    prepare: true,
    debug: false,
    fetch_types: true,
    infer: false,
    publications: "alltables",
    slot: null,
    target_session_attrs: null,
  };

  // oxlint-disable-next-line sort-keys -- sql.options is handed to the user, its key order shows in logs and JSON
  const options = {
    host: targets.map((x) => x[0]),
    port: Array.isArray(port)
      ? port
      : targets.map((x) => (o.port || query.port ? +port : x[1] || +port)),
    path: pathOf(o, targets, port),
    database: databaseOf(o, url, env, user),
    user,
    pass: passOf(o, url, env),
    ...settings(defaults, ints, o, query, env),
    connection: {
      application_name: env.PGAPPNAME || "@boelabs/postgres",
      ...o.connection,
      ...runtime(query, defaults),
    },
    sslrootcert: sslFile(o, query, env, "sslrootcert", "PGSSLROOTCERT"),
    sslcert: sslFile(o, query, env, "sslcert", "PGSSLCERT"),
    sslkey: sslFile(o, query, env, "sslkey", "PGSSLKEY"),
    sslpassword: o.sslpassword || query.sslpassword || null,
    types: o.types || {},
    target_session_attrs: tsa(o, url.url, env),
    channel_binding: binding(o, url.url, env),
    onnotice: o.onnotice,
    onnotify: o.onnotify,
    onclose: o.onclose,
    onparameter: o.onparameter,
    socket: o.socket,
    onread: o.onread !== false,
    open: o.open,
    no_subscribe: o.no_subscribe,
    unref_sockets: !!o.unref_sockets,
    passfile: passfile(env),
    shared_types: o.shared_types,
    eager_types: !!o.eager_types,
    transform: parseTransform(o.transform || { undefined }),
    parameters: {},
    shared: { retries: 0 },
    timers: o.timers || {
      clearImmediate,
      clearTimeout,
      now: () => performance.now(),
      setImmediate,
      setTimeout,
    },
  };

  options.ssl = sslmode(options.ssl, options.sslrootcert);
  options.infer = options.infer === true || options.infer === "true";
  if (options.max === 1) {
    options.scheduler = false;
  }
  return options;
};

// The options object given, with or without a url before it.
const given = (a, b) => (!a || typeof a === "string" ? b : a) || {};

// The parameters of a url's query by name, the last of a repeated one winning.
const params = (searchParams) => {
  const out = {};
  for (const [k, v] of searchParams) {
    out[k] = v;
  }
  return out;
};

const portOf = (o, query, env) => o.port || query.port || env.PGPORT || 5432;

const userOf = (o, url, env) =>
  o.user ||
  o.username ||
  url.url.username ||
  env.PGUSERNAME ||
  env.PGUSER ||
  osUsername();

const pathOf = (o, targets, port) =>
  o.path ||
  (targets[0][0].includes("/") &&
    `${targets[0][0]}/.s.PGSQL.${targets[0][1] || port}`);

const databaseOf = (o, url, env, user) =>
  o.database ||
  o.db ||
  (url.url.pathname || "").slice(1) ||
  env.PGDATABASE ||
  (typeof user === "function" ? null : user);

const passOf = (o, url, env) =>
  o.pass || o.password || url.url.password || env.PGPASSWORD || "";

const sslFile = (o, query, env, key, variable) =>
  o[key] || query[key] || env[variable] || null;

// Each default, as given in the options, else in the url, else in the environment.
const setting = (k, d, o, query, env) => {
  if (k in o && o[k] !== undefined) {
    return o[k];
  }
  if (k in query) {
    return query[k] === "disable" || query[k] === "false" ? false : query[k];
  }
  return env[`PG${k.toUpperCase()}`] || d;
};

const settings = (defaults, ints, o, query, env) => {
  const out = {};
  for (const [k, d] of Object.entries(defaults)) {
    const value = setting(k, d, o, query, env);
    out[k] = typeof value === "string" && ints.has(k) ? +value : value;
  }
  return out;
};

// The parameters of the url that go to the server as run-time parameters.
const runtime = (query, defaults) => {
  const out = {};
  for (const [k, v] of Object.entries(query)) {
    if (!(k in defaults) && !clientOnly.has(k)) {
      out[k] = v;
    }
  }
  return out;
};

// Parameters of a connection url that libpq reads itself. Any other parameter goes to the server as a
// run-time parameter, so these must not, or the server refuses the connection.
const clientOnly = new Set([
  "host",
  "port",
  "hostaddr",
  "dbname",
  "user",
  "password",
  "passfile",
  "service",
  "sslmode",
  "sslrootcert",
  "sslcert",
  "sslkey",
  "sslpassword",
  "sslcrl",
  "sslcrldir",
  "sslsni",
  "sslcompression",
  "sslcertmode",
  "sslkeylogfile",
  "ssl_min_protocol_version",
  "ssl_max_protocol_version",
  "requiressl",
  "requirepeer",
  "require_auth",
  "gssencmode",
  "gsslib",
  "gssdelegation",
  "krbsrvname",
  "keepalives",
  "keepalives_idle",
  "keepalives_interval",
  "keepalives_count",
  "tcp_user_timeout",
  "load_balance_hosts",
  "min_protocol_version",
  "max_protocol_version",
  "fallback_application_name",
  "scram_client_key",
  "scram_server_key",
  "oauth_issuer",
  "oauth_client_id",
  "oauth_client_secret",
  "oauth_scope",
]);

const sslmodes = new Set([
  "disable",
  "allow",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
]);

// The ssl option as one of libpq's sslmodes, true, false or tls.connect options. sslrootcert=system
// means verify-full, as in libpq, where a weaker mode is an error.
const sslmode = (ssl, rootcert) => {
  let x = ssl;
  if (x === "true") {
    x = true;
  }
  if (x === "disable") {
    x = false;
  }
  if (x && typeof x === "object") {
    return x;
  }

  if (rootcert === "system") {
    if (x && x !== true && x !== "verify-full") {
      throw new Error(`sslrootcert=system needs sslmode verify-full, not ${x}`);
    }
    return "verify-full";
  }

  if (!x || x === true || sslmodes.has(x)) {
    return x;
  }

  throw new Error(`sslmode ${x} is not supported`);
};

const tsa = (o, url, env) => {
  const x =
    o.target_session_attrs ||
    url.searchParams.get("target_session_attrs") ||
    env.PGTARGETSESSIONATTRS;
  if (
    !x ||
    [
      "read-write",
      "read-only",
      "primary",
      "standby",
      "prefer-standby",
    ].includes(x)
  ) {
    return x;
  }

  throw new Error(`target_session_attrs ${x} is not supported`);
};

const binding = (o, url, env) => {
  const x =
    o.channel_binding ||
    url.searchParams.get("channel_binding") ||
    env.PGCHANNELBINDING ||
    "prefer";
  if (["disable", "prefer", "require"].includes(x)) {
    return x;
  }

  throw new Error(`channel_binding ${x} is not supported`);
};

const backoff = (retries) =>
  (0.5 + Math.random() / 2) * Math.min(3 ** retries / 100, 20);

const max_lifetime = () => 60 * (30 + Math.random() * 30);

const parseTransform = (x) => {
  const value =
    typeof x.value === "function" ? x.value : x.value && x.value.from;
  return {
    column: {
      from:
        typeof x.column === "function" ? x.column : x.column && x.column.from,
      to: x.column && x.column.to,
    },
    json: x.json === true || (x.json === false ? false : undefined),
    row: {
      from: typeof x.row === "function" ? x.row : x.row && x.row.from,
      to: x.row && x.row.to,
    },
    undefined: x.undefined,
    value: {
      from: x.json === false && value && value.keys ? undefined : value,
      to: x.value && x.value.to,
    },
  };
};

const parseUrl = (url) => {
  if (!url || typeof url !== "string") {
    return { targets: [], url: { searchParams: new Map() } };
  }

  const rest = url.slice(url.indexOf("://") + 3);
  const end = rest.search(/[/?]/u);
  const authority = end === -1 ? rest : rest.slice(0, end);
  const at = authority.lastIndexOf("@");
  const userinfo = at === -1 ? "" : authority.slice(0, at);
  const colon = userinfo.indexOf(":");
  const tail = new URL(`postgres://x${end === -1 ? "" : rest.slice(end)}`);

  return {
    targets: authority.slice(at + 1)
      ? split(authority.slice(at + 1), decode)
      : [],
    url: {
      password: colon === -1 ? "" : decode(userinfo.slice(colon + 1)),
      pathname: decode(tail.pathname),
      searchParams: tail.searchParams,
      username: decode(colon === -1 ? userinfo : userinfo.slice(0, colon)),
    },
  };
};

const decode = (x) => {
  try {
    return decodeURIComponent(x);
  } catch {
    return x;
  }
};

const hosts = (o, query, url, env) => {
  const named = o.hostname || o.host || query.host;
  if (named) {
    return Array.isArray(named) ? named.map((x) => [x, null]) : split(named);
  }

  if (url.targets.some(([x]) => x)) {
    return url.targets;
  }

  return split(env.PGHOST || "localhost").map(([x, p], i) => [
    x,
    p || (url.targets[i] && url.targets[i][1]) || null,
  ]);
};

const split = (text, decoded = (x) => x) =>
  text
    .split(",")
    .filter(Boolean)
    .map((part) => {
      const m = part.match(/^\[(?<host>[^\]]*)\](?::(?<port>\d*))?$/u) ||
        part.match(/^(?<host>[^:]*)(?::(?<port>\d*))?$/u) || [part, part];
      return [decoded(m[1]), m[2] ? +m[2] : null];
    });

const passfile = (env) => {
  try {
    return (
      env.PGPASSFILE ||
      (process.platform === "win32"
        ? `${env.APPDATA || ""}\\postgresql\\pgpass.conf`
        : `${os.homedir()}/.pgpass`)
    );
  } catch {
    return null;
  }
};

const osUsername = () => {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME || process.env.USER || process.env.LOGNAME;
  }
};

const view = (known, get) =>
  new Proxy(known, {
    get: (x, oid) => (typeof oid === "symbol" ? x[oid] : get(+oid)),
  });

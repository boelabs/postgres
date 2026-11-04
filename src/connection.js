import Stream from "node:stream";

import { now, channels, listened } from "./diagnostics.js";
import { Errors, queryError } from "./errors.js";
import * as p from "./protocol.js";
import { CLOSE, Query } from "./query.js";
import Result from "./result.js";

export const slow = 100;
export const notable = 5;

const { text } = p;
const noop = () => {
  // Takes a rejection or a throw that is handled elsewhere, or deliberately ignored.
};
const ending =
  /^\s*(?:commit|end|abort|rollback(?!\s+to\b)|prepare\s+transaction)\b/iu;
const limit = 1000;
const refused = "@boelabs/postgres: query could not be built";
const skip = Symbol("skip");
const held = Symbol("held");
const unknown = 100;
const states = new WeakMap();
const after = 16;

let ids = 1;
let compiles = true;

export const Connection = (ready, options, events) => {
  const { socket } = ready;
  const { timers } = options;
  const defer = timers.nextTick || process.nextTick;
  const { transform } = options;
  const sent = [];
  const pending = [];
  const running = new Set();
  const open = new Set();
  const prepared = new Map();
  const out = p.Writer();

  let blocker = null;
  let stash = null;
  let heard = timers.now();
  let rolling = false;
  let fence = null;
  let drained = null;
  let { status } = ready;
  let flushing = false;
  let closed = null;
  let closing = null;
  let portals = 0;
  let traced = 0;
  let epoch = 0;
  let headSince = 0;
  let notables = 0;

  const ondrain = () => {
    const x = drained;
    drained = null;
    if (x) {
      x();
    }
  };

  const schedule = (immediate) => {
    if (immediate || out.length >= 65_536) {
      return flush();
    }

    if (!flushing) {
      flushing = true;
      defer(flush);
    }
    return true;
  };

  const flush = () => {
    flushing = false;
    if (closed) {
      return (out.take(), true);
    }

    return out.length ? socket.write(out.take()) : true;
  };

  const refresh = () => {
    if (blocker && !holds(blocker)) {
      blocker = null;
    }
    release();
  };

  const queue = (x) => {
    if (closed) {
      return settleError(x, copy(closed));
    }

    if (blocker && blocker.streaming && blocker.open) {
      return settleError(
        x,
        Errors.generic(
          "COPY_IN_PROGRESS",
          "You cannot execute queries during copy"
        )
      );
    }

    if (x.query) {
      x.query.state = connection.backend;
    }
    if (fence) {
      pending.splice(pending.indexOf(fence), 0, x);
    } else if (x.ends && open.size) {
      fence = x;
      pending.push(x);
    } else if (blocker || pending.length) {
      pending.push(x);
    } else {
      return (write(x), schedule());
    }

    release();
  };

  const release = () => {
    while (pending.length && pending[0] !== fence) {
      if (blocker) {
        break;
      }
      write(pending.shift());
    }

    schedule();
  };

  const write = (x) => {
    if (x.kind === "local" && sent.length === 0) {
      return queueMicrotask(() => settle(x));
    }

    const mark = out.length;
    let result;
    try {
      result = x.write(x);
    } catch (error) {
      x.own = error;
      result = skip;
    }
    if (result === held) {
      out.truncate(mark);
      x.loose = false;
      blocker = sent.find((y) => y.gate && holds(y)) || null;
      if (blocker && blocker.nosync && !blocker.flushed) {
        blocker.flushed = true;
        p.flush(out);
        schedule();
      }
      return pending.unshift(x);
    }

    if (result === skip && dismiss(x, mark)) {
      return;
    }
    if (x.fresh) {
      register(x.fresh);
    }
    if (x.portal && x.kind === "query") {
      open.add(x);
    }
    if (x.query) {
      x.query.active = sent.length === 0;
    }
    if (x.ends) {
      epoch += 1;
    }
    x.epoch = epoch;
    if (options.scheduler && sent.length === 0) {
      headSince = timers.now();
    }
    sent.push(x);
    if (holds(x)) {
      blocker = x;
    }
    if (x.trace) {
      wrote(x);
    }
  };

  // An exchange whose write threw or was skipped. True when it settles without writing anything, so
  // write must stop there.
  const dismiss = (x, mark) => {
    out.truncate(mark);
    x.fresh = null;
    x.parses = [];
    x.portal = "";
    x.open = false;
    x.flushing = false;
    x.synced = false;
    x.describing = false;
    if (x.batch) {
      x.entry = null;
      p.parse(out, "", refused);
      x.parses = [""];
      abort(x);
    } else if (!x.own || x.kind === "step" || !connection.lease) {
      x.kind = "local";
      if (x.cost >= notable) {
        notables -= 1;
      }
      x.cost = undefined;
      if (sent.length === 0) {
        queueMicrotask(() => settle(x));
      } else {
        sent.push(x);
      }
      return true;
    } else {
      x.kind = "simple";
      x.text = refused;
      x.results = [];
      x.entry = null;
      sync(x, true);
    }
    return false;
  };

  const sync = (x, refuse) => {
    if (x.synced) {
      return;
    }

    x.synced = true;
    if (refuse) {
      p.query(out, refused);
    } else {
      p.sync(out);
    }
    schedule();
  };

  const register = (entry) => {
    const current = prepared.get(entry.name);
    if (current) {
      prepared.delete(entry.name);
    }
    prepared.set(entry.name, entry);
    entry.owner.entry = entry;
    entry.owner.fresh = null;
    if (prepared.size <= limit) {
      return;
    }

    for (const [name, x] of prepared) {
      if (x.state !== "parsing") {
        prepared.delete(name);
        p.close(out, "S", name);
        return;
      }
    }
  };

  const drop = (entry) => {
    if (prepared.get(entry.name) === entry) {
      prepared.delete(entry.name);
    }
  };

  const send = (query) => {
    const { statement } = query.wire;
    const x = Exchange("query", query, connection.lease, extended);

    x.statement = statement;
    x.ends =
      statement.ends === undefined
        ? (statement.ends = ending.test(statement.text))
        : statement.ends;
    if (options.scheduler) {
      cost(x);
    }
    queue(x);
  };

  const batch = (query, parts) => {
    const b = {
      aborted: null,
      error: null,
      index: -1,
      left: parts.length,
      parts,
      query,
      results: Array.from({ length: parts.length }),
      settled: Array.from({ length: parts.length }, () => false),
    };

    for (const [i, member] of parts.entries()) {
      member.resolve = (result) => batched(b, i, null, result);
      member.reject = (error) => batched(b, i, error);
      if (b.aborted) {
        batched(b, i, skipped(b.aborted, i));
        continue;
      }

      const x = Exchange("query", member, connection.lease, extended);
      x.statement = member.wire.statement;
      x.ends =
        x.statement.ends === undefined
          ? (x.statement.ends = ending.test(x.statement.text))
          : x.statement.ends;
      x.batch = b;
      x.nosync = i < parts.length - 1;
      if (options.scheduler) {
        cost(x);
      }
      queue(x);
    }
  };

  const part = (x) => {
    sent.shift();
    if (options.scheduler) {
      timed(x);
    }
    x.done = true;
    x.open = false;
    if (x.trace) {
      traced -= 1;
    }
    if (blocker === x) {
      blocker = null;
    }
    settle(x);
    const [next] = sent;
    if (next && next.query) {
      next.query.active = true;
      if (next.cancel) {
        turn(next);
      }
    }
    release();
  };

  const abort = (x) => {
    if (x.aborted) {
      return;
    }

    x.aborted = true;
    const b = x.batch;
    const error = x.own || x.error;

    const discard = (y) => {
      if (y.entry && y.entry.owner === y && y.entry.state === "parsing") {
        y.entry.state = "stale";
      }
      y.done = true;
      if (y.trace) {
        traced -= 1;
      }
      if (y.cost >= notable) {
        notables -= 1;
      }
      settleError(y, skipped(error, b.parts.indexOf(y.query)));
    };

    b.aborted = error;
    let synced = !x.nosync && x.synced;
    const at = sent.indexOf(x);
    for (let i = at === -1 ? sent.length : at + 1; i < sent.length;) {
      const y = sent[i];
      if (y.batch === b) {
        sent.splice(i, 1);
        synced ||= !y.nosync && y.synced;
        discard(y);
        if (blocker === y) {
          blocker = null;
        }
      } else {
        i += 1;
      }
    }

    for (let i = 0; i < pending.length;) {
      const y = pending[i];
      if (y.batch === b) {
        pending.splice(i, 1);
        discard(y);
      } else {
        i += 1;
      }
    }

    if (!synced) {
      p.sync(out);
    }
    x.nosync = false;
    x.synced = true;
    schedule();
  };

  const cost = (x) => {
    const { query } = x;
    if (query.cost && !query.cursorFn && !query.streaming) {
      x.cost = query.cost.est === undefined ? unknown : query.cost.est;
    }
    if (x.cost >= notable) {
      notables += 1;
    }
  };

  const timed = (x) => {
    const t = timers.now();

    if (x.cost !== undefined) {
      if (x.cost >= notable) {
        notables -= 1;
      }
      const sample = t - headSince;
      const c = x.query.cost;
      c.est =
        c.est === undefined || sample > c.est
          ? sample
          : c.est + (sample - c.est) * 0.1;
      if (events.ontimed) {
        events.ontimed(sample, t);
      }
    }

    headSince = t;
  };

  const backlog = (t) => {
    let w = 0;
    for (let i = 0; i < sent.length; i += 1) {
      const e = sent[i].cost || 0;
      if (i === 0) {
        const elapsed = t - headSince;
        w += elapsed < e ? e - elapsed : elapsed;
      } else {
        w += e;
      }
    }

    for (const x of pending) {
      w += x.cost || 0;
    }

    return w;
  };

  const heavy = () => {
    for (const x of sent) {
      if (x.cost >= slow) {
        return true;
      }
    }

    for (const x of pending) {
      if (x.cost >= slow) {
        return true;
      }
    }

    return false;
  };

  const extended = (x) => {
    const { query } = x;
    const { built } = query.wire;
    const { statement } = x;
    const { name } = statement;
    const current = name ? prepared.get(name) : null;

    if (query.cursorFn) {
      x.rows = query.cursorRows;
      if (transaction()) {
        x.portal = `c${portals}`;
        portals += 1;
      } else {
        x.portal = "";
      }
      x.flushing = !x.portal;
    }

    const streaming = !!query.streaming;
    x.open = streaming;
    x.streaming = streaming;

    if (unsettled(current)) {
      if (!current.owner.loose) {
        throw Errors.generic(
          "STATEMENT_PENDING",
          "A statement was used before its description arrived"
        );
      }

      current.owner.gate = true;
      return held;
    }

    if (current && current !== x.previous && usable(current, statement)) {
      const b = query.isRaw === true ? null : binaries(current);
      x.entry = current;
      x.columns = b ? b.columns : current.columns;
      x.formats = b ? b.formats : null;
      x.values = serialize(current.oids, built, current);
      return run(x, name);
    }

    if (x.retried) {
      x.verify = true;
      p.parse(out, "", statement.text, built.oids);
      p.describe(out, "S", "");
      p.flush(out);
      x.describing = true;
      return;
    }

    const typed = !inferred(built);
    if (name) {
      x.fresh = Entry(name, x, typed ? built.oids : null);
    }
    if (current) {
      p.close(out, "S", name);
    }
    parse(x, name, statement.text, built.oids);
    p.describe(out, "S", name);

    if (!typed && !loose(x, built)) {
      p.flush(out);
      x.describing = true;
      return;
    }

    x.learn = true;
    x.values = typed
      ? serialize(built.oids, built, x.fresh || {})
      : untyped(built);
    run(x, name);
  };

  const binaries = (entry) => {
    if (entry.binaryOf === entry.columns) {
      return entry.binary;
    }

    const { columns } = entry;
    const formats = [];

    let binary = null;
    for (let i = 0; i < columns.length; i += 1) {
      const decode = events.binary(columns[i].type);
      formats[i] = decode ? 1 : 0;
      if (decode) {
        binary ||= [...columns];
        binary[i] = { ...columns[i], decode };
      }
    }

    entry.binaryOf = columns;
    return (entry.binary = binary && { columns: binary, formats });
  };

  const loose = (x, built) => {
    if (!events.plain || x.query.cursorFn || x.streaming) {
      return false;
    }

    const { oids, values } = built;
    for (let i = 0; i < oids.length; i += 1) {
      if (
        !oids[i] &&
        values[i] !== null &&
        !(typeof values[i] === "number" && Number.isFinite(values[i]))
      ) {
        return false;
      }
    }
    return (x.loose = true);
  };

  const untyped = (built) => {
    const { oids, values } = built;
    const texts = [];

    for (let i = 0; i < values.length; i += 1) {
      if (values[i] === null) {
        texts[i] = null;
      } else if (oids[i]) {
        texts[i] = events.serializer(oids[i])(values[i]);
      } else {
        texts[i] = `${values[i]}`;
      }
    }

    return texts;
  };

  const parse = (x, name, sql, oids) => {
    p.parse(out, name, sql, oids);
    x.parses.push(name);
  };

  const run = (x, name) => {
    const mark = out.length;
    try {
      if (x.nosync) {
        p.bind(
          out,
          x.portal,
          name,
          x.values,
          undefined,
          x.formats || undefined
        );
        p.execute(out, x.portal, x.rows);
      } else {
        p.run(out, x.portal, name, x.values, x.rows, x.flushing, x.formats);
      }
    } catch (error) {
      out.truncate(mark);
      throw error;
    }
    if (!x.flushing) {
      x.synced = true;
    }
    const oids = x.entry
      ? x.entry.oids
      : x.params || (x.loose ? null : x.query.wire.built.oids);
    if (oids) {
      debug(x.statement.text, x.values, oids);
    } else {
      x.later = true;
    }
  };

  const logged = (item, oids) => {
    if (item.later && oids) {
      item.later = false;
      debug(item.statement.text, item.values, oids);
    }
  };

  const serialize = (oids, built, cache) => {
    cache.serializers ||= oids.map(events.serializer);
    const { serializers } = cache;
    const { values } = built;
    const serialized = [];

    for (let i = 0; i < values.length; i += 1) {
      serialized[i] = values[i] === null ? null : serializers[i](values[i]);
      if (
        !(
          serialized[i] === null ||
          serialized[i] === undefined ||
          typeof serialized[i] === "string" ||
          serialized[i] instanceof Uint8Array
        )
      ) {
        Buffer.byteLength(serialized[i]);
      }
    }

    return serialized;
  };

  const transaction = () =>
    !!connection.lease && connection.lease.kind === "transaction";

  const described = (x) => {
    x.describing = false;
    const { built } = x.query.wire;
    const { name } = x.statement;
    const params = x.params || [];
    const columns = x.columns || [];

    try {
      if (x.verify) {
        const { previous } = x;
        if (previous && same(previous, params, columns)) {
          if (x.original) {
            x.own = x.original;
            return sync(x);
          }
        } else if (previous) {
          stale(previous);
          x.statement.version += 1;
        }
        x.values = serialize(params, built, {});
        return run(x, "");
      }
      const { entry } = x;
      if (entry) {
        entry.oids = params;
        entry.columns = columns;
        learned(entry, x.statement);
      }
      x.values = serialize(params, built, entry || {});
      run(x, name);
    } catch (error) {
      x.own = error;
      if (x.batch) {
        p.parse(out, "", refused);
        x.parses.push("");
        abort(x);
      } else {
        sync(x, !!connection.lease);
      }
    }
  };

  const describe = (statement, oids, query) => {
    const { promise, resolve, reject } = Promise.withResolvers();
    // As in a promise's executor: whatever throws here rejects the promise.
    try {
      const x = Exchange("describe", null, connection.lease, (item) => {
        p.parse(out, "", statement.text, oids);
        p.describe(out, "S", "");
        sync(item);
      });
      x.for = query || null;
      x.resolve = resolve;
      x.reject = reject;
      queue(x);
    } catch (error) {
      reject(error);
    }
    return promise;
  };

  const simple = (query, sql) => {
    const x = Exchange("simple", query, connection.lease, (item) => {
      debug(sql, [], []);
      p.query(out, sql);
      item.synced = true;
    });
    x.text = sql;
    x.results = [];
    x.ends = ending.test(sql);
    const streaming = !!query.streaming;
    x.open = streaming;
    x.streaming = streaming;
    if (options.scheduler) {
      cost(x);
    }
    queue(x);
  };

  const local = (query, error) => {
    queue(
      Exchange("query", query, connection.lease, () => {
        throw error;
      })
    );
  };

  const cancel = (query) => {
    if (query.parts) {
      return cancelBatch(query);
    }

    if (stash && sent[0] && sent[0].query === query) {
      sent[0].own = Errors.generic(
        "57014",
        "canceling statement due to user request"
      );
      go();
      return Promise.resolve();
    }

    if (
      running.has(query) ||
      (sent[0] && sent[0].query === query && sent[0].awaiting)
    ) {
      return (
        (query.aborted = Errors.generic(
          "57014",
          "canceling statement due to user request"
        )),
        Promise.resolve()
      );
    }
    const i = pending.findIndex((y) => y.query === query || y.for === query);

    if (i !== -1) {
      const [x] = pending.splice(i, 1);
      if (x === fence) {
        fence = null;
      }
      if (x.cost >= notable) {
        notables -= 1;
      }
      settleError(
        x,
        Errors.generic("57014", "canceling statement due to user request")
      );
      release();
      return Promise.resolve();
    }

    const x = sent.find((y) => y.query === query || y.for === query);
    if (!x) {
      return Promise.resolve();
    }

    if (x === sent[0] && x.completed) {
      return (expect(x), Promise.resolve());
    }

    if (x === sent[0] && (query.active || x.for)) {
      return cancelling(x);
    }

    quiet(x);
    const { promise, resolve, reject } = Promise.withResolvers();
    x.cancel = { reject, resolve };
    return promise;
  };

  const turn = (x) => {
    if (x.silence) {
      timers.clearTimeout(x.silence);
      x.silence = null;
    }
    const fire = () => {
      x.silence = null;
      if (closed || x.done || sent[0] !== x) {
        return x.cancel.resolve();
      }

      if (x.completed) {
        return (expect(x), x.cancel.resolve());
      }

      return cancelling(x).then(x.cancel.resolve, x.cancel.reject);
    };

    if (x.query && x.query.timedOut && options.query_timeout) {
      x.silence = timers.setTimeout(fire, options.query_timeout * 1000);
    } else {
      defer(fire);
    }
  };

  const quiet = (x) => {
    if (!options.cancel_timeout || x.silence) {
      return;
    }

    const ms = options.cancel_timeout * 1000;
    const check = () => {
      x.silence = null;
      const query = x.query || x.for;
      if (closed || x.done || !query || query.settled) {
        return;
      }

      const silent = timers.now() - heard;
      if (silent >= ms) {
        destroy(
          Errors.generic(
            "CANCEL_UNANSWERED",
            `The server sent nothing within cancel_timeout (${
              options.cancel_timeout
            } seconds) while a canceled query waited, so whether it ran is unknown`
          )
        );
      } else {
        x.silence = timers.setTimeout(check, ms - silent);
      }
    };

    x.silence = timers.setTimeout(check, ms);
  };

  const cancelling = (x) => {
    expect(x);
    return ready.cancel();
  };

  const expect = (x) => {
    if (options.cancel_timeout && !x.unanswered) {
      x.unanswered = timers.setTimeout(
        () => unanswered(x),
        options.cancel_timeout * 1000
      );
    }
  };

  const unanswered = (x) => {
    x.unanswered = null;
    const query = x.batch ? x.batch.query : x.query || x.for;
    if (closed || (x.done && !x.batch) || !query || query.settled) {
      return;
    }

    destroy(
      Errors.generic(
        "CANCEL_UNANSWERED",
        `The server did not answer within cancel_timeout (${
          options.cancel_timeout
        } seconds) after a query was canceled, ` +
          `so whether it ran is unknown`
      )
    );
  };

  const answered = (x) => {
    if (x.silence) {
      timers.clearTimeout(x.silence);
      x.silence = null;
    }
    if (x.unanswered && (!x.batch || x.batch.query.settled)) {
      timers.clearTimeout(x.unanswered);
      x.unanswered = null;
    }
  };

  const cancelBatch = (query) => {
    const x = sent.find((y) => y.batch && y.batch.query === query);
    if (x) {
      if (x === sent[0]) {
        return cancelling(x);
      }
      const { promise, resolve, reject } = Promise.withResolvers();
      x.cancel = { reject, resolve };
      return promise;
    }

    const leading = pending.find((y) => y.batch && y.batch.query === query);
    if (leading) {
      leading.own = Errors.generic(
        "57014",
        "canceling statement due to user request"
      );
      leading.write = () => {
        throw leading.own;
      };
    }
    return Promise.resolve();
  };

  const close = () => {
    if (!closing) {
      const { promise, resolve, reject } = Promise.withResolvers();
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- a plain object of ours with a single handler, not an event target
      connection.onended = resolve;
      // As in a promise's executor: a throw rejects the promise, which is only then set as closing.
      try {
        if (idle()) {
          terminate();
        }
      } catch (error) {
        reject(error);
      }
      closing = promise;
    }
    return closing;
  };

  const idle = () => sent.length === 0 && pending.length === 0;

  const terminate = () => {
    if (closed) {
      return connection.onended && connection.onended();
    }

    flush();
    socket.end(p.Terminate());
  };

  const destroy = (failure) => {
    closing ||= Promise.resolve();
    socket.destroy(failure);
  };

  const onclose = (error) => {
    if (closed) {
      return;
    }

    out.take();
    blocker = null;
    fence = null;
    notables = 0;
    const [head] = sent;
    const crashed =
      head && head.error && head.error.severity === "FATAL" ? head.error : null;
    const fatal = connection.fatal || crashed;
    connection.uncertain = !!(fatal && head && head.ends);
    closed = Errors.connection(
      closing ? "CONNECTION_DESTROYED" : "CONNECTION_CLOSED",
      options,
      ready.host,
      ready.port
    );
    closed.cause = fatal || error || undefined;
    abandon(head, crashed);
    open.clear();
    if (connection.onended) {
      connection.onended();
    }
    events.onclose(connection, closed);
  };

  // Settles everything that was waiting on the connection when it closed.
  const abandon = (head, crashed) => {
    for (const x of [...sent, ...pending]) {
      if (x.cancel) {
        x.cancel.resolve();
      }
    }
    for (const x of sent.splice(0)) {
      if (x.stream) {
        x.stream.destroy(closed);
      }
      if (x.own) {
        settle(x);
      } else if (crashed) {
        settleError(x, x === head ? crashed : copy(crashed));
      } else {
        settleError(x, copy(closed));
      }
    }
    for (const x of pending.splice(0)) {
      if (x.own) {
        settle(x);
      } else {
        settleError(x, copy(closed));
      }
    }
    for (const query of running) {
      if (!query.settled) {
        query.reject(decorate(query, copy(closed)));
      }
    }
    running.clear();
  };

  const decorate = (query, error) => queryError(error, query, options.debug);

  const settleError = (x, error) => {
    answered(x);
    if (x.kind === "describe") {
      x.reject(error);
    } else if (x.query && !x.query.settled) {
      x.query.reject(decorate(x.query, error));
    }
  };

  const debug = (sql, values, oids) => {
    if (typeof options.debug === "function") {
      options.debug(connection.id, sql, values, oids);
    }
  };

  const wrote = (x) => {
    const { trace } = x;
    traced += 1;
    trace.query = x.text || x.statement.text;
    trace.statement = x.statement ? x.statement.name : "";
    trace.parameters = options.debug ? x.query.parameters : undefined;
    trace.connection = connection.id;
    trace.host = connection.host;
    trace.port = connection.port;
    trace.sent = now();
  };

  const first = () => {
    const [x] = sent;
    if (x && x.trace && x.trace.firstByte === null) {
      x.trace.firstByte = now();
    }
  };

  const frame = (type, x, start, end) => {
    if (
      !events.typed &&
      stash === null &&
      (type === 84 || type === 116) &&
      events.unknown(
        type === 84
          ? p.rowDescription(x, start, end, oidOf)
          : p.parameterDescription(x, start)
      )
    ) {
      stash = { type, x: Buffer.from(x.subarray(start, end)) };
      frames.pause();
      return events.need(connection);
    }

    dispatch(type, x, start, end);
  };

  const go = () => {
    if (!stash) {
      return;
    }

    const { type, x } = stash;
    dispatch(type, x, 0, x.length);
    stash = null;
    frames.resume();
  };

  const dispatch = (type, x, start, end) => {
    if (traced) {
      first();
    }
    try {
      handle(type, x, start, end);
    } catch (error) {
      const [head] = sent;
      if (head) {
        fail(head, error);
      } else {
        destroy(error);
      }
    }
    if (blocker && !holds(blocker)) {
      blocker = null;
      release();
    }
    if (out.length) {
      schedule();
    }
  };

  // The messages of a query's flow, rows first since they are most of the traffic.
  const handle = (type, x, start, end) => {
    switch (type) {
      case 68: {
        DataRow(x, start);
        break;
      }
      case 100: {
        CopyData(x, start, end);
        break;
      }
      case 90: {
        ReadyForQuery(x, start);
        break;
      }
      case 67: {
        CommandComplete(x, start, end);
        break;
      }
      case 50: {
        BindComplete();
        break;
      }
      case 49: {
        ParseComplete();
        break;
      }
      case 51: {
        break;
      }
      case 116: {
        ParameterDescription(x, start);
        break;
      }
      case 84: {
        RowDescription(x, start);
        break;
      }
      case 110: {
        NoData();
        break;
      }
      case 69: {
        ErrorResponse(x, start, end);
        break;
      }
      default: {
        handleOther(type, x, start, end);
      }
    }
  };

  const handleOther = (type, x, start, end) => {
    switch (type) {
      case 115: {
        PortalSuspended();
        break;
      }
      case 73: {
        EmptyQueryResponse();
        break;
      }
      case 65: {
        NotificationResponse(x, start);
        break;
      }
      case 78: {
        NoticeResponse(x, start, end);
        break;
      }
      case 83: {
        ParameterStatus(x, start);
        break;
      }
      case 71: {
        CopyInResponse();
        break;
      }
      case 72: {
        CopyOutResponse();
        break;
      }
      case 87: {
        CopyBothResponse();
        break;
      }
      case 99: {
        CopyDone();
        break;
      }
      case 86: {
        unsupported("FunctionCallResponse");
        break;
      }
      case 118: {
        unsupported("NegotiateProtocolVersion");
        break;
      }
      default:
      // A message of any other type is ignored.
    }
  };

  const fail = (x, error) => {
    x.error ||= error;
    x.describing = false;
    x.open = false;
    if (x.batch) {
      abort(x);
    } else {
      sync(x);
    }
  };

  const unsupported = (x) => {
    if (sent[0]) {
      fail(sent[0], Errors.notSupported(x));
    }
  };

  const ParseComplete = () => {
    const [x] = sent;
    const name = x.parses.shift();

    if (
      name &&
      x.entry &&
      x.entry.name === name &&
      x.entry.owner === x &&
      x.entry.state === "parsing"
    ) {
      x.entry.state = "ready";
    }
  };

  const BindComplete = () => {
    const [x] = sent;
    x.bound = true;
    if (!x.columns && x.entry) {
      x.columns = x.entry.columns;
      x.result.columns = x.columns;
    }
  };

  const ParameterDescription = (x, start) => {
    const [item] = sent;
    item.params = p.parameterDescription(x, start);
    if (
      item.loose &&
      item.entry &&
      item.entry.owner === item &&
      item.entry.oids === null
    ) {
      item.entry.oids = item.params;
    }
    logged(item, item.params);
  };

  const RowDescription = (x, start) => {
    received(sent[0], p.rowDescription(x, start, 0, column));
  };

  const NoData = () => {
    received(sent[0], []);
  };

  const received = (x, columns) => {
    if (x.kind === "simple" && x.result.command !== null) {
      x.results.push(x.result);
      x.result = new Result();
    }
    x.columns = columns;
    x.result.columns = columns;
    if (x.learn) {
      x.learn = false;
      if (x.entry && x.entry.owner === x) {
        x.entry.columns = columns;
        learned(x.entry, x.statement);
      }
    }
    if (x.describing) {
      described(x);
    }
  };

  const column = (name, table, number, type) => {
    const parser = events.parser(type);
    // oxlint-disable-next-line sort-keys -- users see a column's keys in this order, and transform.column.from runs before the decoder is made
    return {
      name: transform.column.from ? transform.column.from(name) : name,
      parser: parser.identity ? null : parser,
      decode: events.decoder(type, parser),
      table,
      number,
      type,
    };
  };

  const DataRow = (x, start) => {
    const [item] = sent;
    const { query, columns } = item;
    const raw = query.isRaw;
    const from = raw === true ? null : transform.value.from;
    const shape =
      item.shaped === columns
        ? item.reader
        : ((item.shaped = columns), (item.reader = Rows(columns)));
    const fast = raw !== true && read(shape, !!raw, text, from);
    const n = columns.length;
    const { result } = item;

    let row;
    if (fast) {
      row = fast(x, start + 7);
    } else {
      row = raw ? [] : {};
      let i = start + 7;
      for (let j = 0; j < n; j += 1) {
        const length =
          (x[i] << 24) | (x[i + 1] << 16) | (x[i + 2] << 8) | x[i + 3];
        const field = columns[j];
        i += 4;
        let value = null;
        if (length !== -1) {
          if (raw === true) {
            value = Buffer.from(x.subarray(i, i + length));
          } else if (field.decode) {
            value = field.decode(x, i, i + length);
          } else if (field.parser) {
            value = field.parser(text(x, i, i + length));
          } else {
            value = text(x, i, i + length);
          }
          i += length;
        }
        if (from) {
          value = from(value, field);
        }
        if (raw) {
          row[j] = value;
        } else if (field.name === "__proto__") {
          own(row, field.name, value);
        } else {
          row[field.name] = value;
        }
      }
    }

    const output = transform.row.from ? transform.row.from(row) : row;
    if (query.forEachFn) {
      query.forEachFn(output, result);
    } else {
      result[result.length] = output;
    }
  };

  const CommandComplete = (x, start, end) => {
    const [item] = sent;
    const { command, count } = p.commandComplete(x, start, end);
    const { result } = item;

    result.command = command;
    result.count = count;
    result.state = connection.backend;
    result.statement = item;
    if (item.query) {
      item.query.source = item;
    }
    result.columns ||= item.columns;

    if (item.final) {
      if (item.stream) {
        // oxlint-disable-next-line sort-keys -- the order the stream's own properties are listed in
        Object.assign(item.stream, { count, command });
      }
      item.final();
      item.final = null;
    }
    if (item.kind !== "simple") {
      item.completed = true;
    }

    if (item.kind === "simple") {
      item.results.push(item.result);
      item.result = new Result();
      return;
    }

    if (item.rows) {
      item.finished = true;
      if (item.flushing) {
        sync(item);
      }
      if (result.count) {
        item.last = attempt(() => item.query.cursorFn(result));
        item.last.catch(noop);
      }
    }

    if (item.nosync && !item.error) {
      part(item);
    }
  };

  const unsafe = (item) => {
    rolling = true;
    item.own = unsafeTransaction();
    for (const x of sent) {
      if (x.kind !== "local") {
        x.own = unsafeTransaction();
      }
    }
    pending.unshift(
      Exchange("internal", null, null, (x) => {
        p.query(out, "rollback");
        x.synced = true;
        return true;
      })
    );
  };

  const EmptyQueryResponse = () => {
    const [item] = sent;
    if (item.kind === "simple") {
      item.results.push(item.result);
      item.result = new Result();
    }
    if (item.nosync && !item.error) {
      part(item);
    }
  };

  const PortalSuspended = async () => {
    const [item] = sent;
    if (!item.flushing) {
      return (item.suspended = true);
    }

    try {
      item.awaiting = true;
      const next = await item.query.cursorFn(item.result);
      item.awaiting = false;
      item.result = new Result();
      if (closed || item.synced || sent[0] !== item) {
        return;
      }
      if (item.query.aborted) {
        throw item.query.aborted;
      }
      if (next === CLOSE) {
        p.close(out, "P", "");
        sync(item);
      } else {
        p.execute(out, "", item.rows);
        p.flush(out);
        schedule();
      }
    } catch (error) {
      item.awaiting = false;
      if (closed || item.synced || sent[0] !== item) {
        return;
      }
      fail(item, error);
    }

    refresh();
  };

  const ErrorResponse = (x, start, end) => {
    const [item] = sent;
    const error = Errors.postgres(p.error(x, start, end));

    if (!item) {
      return (connection.fatal = error);
    }

    if (item.stream) {
      item.stream.destroy(error);
    }
    if (item.final) {
      item.final(error);
      item.final = null;
    }
    fail(item, error);
  };

  const ReadyForQuery = (x, start) => {
    status = p.readyForQuery(x, start);
    frames.own(false);
    const item = sent.shift();
    if (options.scheduler) {
      timed(item);
    }
    item.done = true;
    item.open = false;
    if (item.trace) {
      traced -= 1;
    }
    if (item.kind === "internal") {
      rolling = false;
    }
    if (
      status !== "I" &&
      !rolling &&
      !item.lease &&
      !connection.lease &&
      options.max !== 1
    ) {
      unsafe(item);
    }
    if (blocker === item) {
      blocker = null;
    }
    settle(item);
    if (item.entry && item.entry.owner === item) {
      item.entry.owner = null;
    }
    while (sent.length && sent[0].kind === "local") {
      settle(sent.shift());
    }
    release();

    const [next] = sent;
    if (next && next.query) {
      next.query.active = true;
      if (next.cancel) {
        turn(next);
      }
    }

    if (closing && idle()) {
      terminate();
    }
    events.onready(connection);
  };

  const settle = (x) => {
    answered(x);
    if (x.kind === "internal") {
      return;
    }

    if (x.kind === "describe") {
      return x.error
        ? x.reject(x.error)
        : x.resolve({ columns: x.columns, params: x.params || [] });
    }

    const { query } = x;
    const cursor = x.origin || (x.portal ? x : null);
    if (cursor && (x.own || x.error || !x.suspended)) {
      unfence(cursor);
    }

    if (x.own) {
      return query.reject(decorate(query, x.own));
    }

    if (x.error) {
      return failed(x);
    }

    if (x.suspended) {
      return suspended(x);
    }

    if (x.last) {
      return x.last.then(
        () => query.settled || finish(x),
        (cursorError) =>
          query.settled || query.reject(decorate(query, cursorError))
      );
    }
    if (!query.settled) {
      finish(x);
    }
  };

  const unfence = (cursor) => {
    if (!open.delete(cursor) || open.size || !fence) {
      return;
    }
    fence = null;
    release();
  };

  const failed = (x) => {
    const entry = x.kind === "query" ? x.entry : null;
    const parsing =
      x.fresh || (entry && entry.owner === x && entry.state === "parsing");

    if (
      x.error.code === "42P05" &&
      x.kind === "query" &&
      x.statement.name &&
      parsing
    ) {
      if (entry) {
        drop(entry);
      }
      x.statement.name += "_";
      return retryable(x) ? again(x, null) : settleError(x, x.error);
    }

    if (!entry) {
      return settleError(x, x.error);
    }

    if (entry.owner === x && entry.state === "parsing") {
      return (drop(entry), settleError(x, x.error));
    }

    if (x.error.code === "26000") {
      drop(entry);
      return retryable(x) ? again(x, null) : settleError(x, x.error);
    }

    if (x.bound) {
      return settleError(x, x.error);
    }

    if (retryable(x)) {
      return again(x, x.error);
    }

    stale(entry);
    settleError(x, x.error);
  };

  const stale = (entry) => {
    if (prepared.get(entry.name) === entry) {
      entry.state = "stale";
    }
  };

  const retryable = (x) =>
    !x.retried &&
    !x.batch &&
    !x.cancel &&
    !x.query.cancelled &&
    !x.query.cursorFn &&
    !x.streaming &&
    x.lease === connection.lease &&
    status === "I" &&
    !closing &&
    (sent.length === 0 || (!x.lease && options.max !== 1));

  const again = (x, original) => {
    const retry = Exchange("query", x.query, x.lease, extended);
    retry.statement = x.statement;
    retry.ends = x.ends;
    retry.retried = true;
    retry.original = original;
    retry.previous = x.entry;
    retry.trace = x.trace;
    retry.cost = x.cost;

    if (sent.length) {
      return queue(retry);
    }

    pending.unshift(retry);
    release();
  };

  const suspended = (x) => {
    const cursor = x.origin || x;
    const { query } = x;

    running.add(query);

    return attempt(() => query.cursorFn(x.result)).then(
      (next) => {
        running.delete(query);
        if (query.settled) {
          return unfence(cursor);
        }
        queue(
          step(cursor, next === CLOSE || !!query.aborted, query.aborted || null)
        );
        return null;
      },
      (cursorError) => {
        running.delete(query);
        if (query.settled) {
          return unfence(cursor);
        }
        queue(step(cursor, true, cursorError));
      }
    );
  };

  const step = (cursor, end, failure) => {
    const x = Exchange("step", cursor.query, cursor.lease, stepped);
    x.origin = cursor;
    x.statement = cursor.statement;
    x.entry = cursor.entry;
    x.columns = cursor.columns;
    x.portal = cursor.portal;
    x.rows = cursor.rows;
    x.end = end;
    x.failure = failure;
    return x;
  };

  const stepped = (x) => {
    const cursor = x.origin;

    if (connection.lease !== cursor.lease || cursor.epoch !== epoch) {
      if (x.failure) {
        throw x.failure;
      }
      if (!x.end) {
        throw outlived();
      }
      return skip;
    }

    x.own = x.failure;
    if (x.end) {
      p.close(out, "P", x.portal);
    } else {
      p.execute(out, x.portal, x.rows);
    }
    sync(x);
  };

  const NotificationResponse = (x, start) => {
    const { pid, channel, payload } = p.notification(x, start);
    if (events.onnotify) {
      guard(events.onnotify, channel, payload, pid);
    }
  };

  const NoticeResponse = (x, start, end) => {
    const notice = p.error(x, start, end);
    if (listened(channels.notice)) {
      // oxlint-disable-next-line sort-keys -- subscribers see the message's keys in this order
      channels.notice.publish({
        notice,
        connection: connection.id,
        host: connection.host,
        port: connection.port,
        database: options.database,
      });
    }
    if (options.onnotice) {
      guard(options.onnotice, notice);
    } else if (options.onnotice !== false) {
      console.log(notice);
    }
  };

  const ParameterStatus = (x, start) => {
    const [k, v] = p.parameterStatus(x, start);
    connection.parameters[k] = v;
    if (events.onparameter) {
      guard(events.onparameter, k, v);
    }
  };

  const writeData = (chunk, done) => {
    p.copyData(out, chunk);
    if (flush()) {
      done();
    } else {
      drained = done;
    }
  };

  const writable = (item) => ({
    autoDestroy: true,
    destroy(error, done) {
      done(error);
      item.stream = null;
      if (!item.copied && !closed && !item.error) {
        p.copyFail(out, `${error || "The COPY stream was destroyed"}`);
        item.copied = true;
        item.open = false;
        schedule(true);
        refresh();
      }
    },
    final(done) {
      p.copyDone(out);
      item.copied = true;
      item.open = false;
      item.final = done;
      schedule(true);
      refresh();
    },
    write(chunk, encoding, done) {
      writeData(chunk, done);
    },
  });

  const CopyInResponse = () => {
    const [item] = sent;
    item.stream = new Stream.Writable(writable(item));
    item.query.resolve(item.stream);
  };

  const readable = (item) => () => {
    item.wanted = true;

    if (!frames.paused) {
      return;
    }

    frames.resume();
    if (!frames.paused) {
      socket.resume();
    }
  };

  const CopyOutResponse = () => {
    const [item] = sent;
    item.stream = new Stream.Readable({ read: readable(item) });
    item.open = false;
    frames.own(true);
    item.query.resolve(item.stream);
  };

  const CopyBothResponse = () => {
    const [item] = sent;
    item.stream = new Stream.Duplex({
      ...writable(item),
      read: readable(item),
    });
    frames.own(true);
    item.query.resolve(item.stream);
  };

  const CopyData = (x, start, end) => {
    const [item] = sent;

    if (!item.stream) {
      return;
    }

    item.wanted = false;
    if (
      !item.stream.push(
        frames.owns(x)
          ? x.subarray(start + 5, end)
          : Buffer.from(x.subarray(start + 5, end))
      ) &&
      !item.wanted
    ) {
      frames.pause();
      socket.pause();
    }
  };

  const CopyDone = () => {
    frames.own(false);
    const [item] = sent;
    if (item.stream) {
      item.stream.push(null);
    }
    item.stream = null;
  };

  const frames = p.Frames(frame, socket.shared, (failure) => {
    connection.fatal = failure;
    return socket.destroy();
  });

  const id = ids;
  ids += 1;
  const connection = {
    backend: ready.backend,
    backlog,
    batch,
    cancel,
    close,
    get closed() {
      return closed;
    },
    get closing() {
      return !!closing;
    },
    get copying() {
      return !!blocker && blocker.streaming && blocker.open;
    },
    describe,
    destroy,
    get exclusive() {
      return !!blocker && exclusive(blocker);
    },
    go,
    heavy,
    host: ready.host,
    id,
    get inflight() {
      return sent.length + pending.length;
    },
    lease: null,
    local,
    get notable() {
      return notables > 0;
    },
    parameters: ready.parameters,
    port: ready.port,
    prepared,
    ref: () => socket.ref(),
    send,
    simple,
    get status() {
      return status;
    },
    unref: () => socket.unref(),
  };

  socket.ondata = (x) => {
    heard = timers.now();
    return frames.push(x);
  };
  socket.ondrain = ondrain;
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the socket is our own wrapper, which takes a single handler as a property
  socket.onclose = onclose;
  if (ready.rest && ready.rest.length) {
    frames.push(ready.rest);
  }
  socket.resume();

  return connection;
};

const holds = (x) =>
  x.describing ||
  (x.gate && x.learn && !x.error) ||
  (!!x.error && !x.done) ||
  (x.flushing && !x.synced) ||
  (x.streaming && x.open) ||
  (x.alone && !x.done);

const exclusive = (x) => x.flushing || x.streaming || x.alone;

// A statement being parsed for another query, whose parameter types are not known yet.
const unsettled = (entry) =>
  entry &&
  entry.state === "parsing" &&
  entry.oids === null &&
  entry.owner &&
  !entry.owner.error;

const usable = (entry, statement) =>
  entry.oids !== null &&
  (entry.state === "parsing" ||
    (entry.state === "ready" && entry.version === statement.version));

const learned = (entry, statement) => {
  const shape = `${entry.oids.join(",")}:${entry.columns.map((x) => x.type).join(",")}`;
  if (statement.shape !== shape) {
    if (statement.shape !== undefined) {
      statement.version += 1;
    }
    statement.shape = shape;
  }
  entry.version = statement.version;
};

const inferred = (built) => {
  for (const oid of built.oids) {
    if (!oid) {
      return true;
    }
  }
  return false;
};

const same = (entry, params, columns) => {
  const a = entry.oids || [];
  const b = entry.columns;

  return (
    !!b &&
    a.length === params.length &&
    params.every((x, i) => x === a[i]) &&
    b.length === columns.length &&
    columns.every((x, i) => x.type === b[i].type)
  );
};

const batched = (b, i, error, result) => {
  if (b.settled[i]) {
    return;
  }

  b.settled[i] = true;
  b.left -= 1;
  if (error) {
    if (b.error === null || (i < b.index && !error.skipped)) {
      b.error = error;
      b.index = i;
    }
  } else {
    b.results[i] = result;
  }

  if (b.left) {
    return;
  }

  const { query, parts, results } = b;
  if (b.error) {
    b.error.index = b.index;
    for (const [j, member] of parts.entries()) {
      Query.prototype.reject.call(
        member,
        j === b.index ? b.error : skipped(b.error, b.index)
      );
      member.catch(noop);
    }
    return query.reject(b.error);
  }

  for (const [j, member] of parts.entries()) {
    Query.prototype.resolve.call(member, results[j]);
  }
  query.resolve(results);
};

const skipped = (error, index) => {
  const x = copy(error);
  x.index = index;
  x.skipped = true;
  return x;
};

const unsafeTransaction = () =>
  Errors.generic(
    "UNSAFE_TRANSACTION",
    "Only use sql.begin, sql.reserved or max: 1"
  );

const outlived = () =>
  Errors.generic("UNSAFE_TRANSACTION", "The cursor outlived its transaction");

const finish = (x) => {
  const { query } = x;

  if (x.kind === "simple") {
    if (x.result.command !== null) {
      x.results.push(x.result);
    }
    const { results } = x;
    return query.resolve(results.length > 1 ? results : results[0] || x.result);
  }

  query.resolve(x.result);
};

const guard = (fn, ...xs) => {
  try {
    fn(...xs);
  } catch (error) {
    noop(error);
  }
};

// What new Promise((resolve) => resolve(fn())) gives: fn runs now, and its throw rejects.
const attempt = (fn) => {
  const { promise, resolve, reject } = Promise.withResolvers();
  try {
    resolve(fn());
  } catch (error) {
    reject(error);
  }
  return promise;
};

const oidOf = (name, table, number, type) => type;

const copy = (error) => {
  const x = Object.create(
    Object.getPrototypeOf(error),
    Object.getOwnPropertyDescriptors(error)
  );
  Object.defineProperty(x, "stack", {
    configurable: true,
    value: error.stack,
    writable: true,
  });
  delete x.query;
  delete x.parameters;
  delete x.args;
  delete x.types;
  return x;
};

const key = (name) => {
  const x = JSON.stringify(String(name));
  return name === "__proto__" ? `[${x}]` : x;
};

export const own = (row, name, value) => {
  Object.defineProperty(row, name, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
};

const Exchange = (kind, query, lease, write) => ({
  aborted: false,
  alone: !!(query && query.alone),
  batch: null,
  bound: false,
  cancel: null,
  columns: null,
  completed: false,
  copied: false,
  cost: undefined,
  describing: false,
  done: false,
  end: false,
  ends: false,
  entry: null,
  epoch: 0,
  error: null,
  failure: null,
  final: null,
  finished: false,
  flushed: false,
  flushing: false,
  for: null,
  formats: null,
  fresh: null,
  gate: false,
  kind,
  later: false,
  learn: false,
  lease,
  loose: false,
  nosync: false,
  open: false,
  origin: null,
  original: null,
  own: null,
  params: null,
  parses: [],
  portal: "",
  previous: null,
  query,
  reader: null,
  reject: null,
  resolve: null,
  result: new Result(),
  results: null,
  retried: false,
  rows: 0,
  shaped: null,
  silence: null,
  statement: null,
  stream: null,
  streaming: false,
  suspended: false,
  synced: false,
  text: "",
  trace: (query && query.trace) || null,
  unanswered: null,
  values: null,
  verify: false,
  wanted: false,
  write,
});

const Entry = (name, owner, oids) => ({
  binary: null,
  binaryOf: null,
  columns: null,
  name,
  oids,
  owner,
  serializers: null,
  state: "parsing",
  version: -1,
});

const Rows = (columns) => {
  let state = states.get(columns);
  if (state === undefined) {
    state = {
      array: null,
      columns,
      compilable:
        compiles &&
        columns.length <= 512 &&
        !columns.some((x) => String(x.name) === "__proto__"),
      object: null,
      seen: 0,
    };
    states.set(columns, state);
  }
  return state;
};

const read = (state, array, toText, from) => {
  const slot = array ? "array" : "object";

  if (state[slot] !== null) {
    return state[slot];
  }

  if (!state.compilable) {
    return null;
  }
  state.seen += 1;
  if (state.seen < after) {
    return null;
  }

  try {
    return (state[slot] = compile(state.columns, array, toText, from));
  } catch {
    state.compilable = false;
    compiles = false;
    return null;
  }
};

const compile = (columns, array, toText, from) => {
  const locals = [];
  const body = ["let l = 0"];
  const at = "x, i, i + l";

  for (const [j, c] of columns.entries()) {
    let value;
    if (c.decode) {
      locals.push(`d${j} = c[${j}].decode`);
      value = `d${j}(${at})`;
    } else if (c.parser) {
      locals.push(`p${j} = c[${j}].parser`);
      value = `p${j}(text(${at}))`;
    } else {
      value = `text(${at})`;
    }
    body.push(
      "l = (x[i] << 24) | (x[i + 1] << 16) | (x[i + 2] << 8) | x[i + 3]",
      "i += 4",
      `let v${j} = null`,
      `l !== -1 && (v${j} = ${value}, i += l)`,
      from ? `v${j} = from(v${j}, c[${j}])` : ""
    );
  }

  body.push(
    array
      ? `return [${columns.map((c, j) => `v${j}`).join(",")}]`
      : `return {${columns.map((c, j) => `${key(c.name)}:v${j}`).join(",")}}`
  );

  // oxlint-disable-next-line no-new-func -- the row decoder, generated once per row shape because reading rows through it is much faster
  return new Function(
    "c",
    "text",
    "from",
    `${
      locals.length ? `const ${locals.join(", ")}\n` : ""
    }return function row(x, i) {\n${body.filter(Boolean).join("\n")}\n}`
  )(columns, toText, from);
};

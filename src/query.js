import { inspect } from "node:util";

import { build, isQuery, Join, joinStrings } from "./build.js";
import {
  channels,
  active,
  start,
  finish,
  now,
  userName,
} from "./diagnostics.js";
import { ours, Errors, queryError } from "./errors.js";
import { statement } from "./result.js";

const origins = new WeakMap();
const noop = () => {
  // A cancel that fails is not the query's failure: it is ignored.
};

export const CLOSE = {};

export class Query extends Promise {
  constructor(strings, args, handler, options = {}) {
    let resolve;
    let reject;

    super((a, b) => {
      resolve = a;
      reject = b;
    });

    this.fulfil = resolve;
    this.fail = reject;

    this[isQuery] = true;
    this.tagged = Array.isArray(strings.raw);
    this.strings = strings;
    this.args = args;
    this.handler = handler;
    this.options = options;

    this.state = null;
    this.source = null;
    this.active = false;
    this.executed = false;
    this.settled = false;
    this.built = null;
    this.trace = null;
    this.aborts = null;
    this.timer = null;
    this.timedOut = false;

    // oxlint-disable-next-line unicorn/error-message -- only its stack is kept, and shown as it is
    this.originError = handler.debug ? new Error() : null;
    if (this.tagged && !handler.debug && !origins.has(strings)) {
      origins.set(strings, located());
    }
  }

  static get [Symbol.species]() {
    return Promise;
  }

  join(items) {
    const kept = [...items].filter(
      (x) => x !== false && x !== null && x !== undefined
    );
    const joined = new Query(joinStrings, [new Join(this, kept)], this.handler);

    Object.defineProperty(joined, "length", { value: kept.length });
    return joined;
  }

  resolve(x) {
    if (this.timer) {
      untime(this);
    }
    if (this.aborts) {
      this.aborts();
    }
    this.active = false;
    this.settled = true;
    if (this.trace) {
      traced(this, null, x);
    }
    this.fulfil(x);
  }

  reject(reason) {
    let x = reason;
    if (this.timer) {
      untime(this);
    }
    if (this.timedOut && x && timedOut(x)) {
      x = late(this, x);
    }
    if (this.aborts) {
      this.aborts();
    }
    this.active = false;
    this.settled = true;
    if (this.trace) {
      traced(this, x);
    }
    this.fail(x);
  }

  get origin() {
    return this.originError
      ? this.originError.stack
      : (this.tagged && origins.get(this.strings)) || "";
  }

  get statement() {
    return this.source && statement(this.source);
  }

  build() {
    return (this.built ||= build(this, this.handler.options));
  }

  get text() {
    return this.build().text;
  }

  get parameters() {
    return this.build().values;
  }

  [inspect.custom](depth, options, nested) {
    if (!this.handler.debug) {
      return "Query {}";
    }

    let x;
    try {
      x = this.build();
    } catch (error) {
      return `Query { ${error.message} }`;
    }
    // oxlint-disable-next-line sort-keys -- the order in which inspect prints them
    return `Query ${nested({ text: x.text, parameters: x.values }, options)}`;
  }

  cancel() {
    return this.handler.cancel ? this.handler.cancel(this) : Promise.resolve();
  }

  signal(signal) {
    if (!signal || this.settled) {
      return this;
    }

    if (signal.aborted) {
      return (this.cancel().catch(noop), this);
    }

    const abort = () => this.cancel().catch(noop);
    signal.addEventListener("abort", abort, { once: true });
    this.aborts = () => {
      this.aborts = null;
      signal.removeEventListener("abort", abort);
    };
    return this;
  }

  simple() {
    this.options.simple = true;
    this.options.prepare = false;
    return this;
  }

  // oxlint-disable-next-line require-await -- the API returns a promise, which adopts the query
  async readable() {
    this.simple();
    this.streaming = true;
    return this;
  }

  // oxlint-disable-next-line require-await -- the API returns a promise, which adopts the query
  async writable() {
    this.simple();
    this.streaming = true;
    return this;
  }

  // oxlint-disable-next-line default-param-last -- cursor(fn) and cursor(rows, fn) are both the API, and cursor.length stays 0
  cursor(rows = 1, fn) {
    this.options.simple = false;
    const callback = typeof rows === "function" ? rows : fn;
    this.cursorRows = typeof rows === "function" ? 1 : rows;

    if (typeof callback === "function") {
      this.cursorFn = callback;
      return this;
    }

    let prev;
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (this.executed && !this.active) {
            return { done: true };
          }

          if (prev) {
            prev();
          }
          const { promise, resolve, reject } = Promise.withResolvers();
          this.cursorFn = (value) => {
            resolve({ done: false, value });
            const consumed = Promise.withResolvers();
            prev = consumed.resolve;
            return consumed.promise;
          };
          this.resolve = (x) => {
            this.active = false;
            this.settled = true;
            if (this.trace) {
              traced(this, null, x);
            }
            resolve({ done: true });
          };
          this.reject = (x) => {
            this.active = false;
            this.settled = true;
            if (this.trace) {
              traced(this, x);
            }
            reject(x);
          };
          this.execute();
          return promise;
        },
        return() {
          if (prev) {
            prev(CLOSE);
          }
          return { done: true };
        },
      }),
    };
  }

  describe() {
    this.options.simple = false;
    this.options.prepare = true;
    this.onlyDescribe = true;
    return this;
  }

  // oxlint-disable-next-line class-methods-use-this -- a method of the query API, kept to point to its new name
  stream() {
    throw new Error(".stream has been renamed to .forEach");
  }

  forEach(fn) {
    this.forEachFn = fn;
    this.handle();
    return this;
  }

  raw() {
    this.isRaw = true;
    return this;
  }

  values() {
    this.isRaw = "values";
    return this;
  }

  handle() {
    if (this.executed) {
      return;
    }

    this.executed = true;
    queueMicrotask(() => this.run());
  }

  run() {
    if (active(channels.query)) {
      this.trace = context(this);
      start(channels.query, this.trace, () => this.handler(this));
    } else {
      this.handler(this);
    }
  }

  execute() {
    this.handle();
    return this;
  }

  // oxlint-disable-next-line unicorn/no-thenable -- a query is a promise that runs when awaited
  then(fulfilled, rejected) {
    this.handle();
    return super.then(fulfilled, rejected);
  }

  catch(rejected) {
    this.handle();
    return super.catch(rejected);
  }

  finally(fn) {
    this.handle();
    return super.finally(fn);
  }
}

const untime = (q) => {
  q.handler.options.timers.clearTimeout(q.timer);
  q.timer = null;
};

const timedOut = (x) =>
  x.code === "57014" ||
  (x.code === "CONNECTION_DESTROYED" &&
    !!x.cause &&
    x.cause.code === "CANCEL_UNANSWERED");

const late = (q, error) => {
  const x = Errors.generic(
    "QUERY_TIMEOUT",
    `The query did not finish within query_timeout (${
      q.handler.options.query_timeout
    } seconds)`
  );
  x.cause = error.code === "CONNECTION_DESTROYED" ? error.cause : error;
  return queryError(x, q, q.handler.debug);
};

const context = (q) => {
  const options = q.handler.options || {};
  let text = null;
  if (q.strings.length) {
    try {
      ({ text } = q);
    } catch {
      text = null;
    }
  }
  // oxlint-disable-next-line sort-keys -- subscribers to diagnostics_channel see the fields in this order
  return {
    query: text,
    parameters: undefined,
    database: options.database,
    user: userName(options),
    host: null,
    port: null,
    connection: null,
    statement: null,
    command: null,
    count: null,
    queued: now(),
    sent: null,
    firstByte: null,
    complete: null,
  };
};

const traced = (q, error, result) => {
  const x = q.trace;
  q.trace = null;
  x.complete = now();
  if (result && typeof result === "object" && "command" in result) {
    x.command = result.command;
    x.count = result.count;
  }
  finish(channels.query, x, error, result);
};

const located = () => {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 8;
  try {
    // oxlint-disable-next-line unicorn/error-message -- only the stack is kept, and shown as it is
    return trim(String(new Error().stack));
  } catch {
    return "";
  } finally {
    Error.stackTraceLimit = limit;
  }
};

const trim = (stack) => {
  const lines = stack.split("\n");
  const i = lines.findIndex((line, index) => index > 0 && !ours(line));

  return i === -1 ? stack : lines.slice(0, i + 1).join("\n");
};

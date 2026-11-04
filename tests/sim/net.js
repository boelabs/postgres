import { EventEmitter } from "node:events";

export const Random = (seed) => {
  let x = seed >>> 0;
  const next = () => {
    x = (x + 0x6d_2b_79_f5) >>> 0;
    let t = Math.imul(x ^ (x >>> 15), 1 | x);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };

  return {
    chance: (p) => next() < p,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    next,
    pick: (xs) => xs[Math.floor(next() * xs.length)],
  };
};

export const Clock = (
  onerror = (e) => {
    throw e;
  }
) => {
  const timers = new Map();
  const realImmediate = setImmediate;
  let now = 0;
  let seq = 0;

  const add = (fn, ms, args) => {
    seq += 1;
    const id = {
      at: now + Math.max(0, +ms || 0),
      fn: () => fn(...args),
      hasRef: () => true,
      ref: () => id,
      seq,
      unref: () => id,
      [Symbol.toPrimitive]: () => id.seq,
    };
    timers.set(id.seq, id);
    return id;
  };
  const clear = (id) => id && timers.delete(id.seq);

  return {
    get now() {
      return now;
    },
    get pending() {
      return timers.size;
    },
    pendingTimers: () => [...timers.values()],
    async run(until = Infinity) {
      let same = 0;
      let at = now;
      while (true) {
        const { promise, resolve } = Promise.withResolvers();
        realImmediate(resolve);
        // oxlint-disable-next-line no-await-in-loop -- each timer runs on its own turn of the real event loop, after the microtasks of the one before
        await promise;
        same = now === at ? same + 1 : 0;
        at = now;
        if (same > 20_000) {
          throw new Error(
            `Timer storm: 20,000 timers ran at ${
              now
            }ms without the clock moving on`
          );
        }

        let next = null;
        for (const x of timers.values()) {
          if (
            !next ||
            x.at < next.at ||
            (x.at === next.at && x.seq < next.seq)
          ) {
            next = x;
          }
        }
        if (!next || next.at > until) {
          break;
        }

        timers.delete(next.seq);
        now = next.at;
        try {
          next.fn();
        } catch (error) {
          onerror(error);
        }
      }
      if (until !== Infinity) {
        now = Math.max(now, until);
      }
    },
    timers: {
      clearImmediate: clear,
      clearTimeout: clear,
      now: () => now,
      setImmediate: (fn, ...args) => add(fn, 0, args),
      setTimeout: (fn, ms, ...args) => add(fn, ms, args),
    },
  };
};

export const Pipe = ({ clock, random, delay = 0, split = 0 }) => {
  const { setTimeout } = clock.timers;

  const chop = (data) => {
    if (!split || !random.chance(split) || data.length < 2) {
      return [data];
    }

    const at = random.int(1, data.length - 1);
    return [data.subarray(0, at), data.subarray(at)];
  };

  const end = () => {
    // oxlint-disable-next-line unicorn/prefer-event-target -- it stands in for a net.Socket, which is an EventEmitter
    const x = new EventEmitter();
    let last = 0;
    let paused = false;
    let held = [];

    const receive = (data) => {
      if (x.destroyed) {
        return;
      }
      if (paused) {
        held.push(data);
      } else {
        x.emit("data", data);
      }
    };

    const later = (fn) => {
      last = Math.max(last, clock.now + (delay ? random.int(0, delay) : 0));
      setTimeout(fn, last - clock.now);
    };

    const send = (data) => {
      later(() => x.peer.receive(data));
    };

    Object.assign(x, {
      closed(reset) {
        if (x.destroyed) {
          return;
        }

        if (reset) {
          x.destroyed = true;
          x.writable = false;
          x.readable = false;
          const error = Object.assign(new Error("read ECONNRESET"), {
            code: "ECONNRESET",
          });
          x.emit("error", error);
          x.emit("close", true);
        } else {
          x.readable = false;
          x.emit("end");
          if (x.writable) {
            x.end();
          }
          x.destroyed = true;
          x.emit("close", false);
        }
      },
      destroy(error) {
        if (x.destroyed) {
          return x;
        }

        x.destroyed = true;
        x.writable = false;
        x.readable = false;
        setTimeout(() => {
          if (error) {
            x.emit("error", error);
          }
          x.emit("close", !!error);
        }, 0);
        later(() => x.peer.closed(true));
        return x;
      },
      destroyed: false,
      end(data) {
        if (x.destroyed || !x.writable) {
          return x;
        }

        if (data && data.length) {
          x.write(data);
        }
        x.writable = false;
        later(() => x.peer.closed(false));
        return x;
      },
      pause() {
        paused = true;
        return x;
      },
      readable: true,
      receive,
      ref: () => x,
      resume() {
        paused = false;
        const xs = held;
        held = [];
        for (const data of xs) {
          receive(data);
        }
        return x;
      },
      setKeepAlive: () => x,
      setNoDelay: () => x,
      unref: () => x,
      writable: true,
      // oxlint-disable-next-line promise/prefer-await-to-callbacks -- net.Socket's write(data, encoding, callback) signature
      write(chunk, encoding, callback) {
        const cb = typeof encoding === "function" ? encoding : callback;
        if (x.destroyed || !x.writable) {
          return false;
        }

        for (const part of chop(Buffer.from(chunk))) {
          send(part);
        }
        if (cb) {
          setTimeout(cb, 0);
        }
        return true;
      },
    });
    // Object.assign copies a getter's value, not the getter: this one is read once, here, after the
    // state above is in place, as it always was.
    Object.assign(x, {
      get readyState() {
        if (x.destroyed) {
          return "closed";
        }
        if (x.readable && x.writable) {
          return "open";
        }
        return x.readable ? "readOnly" : "writeOnly";
      },
    });

    return x;
  };

  const client = end();
  const server = end();

  client.peer = server;
  server.peer = client;
  return { client, server };
};

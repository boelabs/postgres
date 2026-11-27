import { Connection, slow, notable } from "./connection.js";
import { channels, listened } from "./diagnostics.js";
import { Errors, PostgresError, queryError } from "./errors.js";
import { Query } from "./query.js";
import { open as startup } from "./startup.js";

const begins = /\bbegin\b/iu;
const noop = () => {
  // Nothing to do: a cancel is best effort, a lease's closed promise may have no one waiting on it,
  // and a connection opened only to load types has no pool to tell about itself.
};
const starts = /\bstart\b/giu;
const transaction = /^transaction\b/iu;

export const Pool = (options, types) => {
  const { setTimeout, clearTimeout, now } = options.timers;
  const statements = Statements(options.scheduler);
  const connections = new Set();
  const waiting = Queue();
  const work = { at: 0, fast: 0, slow: 0 };

  const signal = { aborted: false, sockets: new Set() };
  const replacing = [];
  const eager = types.named || !!options.eager_types;
  const paused = new Set();

  let opening = 0;
  let ending = null;
  let used = false;
  let endTimer = null;
  let retries = 0;
  let failingSince = null;
  let nextAttempt = 0;
  let retryTimer = null;
  let typesLoaded = options.fetch_types === false;
  let typesError = null;
  let typesFailed = 0;
  let failure = null;
  let typesLoading = false;
  let retryTypes = null;
  let typeRetries = 0;
  let typesFailing = null;

  const timed = (q) =>
    options.query_timeout &&
    !q.timer &&
    !q.settled &&
    !q.cursorFn &&
    !q.streaming;

  const query = (q, lease) => {
    if (timed(q)) {
      deadline(q);
    }

    if (ending && !lease) {
      return q.reject(
        queryError(
          Errors.connection(
            "CONNECTION_ENDED",
            options,
            options.host[0],
            options.port[0]
          ),
          q,
          options.debug
        )
      );
    }

    if (q.parts) {
      return batch(q, lease);
    }

    let built;
    try {
      built = q.build();
    } catch (error) {
      return unbuilt(q, error, lease);
    }

    const free = !lease && options.max !== 1;

    if (q.options.simple && !built.values.length) {
      return simple(q, built, free, lease);
    }

    if (q.onlyDescribe) {
      return describeOnly(q, built, lease);
    }

    const statement = statements.get(
      built,
      options.prepare && q.options.prepare !== false
    );
    q.alone =
      free && alone(statement.live ? statement : statements.known(built.text));
    q.wire = { built, statement };
    if (options.scheduler) {
      q.cost = statement.cost;
    }
    place(
      {
        exclusive: !!q.cursorFn || !!q.streaming || q.alone,
        q,
        statement,
        typed: !typesLoaded && unknown(built.oids),
      },
      lease
    );
  };

  const simple = (q, built, free, lease) => {
    const known = (free || options.scheduler) && statements.known(built.text);
    q.alone = free && alone(known);
    if (options.scheduler) {
      q.cost = known;
    }
    return place(
      { exclusive: !!q.streaming || q.alone, q, simple: built.text },
      lease
    );
  };

  const unknown = (oids) => {
    for (const oid of oids) {
      if (oid && !types.known(oid)) {
        return true;
      }
    }
    return false;
  };

  const deadline = (q) => {
    q.timer = setTimeout(() => {
      q.timer = null;
      if (!q.settled) {
        q.timedOut = true;
        cancel(q).catch(noop);
      }
    }, options.query_timeout * 1000);
  };

  const batch = (q, lease) => {
    const { parts } = q;
    if (!parts.length) {
      return q.resolve([]);
    }

    for (let i = 0; i < parts.length; i += 1) {
      try {
        parts[i].build();
      } catch (error) {
        if (error && typeof error === "object") {
          error.index = i;
        }
        return unbuilt(q, error, lease);
      }
    }

    for (const x of parts) {
      const { built } = x;
      x.wire = {
        built,
        statement: statements.get(
          built,
          options.prepare && x.options.prepare !== false
        ),
      };
    }

    const write = (c) => {
      q.connection = c;
      c.batch(q, parts);
      if (q.onwrite) {
        q.onwrite();
      }
    };
    place(
      {
        q,
        run: write,
        typed: !typesLoaded && parts.some((x) => unknown(x.built.oids)),
      },
      lease
    );
  };

  const describeOnly = (q, built, lease) => {
    const statement = {
      columns: null,
      name: "",
      oids: built.oids,
      text: built.text,
    };
    const describe = (c) => {
      q.connection = c;
      c.describe(statement, built.oids, q).then(
        ({ params, columns }) =>
          q.resolve({ columns, name: "", string: built.text, types: params }),
        (describeError) => q.reject(queryError(describeError, q, options.debug))
      );
      if (q.onwrite) {
        q.onwrite();
      }
    };

    if (lease) {
      describe(lease.connection);
    } else {
      place({
        q,
        reject: (error) => q.reject(queryError(error, q, options.debug)),
        run: describe,
      });
    }
  };

  const unbuilt = (q, error, lease) => {
    const rejection = queryError(error, q, options.debug);
    if (!lease || lease.released || lease.connection.closed) {
      return q.reject(rejection);
    }

    q.connection = lease.connection;
    lease.connection.local(q, rejection);
    if (q.onwrite) {
      q.onwrite();
    }
  };

  const place = (job, lease) => {
    used = true;
    const missing = !lease && retype();

    if (missing) {
      return reject(job, missing);
    }

    if (job.q && job.q.cancelled) {
      return job.q.reject(
        queryError(
          Errors.generic("57014", "canceling statement due to user request"),
          job.q,
          options.debug
        )
      );
    }

    if (lease) {
      if (lease.connection.closed) {
        return job.q.reject(
          queryError(lease.connection.closed, job.q, options.debug)
        );
      }
      if (lease.released) {
        return job.q.reject(queryError(ended(lease), job.q, options.debug));
      }
      return run(lease.connection, job);
    }

    if (signal.aborted) {
      return reject(
        job,
        Errors.connection(
          "CONNECTION_DESTROYED",
          options,
          options.host[0],
          options.port[0]
        )
      );
    }

    if (failingFast()) {
      return reject(job, copy(failure.error));
    }

    const c = waiting.length === 0 && pick(job);
    if (c) {
      return run(c, job);
    }

    waiting.push(wait(job));
    drain();
  };

  const wait = (job) => {
    if (!options.queue_timeout) {
      return job;
    }

    job.timer = setTimeout(() => {
      job.timer = null;
      if (waiting.remove((x) => x === job)) {
        reject(
          job,
          Errors.generic(
            "QUEUE_TIMEOUT",
            `Waited more than ${options.queue_timeout} seconds for a connection`
          )
        );
      }
    }, options.queue_timeout * 1000);
    if (typeof job.timer.unref === "function") {
      job.timer.unref();
    }
    return job;
  };

  const started = (job) => {
    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = null;
    }
  };

  const run = (c, job) => {
    started(job);
    hold(c);

    if (job.run) {
      return job.run(c);
    }

    job.q.connection = c;
    if (job.simple === undefined) {
      c.send(job.q);
    } else {
      c.simple(job.q, job.simple);
    }
    if (job.q.onwrite) {
      job.q.onwrite();
    }
  };

  const drain = () => {
    while (waiting.length) {
      const job = waiting.peek();
      const c = pick(job);

      if (!c && !copying(job)) {
        break;
      }

      waiting.shift();
      if (!c) {
        reject(
          job,
          Errors.generic(
            "COPY_IN_PROGRESS",
            "You cannot execute queries during copy"
          )
        );
      } else if (job.lease) {
        grant(c, job);
      } else {
        run(c, job);
      }
    }
    if (waiting.length && listened(channels.pool)) {
      event("wait", null, { waiting: waiting.length });
    }
    grow();
  };

  const copying = (job) => {
    if (
      !job.q ||
      connections.size + opening < options.max ||
      connections.size === 0
    ) {
      return false;
    }

    for (const c of connections) {
      if (!c.copying) {
        return false;
      }
    }
    return true;
  };

  const blocked = (job) =>
    !typesLoaded && (eager ? job.lease || job.typed : job.typed);

  const pipelined = (c, best, job) =>
    !job.lease &&
    !job.exclusive &&
    c.inflight < options.max_pipeline &&
    (!best || c.inflight < best.inflight);

  const room = () => connections.size + opening < options.max && !failingSince;

  const rescheduled = (best, job) =>
    best && options.scheduler && job.q && needed(job)
      ? scheduled(job) || best
      : best;

  const crowded = (best) =>
    best &&
    opening &&
    best.inflight >= Math.ceil(waiting.length / (opening + 1));

  const pick = (job) => {
    const { statement } = job;
    const any = !statement || !statement.name;

    if (blocked(job)) {
      if (!eager) {
        need();
      }
      return null;
    }

    let best = null;
    let soon = false;

    for (const c of connections) {
      if (c.loading && !c.closed) {
        soon = true;
      }
      const free = usable(c);
      if (free && quiet(c)) {
        if (any || c.prepared.has(statement.name)) {
          return c;
        }
        best = best && quiet(best) ? best : c;
      } else if (free && pipelined(c, best, job)) {
        best = c;
      }
    }

    if (best && quiet(best)) {
      return best;
    }

    if (soon || room()) {
      return null;
    }

    best = rescheduled(best, job);
    return crowded(best) ? null : best;
  };

  const needed = (job) => {
    if (
      !job.q.cost ||
      job.q.cost.est === undefined ||
      job.q.cost.est >= notable
    ) {
      return true;
    }

    for (const c of connections) {
      if (c.notable) {
        return true;
      }
    }

    return false;
  };

  const scheduled = (job) => {
    const t = now();
    const e = job.q.cost ? job.q.cost.est : undefined;

    if (e === undefined || e < slow) {
      return soonest(t, Infinity, false);
    }

    let heavy = 0;
    for (const c of connections) {
      if (c.inflight && c.heavy()) {
        heavy += 1;
      }
    }

    decay(t);
    const reserve = Math.max(
      1,
      Math.min(
        Math.ceil((work.fast / 2000) * 1.5) + 1,
        connections.size - Math.ceil(work.slow / 2000)
      )
    );
    return heavy < connections.size - reserve
      ? soonest(t, Infinity, false)
      : soonest(t, 2 * e, true) || soonest(t, Infinity, false);
  };

  const soonest = (t, most, heavy) => {
    let best = null;
    let value = Infinity;
    let ties = 0;

    for (const c of connections) {
      const v =
        usable(c) && c.inflight < options.max_pipeline && (!heavy || c.heavy())
          ? c.backlog(t)
          : Infinity;
      if (v <= most && v < value) {
        best = c;
        value = v;
        ties = 1;
      } else if (v <= most && v === value && v !== Infinity) {
        ties += 1;
        if (Math.random() * ties < 1) {
          best = c;
        }
      }
    }

    return best;
  };

  const ontimed = (sample, t) => {
    decay(t);
    if (sample < slow) {
      work.fast += sample;
    } else {
      work.slow += sample;
    }
  };

  const decay = (t) => {
    const d = Math.exp((work.at - t) / 2000);
    work.fast *= d;
    work.slow *= d;
    work.at = t;
  };

  const grow = () => {
    if (ending && waiting.length === 0) {
      return;
    }

    if (failingSince !== null) {
      if (
        opening ||
        !waiting.length ||
        retryTimer ||
        [...connections].some((x) => x.loading)
      ) {
        return;
      }
      const delay = nextAttempt - now();
      if (delay > 0) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          grow();
        }, delay);
      } else {
        connect();
      }
      return;
    }

    let loading = 0;
    for (const c of connections) {
      if (c.loading) {
        loading += 1;
      }
    }

    const wanted = Math.max(
      Math.min(
        waiting.length - opening - loading,
        options.max - connections.size - opening
      ),
      used && !ending
        ? Math.min(options.min, options.max) - connections.size - opening
        : 0
    );

    for (let i = 0; i < wanted; i += 1) {
      connect();
    }
  };

  const connect = () => {
    opening += 1;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    (options.open || startup)(
      options,
      signal,
      replacing.length ? replacing.shift() : 0
    ).then(opened, failed);
  };

  const failingFast = () =>
    !!failure && retries > 1 && opening === 0 && now() < nextAttempt && stuck();

  const stuck = () => {
    for (const c of connections) {
      if (!c.lease) {
        return false;
      }
    }
    return true;
  };

  const opened = (ready) => {
    opening -= 1;

    if (signal.aborted || (ending && waiting.length === 0)) {
      ready.socket.destroy();
      return finishing();
    }

    for (const [k, v] of Object.entries(ready.parameters)) {
      onparameter(k, v);
    }
    const c = Connection(ready, options, events);
    c.index = ready.index || 0;
    connections.add(c);
    lifetime(c);
    if (listened(channels.pool)) {
      event("open", c);
    }
    if (!typesLoaded && eager) {
      if (typesLoading) {
        c.loading = true;
      } else {
        loadTypes(c);
      }
    }
    if (!c.loading && !c.typing && !(eager && typesLoading)) {
      recovered();
    }
    drain();
  };

  const recovered = () => {
    retries = 0;
    failingSince = null;
    failure = null;
  };

  const need = (c) => {
    if (c) {
      paused.add(c);
    }
    if (typesLoaded) {
      return resume();
    }

    if (typesLoading) {
      return;
    }

    typesLoading = true;
    const spare = [...connections].find(
      (x) => !paused.has(x) && usable(x) && x.inflight === 0
    );
    if (spare) {
      fetched(types.load(runner(spare)));
      return;
    }

    (options.open || startup)(options, signal, 0).then(
      (ready) => {
        const loader = Connection(ready, options, {
          ...events,
          need: noop,
          onclose: noop,
          onparameter: noop,
          onready: noop,
          ontimed: noop,
        });
        return fetched(
          types.load(runner(loader)).finally(() => loader.close())
        );
      },
      (openError) => fetched(Promise.reject(openError))
    );
  };

  const fetched = (loading) => {
    let loadError = null;
    loading
      .then(
        () => (typesLoaded = true),
        (fetchError) =>
          fetchError instanceof PostgresError
            ? (typesLoaded = true)
            : (loadError = fetchError)
      )
      .then(() => afterFetch(loadError));
  };

  const afterFetch = (loadError) => {
    typesLoading = false;
    events.typed = typesLoaded;
    if (typesLoaded) {
      typeRetries = 0;
      typesFailing = null;
      return resume();
    }

    if (typesFailing === null) {
      typesFailing = now();
    }
    typeRetries += 1;
    if (
      options.connect_timeout &&
      now() - typesFailing >= options.connect_timeout * 1000
    ) {
      typeRetries = 0;
      typesFailing = null;
      const xs = [...paused];
      for (const x of xs) {
        paused.delete(x);
        x.destroy(
          loadError ||
            Errors.connection("CONNECTION_CLOSED", options, x.host, x.port)
        );
      }
      return;
    }

    const delay =
      1000 *
      (typeof options.backoff === "function"
        ? options.backoff(typeRetries)
        : options.backoff);
    if (paused.size) {
      retryTypes = setTimeout(() => {
        retryTypes = null;
        need();
      }, delay);
    }
  };

  const resume = () => {
    const xs = [...paused];
    paused.clear();
    for (const x of xs) {
      if (!x.closed) {
        x.go();
      }
    }
    drain();
  };

  const runner = (c) => (text) => {
    const { promise, resolve, reject: refuse } = Promise.withResolvers();
    // What this throws rejects the promise, as from a promise executor.
    try {
      const q = new Query(
        [text],
        [],
        Object.assign(
          () => {
            // Never called: the query is sent below, straight on c.
          },
          { options }
        ),
        { simple: true }
      );
      q.executed = true;
      q.then(resolve, refuse);
      bound(c, q);
      c.simple(q, text);
    } catch (error) {
      refuse(error);
    }
    return promise;
  };

  const bound = (c, q) => {
    if (!options.query_timeout) {
      return;
    }

    const timer = setTimeout(() => {
      if (!q.settled) {
        c.cancel(q).catch(noop);
      }
    }, options.query_timeout * 1000);
    const clear = () => clearTimeout(timer);
    q.then(clear, clear);
  };

  const retype = () => {
    if (!typesError) {
      return null;
    }

    if (now() - typesFailed < 1000) {
      return copy(typesError);
    }

    typesError = null;
    for (const x of connections) {
      x.loading = true;
    }
    for (const x of connections) {
      if (!x.closed) {
        loadTypes(x);
        break;
      }
    }
    return null;
  };

  const loadTypes = (c) => {
    hold(c);
    typesLoading = true;
    c.loading = types.named;
    c.typing = null;
    types
      .load((text) => {
        const { promise, resolve, reject: refuse } = Promise.withResolvers();
        // What this throws rejects the promise, as from a promise executor.
        try {
          const q = new Query(
            [text],
            [],
            Object.assign(
              () => {
                // Never called: the query is sent below, straight on c.
              },
              { options }
            ),
            { simple: true }
          );
          q.executed = true;
          q.then(resolve, refuse);
          if (!types.named) {
            c.typing = q;
          }
          bound(c, q);
          c.simple(q, text);
        } catch (error) {
          refuse(error);
        }
        return promise;
      })
      .then(
        () => (typesLoaded = true),
        (loadError) => {
          if (loadError instanceof PostgresError) {
            typesLoaded = true;
          } else if (loadError && loadError.code === "TYPE_NOT_FOUND") {
            typesError = loadError;
            typesFailed = now();
          }
        }
      )
      .then(() => afterLoad(c));
  };

  const afterLoad = (c) => {
    typesLoading = false;
    events.typed = typesLoaded;
    c.typing = null;
    for (const x of connections) {
      x.loading = !typesLoaded && !typesError;
    }
    if (typesLoaded || typesError) {
      recovered();
    }
    if (typesError) {
      for (const job of waiting.take()) {
        reject(job, copy(typesError));
      }
    } else if (!typesLoaded) {
      for (const x of connections) {
        if (!x.closed && !x.typing) {
          loadTypes(x);
          break;
        }
      }
    }
    drain();
  };

  const failed = (error) => {
    opening -= 1;
    if (signal.aborted) {
      return finishing();
    }

    attempted(error);
    if (ending) {
      finishing();
    } else {
      grow();
    }
  };

  const attempted = (error) => {
    if (failingSince === null) {
      failingSince = now();
    }
    retries += 1;
    nextAttempt =
      now() +
      1000 *
        (typeof options.backoff === "function"
          ? options.backoff(retries)
          : options.backoff);

    const transient =
      !!error && (error.code === "CONNECTION_CLOSED" || error.code === "53300");
    const expired =
      options.connect_timeout &&
      now() - failingSince >= options.connect_timeout * 1000;

    failure = !transient || expired ? { error } : null;
    if (stuck() && opening === 0 && (failure || ending)) {
      for (const [i, job] of waiting.take().entries()) {
        reject(job, i ? copy(error) : error);
      }
    }
  };

  const reject = (job, error) => {
    started(job);
    if (job.lease) {
      job.reject(error);
    } else if (job.q) {
      job.q.reject(queryError(error, job.q, options.debug));
    } else {
      job.reject(error);
    }
  };

  const lifetime = (c) => {
    const life =
      typeof options.max_lifetime === "function"
        ? options.max_lifetime()
        : options.max_lifetime;
    if (life) {
      c.lifeTimer = unref(
        setTimeout(() => {
          c.retiring = true;
          if (c.inflight === 0 && !c.lease) {
            c.close();
          }
        }, life * 1000)
      );
    }
    idle(c);
  };

  const event = (name, c, extra) => {
    channels.pool.publish({
      connection: c ? c.id : null,
      database: options.database,
      event: name,
      host: c ? c.host : null,
      port: c ? c.port : null,
      stats: pool.stats,
      ...extra,
    });
  };

  const idle = (c) => {
    if (listened(channels.pool)) {
      event("idle", c);
    }
    if (c.inflight || c.lease) {
      return;
    }

    if (options.unref_sockets && !c.loading && waiting.length === 0) {
      c.unref();
    }
    if (!options.idle_timeout) {
      return;
    }

    c.idleSince = now();
    c.idleTimer ||= unref(
      setTimeout(() => idled(c), options.idle_timeout * 1000)
    );
  };

  const hold = (c) => {
    if (options.unref_sockets) {
      c.ref();
    }
  };

  const unref = (timer) => {
    if (options.unref_sockets && timer && typeof timer.unref === "function") {
      timer.unref();
    }
    return timer;
  };

  const idled = (c) => {
    c.idleTimer = null;
    if (c.inflight || c.lease || c.closed) {
      return;
    }

    if (connections.size <= options.min) {
      return;
    }

    const left = options.idle_timeout * 1000 - (now() - c.idleSince);
    if (left >= 1) {
      c.idleTimer = unref(setTimeout(() => idled(c), left));
    } else {
      c.close();
    }
  };

  const onready = (c) => {
    if (c.releasing) {
      if (c.inflight) {
        return;
      }

      c.releasing = false;
      if (c.status !== "I") {
        return c.close();
      }
    }
    if (
      c.inflight === 0 &&
      !c.lease &&
      (c.retiring || (ending && waiting.length === 0))
    ) {
      return c.close();
    }

    idle(c);
    while (
      waiting.length > connections.size + opening &&
      usable(c) &&
      c.inflight < options.max_pipeline &&
      plain(waiting.peek())
    ) {
      run(c, waiting.shift());
    }

    if (waiting.length && !c.lease && c.inflight < options.max_pipeline) {
      drain();
    }
    if (ending && waiting.length === 0) {
      finishing();
    }
  };

  // What a lease is told when its connection closes.
  const closedBy = (c, error) => {
    if (error.cause && error.cause.severity === "FATAL" && !c.uncertain) {
      return error.cause;
    }
    if (error.code === "CONNECTION_DESTROYED") {
      return Errors.connection("CONNECTION_CLOSED", options, c.host, c.port);
    }
    return error;
  };

  const onclose = (c, error) => {
    connections.delete(c);
    if ((c.loading || c.typing) && !signal.aborted) {
      attempted(copy(error));
    }
    paused.delete(c);
    if (!ending) {
      replacing.push((c.index + 1) % (options.path ? 1 : options.host.length));
    }
    if (replacing.length > options.max) {
      replacing.shift();
    }
    if (c.retired) {
      for (const r of c.retired) {
        r();
      }
    }
    if (c.idleTimer) {
      clearTimeout(c.idleTimer);
    }
    if (c.lifeTimer) {
      clearTimeout(c.lifeTimer);
    }
    if (c.lease && c.lease.onclose) {
      c.lease.onclose(closedBy(c, error));
    }
    if (options.onclose) {
      options.onclose(c.id);
    }
    if (listened(channels.pool)) {
      event("close", c, { error });
    }
    if (connections.size === 0 && opening === 0) {
      statements.clear();
    }
    drain();
    if (ending) {
      finishing();
    }
  };

  const onparameter = (k, v) => {
    if (options.parameters[k] !== v) {
      options.parameters[k] = v;
      if (options.onparameter) {
        options.onparameter(k, v);
      }
    }
  };

  const acquire = async (kind) => {
    used = true;
    // One tick before anything else, so that leases and queries start in the order they were made:
    // a query made before sql.begin runs first, also with max: 1.
    await Promise.resolve();
    if (ending) {
      throw Errors.connection(
        "CONNECTION_ENDED",
        options,
        options.host[0],
        options.port[0]
      );
    }

    if (failingFast()) {
      throw copy(failure.error);
    }

    const missing = retype();
    if (missing) {
      throw missing;
    }

    const { promise, resolve, reject: refuse } = Promise.withResolvers();
    // What this throws rejects the lease, unless it was granted already, as from a promise executor.
    try {
      waiting.push(
        wait({
          kind,
          lease: true,
          queued: listened(channels.pool) ? now() : 0,
          reject: refuse,
          resolve,
        })
      );
      drain();
    } catch (error) {
      refuse(error);
    }
    return promise;
  };

  const grant = (c, job) => {
    started(job);
    hold(c);
    if (c.idleTimer) {
      clearTimeout(c.idleTimer);
      c.idleTimer = null;
    }
    let chain = Promise.resolve();
    let released = false;

    const { promise: closed, reject: lost } = Promise.withResolvers();
    closed.catch(noop);

    const x = {
      closed,
      connection: c,
      error: null,
      kind: job.kind,
      onclose(error) {
        x.error = error;
        lost(error);
      },
      release() {
        if (released) {
          return;
        }
        released = true;
        if (c.lease === x) {
          c.lease = null;
        }
        if (listened(channels.pool)) {
          event("release", c, { kind: job.kind });
        }
        if (c.closed) {
          return;
        }

        if (c.inflight) {
          c.releasing = true;
          return true;
        }

        if (c.status === "I") {
          onready(c);
        } else {
          c.close();
        }
      },
      get released() {
        return released;
      },
      send(q) {
        if (c.closed) {
          return q.reject(queryError(c.closed, q, options.debug));
        }

        if (released) {
          return q.reject(queryError(ended(x), q, options.debug));
        }

        chain = chain.then(() => {
          const { promise, resolve, reject: refuse } = Promise.withResolvers();
          // What this throws rejects the step, as from a promise executor.
          try {
            q.onwrite = resolve;
            q.then(resolve, resolve);
            query(q, x);
          } catch (error) {
            refuse(error);
          }
          return promise;
        });
      },
    };

    c.lease = x;
    if (listened(channels.pool)) {
      event("lease", c, {
        kind: job.kind,
        waited: job.queued ? now() - job.queued : 0,
      });
    }
    job.resolve(x);
  };

  const cancel = (q) => {
    if (
      waiting.remove((x) => {
        if (x.q !== q) {
          return false;
        }
        started(x);
        return true;
      })
    ) {
      q.reject(
        queryError(
          Errors.generic("57014", "canceling statement due to user request"),
          q,
          options.debug
        )
      );
      return Promise.resolve();
    }

    if (q.connection) {
      return q.connection.cancel(q);
    }

    q.cancelled = true;
    return Promise.resolve();
  };

  const end = ({ timeout = null } = {}) => {
    if (ending) {
      return ending;
    }

    const { promise, resolve, reject: refuse } = Promise.withResolvers();
    // What this throws rejects the promise, as from a promise executor.
    try {
      pool.ended = resolve;
      if (timeout !== null) {
        endTimer = setTimeout(destroy, timeout * 1000);
      }
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      Promise.resolve().then(finishing);
    } catch (error) {
      refuse(error);
    }
    ending = promise;

    return ending;
  };

  const finishing = () => {
    if (!pool.ended) {
      return;
    }

    if (waiting.length === 0) {
      for (const c of connections) {
        if (c.inflight === 0 && !c.lease) {
          c.close();
        }
      }
    }

    if (connections.size === 0 && opening === 0 && waiting.length) {
      const error = Errors.connection(
        "CONNECTION_ENDED",
        options,
        options.host[0],
        options.port[0]
      );
      for (const job of waiting.take()) {
        reject(job, error);
      }
    }

    if (
      connections.size === 0 &&
      (opening === 0 || signal.aborted) &&
      waiting.length === 0
    ) {
      if (endTimer) {
        clearTimeout(endTimer);
      }
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      if (retryTypes) {
        clearTimeout(retryTypes);
      }
      const resolve = pool.ended;
      pool.ended = null;
      resolve();
    }
  };

  const destroy = () => {
    endTimer = null;
    signal.aborted = true;
    for (const x of signal.sockets) {
      x.destroy();
    }
    const error = Errors.connection(
      "CONNECTION_DESTROYED",
      options,
      options.host[0],
      options.port[0]
    );
    for (const job of waiting.take()) {
      reject(job, error);
    }
    for (const c of connections) {
      c.destroy();
    }
    if (connections.size === 0) {
      finishing();
    }
  };

  const close = () => {
    used = false;
    return Promise.all(
      [...connections].map((c) => {
        if (!c.lease) {
          return c.close();
        }
        const { promise, resolve } = Promise.withResolvers();
        c.retiring = true;
        (c.retired ||= []).push(resolve);
        return promise;
      })
    );
  };

  const events = {
    binary: types.binary,
    decoder: types.decoder,
    need,
    onclose,
    onnotify: options.onnotify,
    onparameter,
    onready,
    ontimed,
    parser: types.parser,
    plain: types.plain,
    serializer: types.serializer,
    typed: options.fetch_types === false,
    unknown: (oids) => !typesLoaded && types.unknown(oids),
  };

  const pool = {
    cancel,
    close,
    end,
    lease: acquire,
    query,
    get stats() {
      return {
        connections: connections.size,
        idle: [...connections].filter((x) => x.inflight === 0 && !x.lease)
          .length,
        leased: [...connections].filter((x) => x.lease).length,
        opening,
        waiting: waiting.length,
      };
    },
  };

  return pool;
};

export const Queue = () => {
  let xs = [];
  let head = 0;

  return {
    get length() {
      return xs.length - head;
    },
    peek: () => xs[head],
    push: (x) => xs.push(x),
    remove(fn) {
      for (let i = head; i < xs.length; i += 1) {
        if (fn(xs[i])) {
          xs.splice(i, 1);
          return true;
        }
      }
      return false;
    },
    shift() {
      const x = xs[head];
      xs[head] = undefined;
      head += 1;
      if (head === xs.length) {
        xs = [];
        head = 0;
      } else if (head > 1024 && head * 2 > xs.length) {
        xs = xs.slice(head);
        head = 0;
      }
      return x;
    },
    take() {
      const all = xs.slice(head);
      xs = [];
      head = 0;
      return all;
    },
  };
};

const limit = 2000;

const plain = (job) => !!job.q && !job.lease && !job.exclusive && !job.run;

const quiet = (c) =>
  c.inflight === 0 || (!!c.typing && !c.typing.settled && c.inflight === 1);

const usable = (c) =>
  !c.closed &&
  !c.closing &&
  !c.lease &&
  !c.releasing &&
  !c.retiring &&
  !c.exclusive &&
  !c.loading;

const copy = (error) => {
  if (!error || typeof error !== "object") {
    return error;
  }

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

const ended = (lease) =>
  Errors.generic("UNSAFE_TRANSACTION", `The ${lease.kind} has ended`);

const alone = (x) => {
  if (x.alone === undefined) {
    x.alone = opens(x.text);
  }
  return x.alone;
};

const opens = (text) => {
  if (begins.test(text)) {
    return true;
  }

  starts.lastIndex = 0;
  let match;
  while ((match = starts.exec(text))) {
    const from = match.index + 5;
    let i = from;
    while (true) {
      while (i < text.length && /\s/u.test(text[i])) {
        i += 1;
      }

      if (text[i] !== "/" || text[i + 1] !== "*") {
        break;
      }

      const end = text.indexOf("*/", i + 2);
      if (end === -1) {
        return false;
      }

      i = end + 2;
    }

    if (i > from && transaction.test(text.slice(i, i + 12))) {
      return true;
    }

    starts.lastIndex = Math.max(starts.lastIndex, i);
  }

  return false;
};

const Statements = (scheduler) => {
  const prefix = Math.random().toString(36).slice(2, 10);
  const map = new Map();
  const templates = new WeakMap();

  let counter = 1;
  let clock = 0;

  const texts = new Map();

  // Each use takes the clock and moves it on, so the oldest is the least recently used.
  const tick = () => {
    const t = clock;
    clock += 1;
    return t;
  };

  const known = (text) => {
    let x = texts.get(text);
    if (x) {
      return x;
    }

    x = { alone: undefined, est: undefined, text };
    texts.set(text, x);
    if (texts.size > limit) {
      texts.delete(texts.keys().next().value);
    }
    return x;
  };

  const unnamed = (text) => ({
    cost: scheduler ? known(text) : null,
    ends: undefined,
    key: null,
    live: false,
    name: "",
    shape: undefined,
    text,
    used: 0,
    version: 0,
  });

  const evict = () => {
    let oldest = null;
    for (const x of map.values()) {
      if (!oldest || x.used < oldest.used) {
        oldest = x;
      }
    }
    oldest.live = false;
    map.delete(oldest.key);
  };

  const add = (key, text) => {
    const name = prefix + counter;
    counter += 1;
    const statement = {
      alone: undefined,
      cost: { est: undefined },
      ends: undefined,
      key,
      live: true,
      name,
      shape: undefined,
      text,
      used: tick(),
      version: 0,
    };
    map.set(key, statement);
    if (map.size > limit) {
      evict();
    }
    return statement;
  };

  const set = (strings) => {
    const x = new Map();
    templates.set(strings, x);
    return x;
  };

  const get = (built, prepare) => {
    if (!prepare) {
      return unnamed(built.text);
    }

    const tagged =
      !built.dynamic && (templates.get(built.strings) || set(built.strings));
    const cached = tagged && tagged.get(built.types);

    if (cached && cached.live) {
      cached.used = tick();
      return cached;
    }

    const key = `${built.types}\0${built.text}`;
    let statement = map.get(key);
    if (statement) {
      statement.used = tick();
    } else {
      statement = add(key, built.text);
    }
    if (tagged) {
      tagged.set(built.types, statement);
    }
    return statement;
  };

  const clear = () => {
    for (const x of map.values()) {
      x.live = false;
    }
    map.clear();
  };

  return { clear, get, known };
};

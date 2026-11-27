import dc from "node:diagnostics_channel";

const tracing = (name) => {
  try {
    return typeof dc.tracingChannel === "function"
      ? dc.tracingChannel(name)
      : null;
  } catch {
    return null;
  }
};

const plain = (name) => {
  try {
    return dc.channel(name);
  } catch {
    return null;
  }
};

export const channels = {
  connect: tracing("postgres:connect"),
  notice: plain("postgres:notice"),
  pool: plain("postgres:pool"),
  query: tracing("postgres:query"),
  transaction: tracing("postgres:transaction"),
};

const done = Symbol("done");

export const now = () => performance.now();

export const userName = (options) =>
  typeof options.user === "function" ? null : options.user;

export const active = (t) =>
  !!t &&
  (t.hasSubscribers === undefined
    ? t.start.hasSubscribers ||
      t.end.hasSubscribers ||
      t.asyncStart.hasSubscribers ||
      t.asyncEnd.hasSubscribers ||
      t.error.hasSubscribers
    : t.hasSubscribers);

export const listened = (channel) => !!channel && channel.hasSubscribers;

export const start = (t, context, fn) => {
  const run = () => {
    try {
      return fn();
    } finally {
      t.end.publish(context);
    }
  };

  return typeof t.start.runStores === "function"
    ? t.start.runStores(context, run)
    : (t.start.publish(context), run());
};

export const finish = (t, context, error, result) => {
  if (context[done]) {
    return;
  }

  context[done] = true;

  if (error) {
    context.error = error;
    t.error.publish(context);
  } else {
    context.result = result;
  }

  t.asyncStart.publish(context);
  t.asyncEnd.publish(context);
};

export class PostgresError extends Error {
  constructor(x) {
    super(typeof x === "string" ? x : x && x.message);
    // oxlint-disable-next-line unicorn/custom-error-definition -- a user's subclass is named after itself
    this.name = this.constructor.name;
    if (x && typeof x === "object") {
      Object.assign(this, x);
    }
  }

  toJSON() {
    return { ...this, message: this.message };
  }
}

const connection = (code, options, host, port) => {
  const address = options.path || host;
  const error = Object.assign(
    new Error(`write ${code} ${options.path || `${host}:${port}`}`),
    // oxlint-disable-next-line sort-keys -- the order the error's own properties are listed in
    { code, errno: code, address },
    options.path ? {} : { port }
  );

  Error.captureStackTrace(error, connection);
  return error;
};

const postgres = (x) => {
  const error = new PostgresError(x);
  Error.captureStackTrace(error, postgres);
  return error;
};

const generic = (code, message) => {
  const error = Object.assign(new Error(`${code}: ${message}`), { code });
  Error.captureStackTrace(error, generic);
  return error;
};

const notSupported = (x) => {
  const error = Object.assign(new Error(`${x} (B) is not supported`), {
    code: "MESSAGE_NOT_SUPPORTED",
    name: x,
  });
  Error.captureStackTrace(error, notSupported);
  return error;
};

export const Errors = {
  connection,
  generic,
  notSupported,
  postgres,
};

// How this folder appears in stack traces: as a url, and as a path, which Bun on Windows writes with
// a drive letter and backslashes (C:\app\node_modules\@boelabs\postgres\src\).
const locations = () => {
  try {
    const url = new URL(".", import.meta.url);
    if (url.protocol !== "file:") {
      return [url.href];
    }

    const path = decodeURIComponent(url.pathname);
    return /^\/[A-Za-z]:\//u.test(path)
      ? [url.href, path, path.slice(1), path.slice(1).replaceAll("/", "\\")]
      : [url.href, path];
  } catch {
    return [];
  }
};

const places = locations();

// A line of a stack trace is ours when it names a file directly in src, not in a folder below it.
export const ours = (line) =>
  places.some((here) => {
    const i = line.indexOf(here);
    return (
      i !== -1 && !/[/\\]/u.test(line.slice(i + here.length).split(":")[0])
    );
  });

// The first line of an error's stack, or what it would have been. Errors raised by a runtime need
// not have a stack: under Bun a failed DNS lookup is a DNSException whose stack is undefined.
const headline = (error) => {
  if (typeof error.stack === "string" && error.stack) {
    return error.stack.split("\n")[0];
  }

  try {
    return String(error);
  } catch {
    return "Error";
  }
};

// Gives an error the stack of the code that made its query. Never throws: whatever the runtime
// handed over, the query must still reject with it.
export const withOrigin = (error, origin) => {
  if (!origin || !error || typeof error !== "object") {
    return error;
  }

  try {
    Object.defineProperty(error, "stack", {
      configurable: true,
      enumerable: false,
      value: [
        headline(error),
        ...String(origin)
          .split("\n")
          .slice(1)
          .filter((x) => !ours(x)),
      ].join("\n"),
      writable: true,
    });
  } catch {
    // A frozen error, or one whose stack can't be redefined, keeps the stack it has.
  }
  return error;
};

// Adds the query to an error it rejects with. Never throws, for the same reason as withOrigin.
export const queryError = (thrown, q, debug) => {
  const error =
    !thrown || typeof thrown !== "object" ? new Error(thrown) : thrown;

  if (!q || "query" in error) {
    return error;
  }

  try {
    const { built } = q;
    // oxlint-disable-next-line sort-keys -- the order the error lists these in when debug makes them enumerable
    Object.defineProperties(error, {
      query: {
        configurable: true,
        enumerable: !!debug,
        value: built ? built.text : q.strings[0],
        writable: true,
      },
      parameters: {
        configurable: true,
        enumerable: !!debug,
        value: built ? built.values : [],
        writable: true,
      },
      args: {
        configurable: true,
        enumerable: !!debug,
        value: q.args,
        writable: true,
      },
      types: {
        configurable: true,
        enumerable: !!debug,
        value: built ? built.oids : [],
        writable: true,
      },
    });
  } catch {
    // A non-extensible error is passed on as it is.
  }
  return withOrigin(error, q.origin);
};

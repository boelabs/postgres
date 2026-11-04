export class PostgresError extends Error {
  constructor(x) {
    super(typeof x === 'string' ? x : x && x.message)
    this.name = this.constructor.name
    x && typeof x === 'object' && Object.assign(this, x)
  }

  toJSON() {
    return { ...this, message: this.message }
  }
}

export const Errors = {
  connection,
  postgres,
  generic,
  notSupported
}

function connection(code, options, host, port) {
  const address = options.path || host
      , error = Object.assign(
        new Error('write ' + code + ' ' + (options.path || host + ':' + port)),
        { code, errno: code, address },
        options.path ? {} : { port }
      )

  Error.captureStackTrace(error, connection)
  return error
}

function postgres(x) {
  const error = new PostgresError(x)
  Error.captureStackTrace(error, postgres)
  return error
}

function generic(code, message) {
  const error = Object.assign(new Error(code + ': ' + message), { code })
  Error.captureStackTrace(error, generic)
  return error
}

function notSupported(x) {
  const error = Object.assign(new Error(x + ' (B) is not supported'), { code: 'MESSAGE_NOT_SUPPORTED', name: x })
  Error.captureStackTrace(error, notSupported)
  return error
}

const places = locations()

// A line of a stack trace is ours when it names a file directly in src, not in a folder below it.
export const ours = line => places.some(here => {
  const i = line.indexOf(here)
  return i !== -1 && !/[/\\]/.test(line.slice(i + here.length).split(':')[0])
})

// How this folder appears in stack traces: as a url, and as a path, which Bun on Windows writes with
// a drive letter and backslashes (C:\app\node_modules\@boelabs\postgres\src\).
function locations() {
  try {
    const url = new URL('.', import.meta.url)
    if (url.protocol !== 'file:')
      return [url.href]

    const path = decodeURIComponent(url.pathname)
    return /^\/[A-Za-z]:\//.test(path)
      ? [url.href, path, path.slice(1), path.slice(1).replace(/\//g, '\\')]
      : [url.href, path]
  } catch (error) {
    return []
  }
}

// The first line of an error's stack, or what it would have been. Errors raised by a runtime need
// not have a stack: under Bun a failed DNS lookup is a DNSException whose stack is undefined.
function headline(error) {
  if (typeof error.stack === 'string' && error.stack)
    return error.stack.split('\n')[0]

  try {
    return String(error)
  } catch (_) {
    return 'Error'
  }
}

// Gives an error the stack of the code that made its query. Never throws: whatever the runtime
// handed over, the query must still reject with it.
export function withOrigin(error, origin) {
  if (!origin || !error || typeof error !== 'object')
    return error

  try {
    Object.defineProperty(error, 'stack', {
      value: [headline(error), ...String(origin).split('\n').slice(1).filter(x => !ours(x))].join('\n'),
      writable: true,
      configurable: true,
      enumerable: false
    })
  } catch (_) {
    // A frozen error, or one whose stack can't be redefined, keeps the stack it has.
  }
  return error
}

// Adds the query to an error it rejects with. Never throws, for the same reason as withOrigin.
export function queryError(error, q, debug) {
  if (!error || typeof error !== 'object')
    error = new Error(error)

  if (!q || 'query' in error)
    return error

  try {
    const built = q.built
    Object.defineProperties(error, {
      query: { value: built ? built.text : q.strings[0], enumerable: !!debug, configurable: true, writable: true },
      parameters: { value: built ? built.values : [], enumerable: !!debug, configurable: true, writable: true },
      args: { value: q.args, enumerable: !!debug, configurable: true, writable: true },
      types: { value: built ? built.oids : [], enumerable: !!debug, configurable: true, writable: true }
    })
  } catch (_) {
    // A non-extensible error is passed on as it is.
  }
  return withOrigin(error, q.origin)
}

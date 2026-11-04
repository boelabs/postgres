import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

// Ultracite's core rules, pinned exactly in package.json: a minor bump changes which rules are on,
// so it is a pull request of its own. What follows is the whole list of departures from the preset,
// each for a reason of this codebase, not a rule we have not got to. A rule that only needs care at
// one place is disabled there, with the reason beside it.
export default defineConfig({
  env: core.env,
  extends: [core],
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    "tests/cf/.wrangler/**",
    ".agents/**",
  ],
  overrides: [
    {
      // The wire format, SCRAM's XOR of keys, 64-bit LSNs read as two halves, large object mode
      // flags and the simulator's random numbers are bit operations by definition.
      files: [
        "src/connection.js",
        "src/large.js",
        "src/protocol.js",
        "src/startup.js",
        "src/subscribe.js",
        "src/types.js",
        "tests/sim/net.js",
        "tests/types.js",
      ],
      rules: { "no-bitwise": "off" },
    },
    {
      // The published types. Each of these rules would change what users' code type checks
      // against: method signatures are bivariant in their parameters where properties are not,
      // `{}` is the documented default of the custom types parameter, `any` is a row or a value
      // whose shape only the user's query knows, and `Function` matches the user's own helpers.
      // Interfaces, empty or indexed, are what users augment; PostgresError is a class users
      // construct and check with instanceof, so it is a value and a type of the same name; and
      // the helpers declare a private `then` so that awaiting one by mistake is a type error.
      files: ["types/index.d.ts"],
      rules: {
        "max-classes-per-file": "off",
        "no-redeclare": "off",
        "typescript/ban-types": "off",
        "typescript/consistent-indexed-object-style": "off",
        "typescript/method-signature-style": "off",
        "typescript/no-empty-interface": "off",
        "typescript/no-empty-object-type": "off",
        "typescript/no-explicit-any": "off",
        "unicorn/no-thenable": "off",
      },
    },
    {
      // The tests check the query's own `.forEach` (rows as they arrive), not Array#forEach, and
      // that throwing a non-Error such as "wat" or null from a callback rejects as it should.
      files: ["tests/**", "types/test.ts"],
      rules: {
        "no-throw-literal": "off",
        "unicorn/no-array-for-each": "off",
      },
    },
  ],
  rules: {
    // Every await in a loop here is sequential on purpose: hosts tried one after the other, rows
    // read one message after the next, polling until a server state is reached, the simulator's
    // clock running one timer per turn. Promise.all would change behaviour, not just shape.
    "no-await-in-loop": "off",
    // A connection is a set of closures that call each other: the socket's close handler
    // reconnects, which opens a socket, which installs the close handler. Function expressions can
    // only refer to each other from inside their bodies, so references from an inner scope are
    // allowed. A use before the definition in the same scope, which would throw, is still an error.
    "no-use-before-define": [
      "error",
      { classes: true, functions: false, variables: false },
    ],
    // The order of ticks is part of a driver's behaviour. `then(onFulfilled, onRejected)` is chosen
    // where `.catch()` would settle a tick later or would also catch what the first handler throws,
    // and where a callback is the API (Node's Writable `write(chunk, encoding, callback)`, a
    // rejection handler that must run on the same tick). These rules would rewrite exactly those.
    "promise/catch-or-return": "off",
    "promise/prefer-await-to-callbacks": "off",
    "promise/prefer-catch": "off",
    // `async` is how a function here promises to reject instead of throwing: a bad argument, a
    // closed connection or a wrong mode must reach the caller's catch, on the same tick as an
    // awaited failure would. Without an await in the body, the rule would take that away.
    "require-await": "off",
    // Sockets here are Node's (net.Socket, an EventEmitter) or objects shaped like one, as
    // options.socket requires on every runtime, and the library's own socket wrapper takes its
    // single close handler as a property. EventTarget and addEventListener are not their API.
    "unicorn/prefer-add-event-listener": "off",
    "unicorn/prefer-event-target": "off",
  },
});

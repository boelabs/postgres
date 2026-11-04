# Types and data

## Custom Types

You can add ergonomic support for custom types, or simply use `sql.typed(value, type)` inline, where type is the PostgreSQL `oid` for the type and the correctly serialized string. _(`oid` values for types can be found in the `pg_catalog.pg_type` table.)_

Adding Query helpers is the cleanest approach which can be done like this:

```js
const sql = postgres({
  types: {
    rect: {
      // The pg_types oid to pass to the db along with the serialized value.
      to        : 1337,

      // An array of pg_types oids to handle when parsing values coming from the db.
      from      : [1337],

      //Function that transform values before sending them to the db.
      serialize : ({ x, y, width, height }) => [x, y, width, height],

      // Function that transforms values coming from the db.
      parse     : ([x, y, width, height]) => { x, y, width, height }
    }
  }
})

// Now you can use sql.typed.rect() as specified above
const [custom] = await sql`
  insert into rectangles (
    name,
    rect
  ) values (
    'wat',
    ${ sql.typed.rect({ x: 13, y: 37, width: 42, height: 80 }) }
  )
  returning *
`

// custom = { name: 'wat', rect: { x: 13, y: 37, width: 42, height: 80 } }

```

A type whose oid isn't fixed, such as one from an extension, can be given by name instead, with `schema.name` allowed. Names are looked up when the pool starts, along with the type's array type, and queries wait for that. A name that doesn't exist rejects queries with `TYPE_NOT_FOUND`, and the lookup is tried again a second later, so a type created afterwards is found. Types by name need `fetch_types`.

```js
const sql = postgres({
  types: {
    vector: {
      to        : 'vector',
      from      : ['vector'],
      serialize : x => '[' + x.join(',') + ']',
      parse     : x => JSON.parse(x)
    }
  }
})

await sql`insert into items ${ sql({ embedding: sql.typed.vector([1, 2, 3]) }) }`
```

## Numbers, bigint, numeric

`Number` in javascript is only able to represent 2<sup>53</sup>-1 safely which means that types in PostgreSQLs like `bigint` and `numeric` won't fit into `Number`.

Since Node.js v10.4 we can use [`BigInt`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/BigInt) to match the PostgreSQL type `bigint` which is returned for eg. `count(*)`. Unfortunately, it doesn't work with `JSON.stringify` out of the box, so @boelabs/postgres will return it as a string.

If you want to use `BigInt` you can add this custom type:

```js
const sql = postgres({
  types: {
    bigint: postgres.BigInt
  }
})
```

There is currently no guaranteed way to handle `numeric` / `decimal` types in native Javascript. **These [and similar] types will be returned as a `string`**. The best way in this case is to use  [custom types](#custom-types).

## Data Transformation

@boelabs/postgres allows for transformation of the data passed to or returned from a query by using the `transform` option.

Built in transformation functions are:

* For camelCase - `postgres.camel`, `postgres.toCamel`, `postgres.fromCamel`
* For PascalCase - `postgres.pascal`, `postgres.toPascal`, `postgres.fromPascal`
* For Kebab-Case - `postgres.kebab`, `postgres.toKebab`, `postgres.fromKebab`

These built in transformations will only convert to/from snake_case. For example, using `{ transform: postgres.toCamel }` will convert the column names to camelCase only if the column names are in snake_case to begin with. `{ transform: postgres.fromCamel }` will convert camelCase only to snake_case.

By default, using `postgres.camel`, `postgres.pascal` and `postgres.kebab` will perform a two-way transformation - both the data passed to the query and the data returned by the query will be transformed:

```js
// Transform the column names to and from camel case
const sql = postgres({ transform: postgres.camel })

await sql`CREATE TABLE IF NOT EXISTS camel_case (a_test INTEGER, b_test TEXT)`
await sql`INSERT INTO camel_case ${ sql([{ aTest: 1, bTest: 1 }]) }`
const data = await sql`SELECT ${ sql('aTest', 'bTest') } FROM camel_case`

console.log(data) // [ { aTest: 1, bTest: '1' } ]
```

The built-in transforms also rename the keys of JSON values in results, but send JSON values as they are. Add `json: false` to leave JSON values as they are both ways, or `json: true` to rename their keys when sending as well: `postgres({ transform: { ...postgres.camel, json: false } })`.

To only perform half of the transformation (eg. only the transformation **to** or **from** camel case), use the other transformation functions:

> For historical reasons `postgres.toCamel`, `postgres.toPascal` and `postgres.toKebab` also transform the names given to helpers, as `camel`, `pascal` and `kebab` do. To transform only the column names of results, use `{ column: { from: postgres.toCamel } }`.

```js
// Transform the column names only to camel case
// (for the results that are returned from the query)
postgres({ transform: postgres.toCamel })

await sql`CREATE TABLE IF NOT EXISTS camel_case (a_test INTEGER)`
await sql`INSERT INTO camel_case ${ sql([{ a_test: 1 }]) }`
const data = await sql`SELECT a_test FROM camel_case`

console.log(data) // [ { aTest: 1 } ]
```

```js
// Transform the column names only from camel case
// (for interpolated inserts, updates, and selects)
const sql = postgres({ transform: postgres.fromCamel })

await sql`CREATE TABLE IF NOT EXISTS camel_case (a_test INTEGER)`
await sql`INSERT INTO camel_case ${ sql([{ aTest: 1 }]) }`
const data = await sql`SELECT ${ sql('aTest') } FROM camel_case`

console.log(data) // [ { a_test: 1 } ]
```

> Note that @boelabs/postgres does not rewrite the static parts of the tagged template strings. So to transform column names in your queries, the `sql()` helper must be used - eg. `${ sql('columnName') }` as in the examples above.

### Transform `undefined` Values

By default, @boelabs/postgres will throw the error `UNDEFINED_VALUE: Undefined values are not allowed` when undefined values are passed

```js
// Transform the column names to and from camel case
const sql = postgres({
  transform: {
    undefined: null
  }
})

await sql`CREATE TABLE IF NOT EXISTS transform_undefined (a_test INTEGER)`
await sql`INSERT INTO transform_undefined ${ sql([{ a_test: undefined }]) }`
const data = await sql`SELECT a_test FROM transform_undefined`

console.log(data) // [ { a_test: null } ]
```

To combine with the built in transform functions, spread the transform in the `transform` object:

```js
// Transform the column names to and from camel case
const sql = postgres({
  transform: {
    ...postgres.camel,
    undefined: null
  }
})

await sql`CREATE TABLE IF NOT EXISTS transform_undefined (a_test INTEGER)`
await sql`INSERT INTO transform_undefined ${ sql([{ aTest: undefined }]) }`
const data = await sql`SELECT ${ sql('aTest') } FROM transform_undefined`

console.log(data) // [ { aTest: null } ]
```

### Custom Transform Functions

To specify your own transformation functions, you can use the `column`, `value` and `row` options inside of `transform`, each an object possibly including `to` and `from` keys:

* `to`: The function to transform the outgoing query column name to, i.e `SELECT ${ sql('aName') }` to `SELECT a_name` when using `postgres.toCamel`.
* `from`: The function to transform the incoming query result column name to, see example below.

> Both parameters are optional, if not provided, the default transformation function will be used.

```js
// Implement your own functions, look at postgres.toCamel, etc
// as a reference:
// toCamel and the others in types.js
function transformColumnToDatabase() { /* ... */ }
function transformColumnFromDatabase() { /* ... */ }

const sql = postgres({
  transform: {
    column: {
      to: transformColumnToDatabase,
      from: transformColumnFromDatabase,
    },
    value: { /* ... */ },
    row: { /* ... */ }
  }
})
```

## Result Array

The `Result` Array returned from queries is a custom array allowing for easy destructuring or passing on directly to JSON.stringify or general Array usage. It includes the following properties.

### .count

The `count` property is the number of affected rows returned by the database. This is useful for insert, update and delete operations to know the number of rows since .length will be 0 in these cases if not using `RETURNING ...`.

### .command

The `command` run by the query - eg. one of `SELECT`, `UPDATE`, `INSERT`, `DELETE`

### .columns

The `columns` returned by the query useful to determine types, or map to the result values when using `.values()`

```js
{
  name  : String,    // Column name,
  type  : oid,       // PostgreSQL oid column type
  parser: Function   // The function used by @boelabs/postgres for parsing
}
```

### .statement

The `statement` contains information about the statement implicitly created by @boelabs/postgres.

```js
{
  name    : String,  // The auto generated statement name
  string  : String,  // The actual query string executed
  types   : [oid],   // An array of oid expected as input parameters
  columns : [Column] // Array of columns - same as Result.columns
}
```

### .state

This is the state `{ pid, secret }` of the connection that executed the query.

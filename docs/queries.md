# Queries

## ``await sql`...` -> Result[]``

@boelabs/postgres utilizes [Tagged template functions](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Template_literals#Tagged_templates) to process query parameters **before** interpolation. Using tagged template literals benefits developers by:

1. **Enforcing** safe query generation
2. Giving the ` sql`` ` function powerful [utility](#dynamic-inserts) and [query building](#building-queries) features.

Any generic value will be serialized according to an inferred type, and replaced by a PostgreSQL protocol placeholder `$1, $2, ...`. The parameters are then sent separately to the database which handles escaping & casting.

All queries will return a `Result` array, with objects mapping column names to each row.

```js
const xs = await sql`
  insert into users (
    name, age
  ) values (
    'Murray', 68
  )

  returning *
`;

// xs = [{ user_id: 1, name: 'Murray', age: 68 }]
```

> Please note that queries are first executed when `awaited` – or instantly by using [`.execute()`](advanced-queries.md#execute).

## Query parameters

Parameters are automatically extracted and handled by the database so that SQL injection isn't possible. No special handling is necessary, simply use tagged template literals as usual.

```js
const name = "Mur",
  age = 60;

const users = await sql`
  select
    name,
    age
  from users
  where
    name like ${name + "%"}
    and age > ${age}
`;
// users = [{ name: 'Murray', age: 68 }]
```

> Be careful with quotation marks here. Because Postgres infers column types, you do not need to wrap your interpolated parameters in quotes like `'${name}'`. This will cause an error because the tagged template replaces `${name}` with `$1` in the query string, leaving Postgres to do the interpolation. If you wrap that in a string, Postgres will see `'$1'` and interpret it as a string as opposed to a parameter.

## Parameter types

The server decides the type of every parameter from the query, as with libpq and `psql`, and each value is written for the type the server asked for. A `Date` for a `timestamptz` or `timestamp` column is stored as the instant it is, a `timestamp` is read back as UTC, and a string such as `'true'` for a `boolean` is read by the server.

Where the query doesn't decide the type, such as a value in the select list or an argument to an overloaded function like `date_trunc`, the server reads the value as text or asks for a cast. A cast always decides:

```js
await sql`select date_trunc('day', ${date}::timestamptz)`;
await sql`select ${flag}::bool as flag`;
```

`infer: true` types values from JavaScript instead, as postgres v3 did: a `Date` as `timestamptz`, a `Buffer` or `Uint8Array` as `bytea`, a boolean as `boolean`, a `bigint` as `int8`, and an array by its first element. See [Migrating from postgres](migrating.md#migrating-from-postgres) for what that changes.

## Dynamic column selection

```js
const columns = ['name', 'age']

await sql`
  select
    ${ sql(columns) }
  from users
`

// Which results in:
select "name", "age" from users
```

## Dynamic inserts

```js
const user = {
  name: 'Murray',
  age: 68
}

await sql`
  insert into users ${
    sql(user, 'name', 'age')
  }
`

// Which results in:
insert into users ("name", "age") values ($1, $2)

// The columns can also be given with an array
const columns = ['name', 'age']

await sql`
  insert into users ${
    sql(user, columns)
  }
`
```

**You can omit column names and simply execute `sql(user)` to get all the fields from the object as columns**. Be careful not to allow users to supply columns that you do not want to be inserted.

### Multiple inserts in one query

If you need to insert multiple rows at the same time it's also much faster to do it with a single `insert`. Simply pass an array of objects to `sql()`.

```js
const users = [{
  name: 'Murray',
  age: 68,
  garbage: 'ignore'
},
{
  name: 'Walter',
  age: 80
}]

await sql`insert into users ${ sql(users, 'name', 'age') }`

// Is translated to:
insert into users ("name", "age") values ($1, $2), ($3, $4)

// Here you can also omit column names which will use object keys as columns
await sql`insert into users ${ sql(users) }`

// Which results in:
insert into users ("name", "age") values ($1, $2), ($3, $4)
```

## Dynamic columns in updates

This is also useful for update queries

```js
const user = {
  id: 1,
  name: 'Murray',
  age: 68
}

await sql`
  update users set ${
    sql(user, 'name', 'age')
  }
  where user_id = ${ user.id }
`

// Which results in:
update users set "name" = $1, "age" = $2 where user_id = $3

// The columns can also be given with an array
const columns = ['name', 'age']

await sql`
  update users set ${
    sql(user, columns)
  }
  where user_id = ${ user.id }
`
```

## Multiple updates in one query

To create multiple updates in a single query, it is necessary to use arrays instead of objects to ensure that the order of the items correspond with the column names.

```js
const users = [
  [1, "John", 34],
  [2, "Jane", 27],
];

await sql`
  update users set name = update_data.name, age = (update_data.age)::int
  from (values ${sql(users)}) as update_data (id, name, age)
  where users.id = (update_data.id)::int
  returning users.id, users.name, users.age
`;
```

## Dynamic values and `where in`

Value lists can also be created dynamically, making `where in` queries simple too.

```js
const users = await sql`
  select
    *
  from users
  where age in ${sql([68, 75, 23])}
`;
```

or

```js
const [{ a, b, c }] = await sql`
  select
    *
  from (values ${sql(["a", "b", "c"])}) as x(a, b, c)
`;
```

## Named arguments in function calls

An object in the parentheses of a function call becomes its named arguments.

```js
await sql`
  select make_interval(${ sql({ days: 1, hours: 2 }) })
`

// Which results in:
select make_interval("days" => $1,"hours" => $2)
```

## Building queries

@boelabs/postgres features a simple dynamic query builder by conditionally appending/omitting query fragments. It works by nesting ` sql`` ` fragments within other ` sql`` ` calls or fragments. This allows you to build dynamic queries safely without risking sql injections through usual string concatenation.

### Partial queries

```js
const olderThan = x => sql`and age > ${ x }`

const filterAge = true

await sql`
  select
   *
  from users
  where name is not null ${
    filterAge
      ? olderThan(50)
      : sql``
  }
`
// Which results in:
select * from users where name is not null
// Or
select * from users where name is not null and age > 50
```

### Dynamic filters

```js
await sql`
  select
    *
  from users ${
    id
      ? sql`where user_id = ${ id }`
      : sql``
  }
`

// Which results in:
select * from users
// Or
select * from users where user_id = $1
```

Identifiers and values combine with operators, such as for a field of a `json` column:

```js
const column = email ? 'notifications' : 'settings'

await sql`
  select * from users where ${ sql(column) }->>'email' = ${ 'true' }
`

// Which results in:
select * from users where "notifications"->>'email' = $1
```

### Joining fragments

A fragment used as a separator joins a list of fragments and values. Values become parameters, and `false`, `null` and `undefined` are left out, so conditions can be written inline. A space is added on each side of the separator, and around the result, where there isn't one already.

```js
const where = sql`and`.join([
  sql`age > ${ age }`,
  name && sql`name = ${ name }`
])

await sql`
  select * from users ${ where.length ? sql`where ${ where }` : sql`` }
`

// Which results in:
select * from users where age > $1 and name = $2
```

### Dynamic ordering

```js
const id = 1;
const order = {
  username: "asc",
  created_at: "desc",
};
await sql`
  select
    *
  from ticket
  where account = ${id}
  order by ${Object.entries(order).flatMap(([column, order], i) => [
    i ? sql`,` : sql``,
    sql`${sql(column)} ${order === "desc" ? sql`desc` : sql`asc`}`,
  ])}
`;
```

### SQL functions

Using keywords or calling functions dynamically is also possible by using ` sql`` ` fragments.

```js
const date = null

await sql`
  update users set updated_at = ${ date || sql`now()` }
`

// Which results in:
update users set updated_at = now()
```

### Table names

Dynamic identifiers like table names and column names is also supported like so:

```js
const table = 'users'
    , column = 'id'

await sql`
  select ${ sql(column) } from ${ sql(table) }
`

// Which results in:
select "id" from "users"
```

### Quick primer on interpolation

Here's a quick oversight over all the ways to do interpolation in a query template string:

| Interpolation syntax | Usage | Example |
| --- | --- | --- |
| `${ sql`` }` | for keywords or sql fragments | ``await sql`SELECT * FROM users ${sql`order by age desc` }` `` |
| `${ sql(string) }` | for identifiers | ``await sql`SELECT * FROM ${sql('table_name')` `` |
| `${ sql([] or {}, ...) }` | for helpers | ``await sql`INSERT INTO users ${sql({ name: 'Peter'})}` `` |
| `${ 'somevalue' }` | for values | ``await sql`SELECT * FROM users WHERE age = ${42}` `` |

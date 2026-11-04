# TypeScript

`postgres` has TypeScript support. You can pass a row list type for your queries in this way:
```ts
interface User {
  id: number
  name: string
}

const users = await sql<User[]>`SELECT * FROM users`
users[0].id // ok => number
users[1].name // ok => string
users[0].invalid // fails: `invalid` does not exists on `User`
```

However, be sure to check the array length to avoid accessing properties of `undefined` rows:
```ts
const users = await sql<User[]>`SELECT * FROM users WHERE id = ${id}`
if (!users.length)
  throw new Error('Not found')
return users[0]
```

You can also prefer destructuring when you only care about a fixed number of rows.
In this case, we recommend you to prefer using tuples to handle `undefined` properly:
```ts
const [user]: [User?] = await sql`SELECT * FROM users WHERE id = ${id}`
if (!user) // => User | undefined
  throw new Error('Not found')
return user // => User

// NOTE:
const [first, second]: [User?] = await sql`SELECT * FROM users WHERE id = ${id}` // fails: `second` does not exist on `[User?]`
const [first, second] = await sql<[User?]>`SELECT * FROM users WHERE id = ${id}` // don't fail : `second: User | undefined`
```

The types that matter are also exported by name:

```ts
import postgres, { type Sql, type TransactionSql, type Row } from '@boelabs/postgres'

function users(sql: Sql) {
  return sql<User[]>`select * from users`
}
```

A function that should run on the pool, in a transaction or on a reserved connection alike takes `ISql`, which is what the three have in common:

```ts
import postgres, { type ISql } from '@boelabs/postgres'

function users(sql: ISql) {
  return sql<User[]>`select * from users`
}

await users(sql)
await sql.begin(sql => users(sql))
```

`PostgresError` is exported by name too, so `import { PostgresError } from '@boelabs/postgres'` works with `instanceof`.

The types are checked against a test of their own with TypeScript 7. Feel free to open an issue if you have trouble with types.

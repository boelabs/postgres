# Getting started

## Usage

Create your `sql` database instance

```js
// db.js
import postgres from "@boelabs/postgres";

const sql = postgres({/* options */}); // will use psql environment variables

export default sql;
```

Simply import for use elsewhere

```js
// users.js
import sql from "./db.js";

async function getUsersOver(age) {
  const users = await sql`
    select
      name,
      age
    from users
    where age > ${age}
  `;
  // users = Result [{ name: "Walter", age: 80 }, { name: 'Murray', age: 68 }, ...]
  return users;
}

async function insertUser({ name, age }) {
  const users = await sql`
    insert into users
      (name, age)
    values
      (${name}, ${age})
    returning name, age
  `;
  // users = Result [{ name: "Murray", age: 68 }]
  return users;
}
```

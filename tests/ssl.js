import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import tls from "node:tls";

import { postgres, options, idle_timeout } from "./setup.js";
import { t } from "./test.js";

// The test servers present a self-signed certificate for localhost, which tests/setup.sh makes. It is
// read through the server, so these tests also work where its data directory is not readable.
let files = null;
const certificates = async () => {
  if (files) {
    return files;
  }

  const su = postgres({ idle_timeout, max: 1 });
  const [{ pem }] =
    await su`select pg_read_file(current_setting('ssl_cert_file')) as pem`;
  await su.end();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boelabs-postgres-ssl-"));
  files = {
    missing: path.join(dir, "missing.crt"),
    other: path.join(dir, "other.crt"),
    server: path.join(dir, "server.crt"),
  };
  fs.writeFileSync(files.server, pem);
  fs.writeFileSync(files.other, tls.rootCertificates.join("\n"));
  return files;
};

const base = {
  ...options,
  host: "localhost",
  idle_timeout,
  max: 1,
  port: options.port || 5432,
};

const encrypted = async (extra) => {
  const sql = postgres({ ...base, ...extra });
  try {
    const [{ ssl }] =
      await sql`select ssl from pg_stat_ssl where pid = pg_backend_pid()`;
    return ssl;
  } finally {
    await sql.end({ timeout: 0 });
  }
};

// Rejects, with an error, and soon: a TLS failure used to hang a query forever under Bun.
const refused = async (extra) => {
  const sql = postgres({ ...base, connect_timeout: 2, ...extra });
  const x = await Promise.race([
    sql`select 1`.then(
      () => "connected",
      (error) => error
    ),
    sleep(5000, "pending"),
  ]);
  await sql.end({ timeout: 0 });
  return x instanceof Error ? "rejected" : x;
};

t("sslmode require encrypts without checking the certificate", async () => [
  true,
  await encrypted({ ssl: "require" }),
]);

t(
  "sslmode verify-full rejects a certificate no trusted authority signed",
  async () => ["rejected", await refused({ ssl: "verify-full" })]
);

t(
  "sslmode verify-full with sslrootcert connects to the host the certificate names",
  async () => {
    const { server } = await certificates();
    return [true, await encrypted({ ssl: "verify-full", sslrootcert: server })];
  }
);

t(
  "sslmode verify-full with sslrootcert rejects a host the certificate does not name",
  async () => {
    const { server } = await certificates();
    return [
      "rejected",
      await refused({
        host: "127.0.0.1",
        ssl: "verify-full",
        sslrootcert: server,
      }),
    ];
  }
);

t("sslmode verify-ca checks the authority but not the host name", async () => {
  const { server, other } = await certificates();
  return [
    "true rejected",
    `${await encrypted({
      host: "127.0.0.1",
      ssl: "verify-ca",
      sslrootcert: server,
    })} ${await refused({
      host: "127.0.0.1",
      ssl: "verify-ca",
      sslrootcert: other,
    })}`,
  ];
});

t(
  "sslmode require with sslrootcert checks the authority, as in libpq",
  async () => {
    const { server, other } = await certificates();
    return [
      "true rejected",
      `${await encrypted({
        host: "127.0.0.1",
        ssl: "require",
        sslrootcert: server,
      })} ${await refused({
        ssl: "require",
        sslrootcert: other,
      })}`,
    ];
  }
);

t(
  "sslmode and sslrootcert in the url are read, not sent to the server",
  async () => {
    const { server } = await certificates();
    const url = `postgres://${base.user}@localhost:${base.port}/${
      base.db
    }?sslmode=verify-full&sslrootcert=${encodeURIComponent(server)}`;
    const sql = postgres(url, { idle_timeout, max: 1 });
    const [{ ssl }] =
      await sql`select ssl from pg_stat_ssl where pid = pg_backend_pid()`;
    await sql.end();
    return [true, ssl];
  }
);

t("PGSSLMODE sets the mode when the url and the options do not", async () => {
  process.env.PGSSLMODE = "require";
  try {
    const sql = postgres({ ...base });
    const mode = sql.options.ssl;
    await sql.end();
    return ["require", mode];
  } finally {
    delete process.env.PGSSLMODE;
  }
});

t("An unknown sslmode throws", () => [
  "sslmode verify_full is not supported",
  (() => {
    try {
      postgres({ ...base, ssl: "verify_full" });
    } catch (error) {
      return error.message;
    }
  })(),
]);

t("A missing sslrootcert file rejects the query", async () => {
  const { missing } = await certificates();
  return [
    "rejected",
    await refused({
      ssl: "verify-full",
      sslrootcert: missing,
    }),
  ];
});

t("TLS is not asked for over a Unix socket, as in libpq", async () => [
  false,
  await encrypted({ host: process.env.PGSOCKET || "/tmp", ssl: "require" }),
]);

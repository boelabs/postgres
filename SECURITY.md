# Security Policy

## Reporting a vulnerability

**Please do not open public issues for security vulnerabilities.**

Report them privately through GitHub's [private vulnerability reporting](https://github.com/boelabs/postgres/security/advisories/new).

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce or a proof of concept, with the runtime (Node.js, Bun or Cloudflare Workers) and PostgreSQL versions.
- Affected versions, if known.

You can expect an acknowledgement within **72 hours** and a status update within **7 days**. We ask that you give us a reasonable window to ship a fix before any public disclosure.

## Scope

@boelabs/postgres speaks the PostgreSQL wire protocol, handles credentials (passwords, SCRAM, client certificates) and decides how TLS is negotiated and verified. Of particular interest:

- Anything that lets a value reach the server as SQL instead of as a parameter.
- TLS: a mode that verifies less than it says, or a downgrade to an unencrypted connection.
- Authentication: a password sent where it should not be, or SCRAM and channel binding skipped.
- A server or a network able to make the client hang, crash or mix up the answers of two queries.

Never paste real passwords, connection strings or private keys into a report.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.x     | ✅        |

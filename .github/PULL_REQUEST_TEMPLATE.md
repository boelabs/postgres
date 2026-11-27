## Summary

<!-- What changes, and why. Two to five sentences. Link the issue if there is one. -->

**Type:** <!-- bug fix | feature | performance | refactor | docs | tests | CI | breaking change -->

## Checklist

- [ ] `pnpm run check` (Ultracite: Oxlint and Oxfmt) and `pnpm run test:types` pass
- [ ] `pnpm test` (or `pnpm run test:docker`) passes, and the Bun suite too if the change can behave differently there (`sh tests/docker/run.sh bun tests/index.js`)
- [ ] A test that fails without the change
- [ ] Cloudflare Workers considered: no Node.js-only API without a guard (`pnpm run test:cf` if it touches sockets, TLS or startup)
- [ ] The page in `docs/`, `types/index.d.ts` (+ `types/test.ts`) and `CHANGELOG.md` updated if behaviour or the public API changed
- [ ] No new dependency; no secrets, real connection strings or private keys

## Notes for reviewers

<!-- Trade-offs, risks, follow-ups, anything needing special attention. Delete if none. -->

<!--
Merging: `main` is protected. Wait for every check to pass, then squash-merge.
-->

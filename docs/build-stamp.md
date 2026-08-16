# Build stamp in the sidebar

Under Sign Out, the shell now shows the deployed commit and the date it was pushed —
replacing the hardcoded `build 50 · freight alerts` line, which had to be edited by hand
and so was always wrong.

    build a3f19c2
    Aug 16, 2026 2:41 PM

Hovering gives the commit subject, the branch, the author, the push time and the deploy
time. A preview deployment also prints its environment (`preview`) on a third line, so
there is no mistaking it for production.

## Files

| File                      | Role                                                            |
| ------------------------- | --------------------------------------------------------------- |
| `scripts/build-stamp.mjs` | **New.** Writes the stamp at the start of every build           |
| `src/lib/buildStamp.ts`   | **New.** Generated; committed with nulls as the dev placeholder |
| `src/lib/buildInfo.ts`    | **New.** Resolves the stamp, with the Vercel env as fallback    |
| `src/routes/health.ts`    | **Replace.** Adds `GET /build-info`                             |
| `vercel.json`             | **Replace.** Runs the stamp script first in the build           |
| `package.json`            | **Replace.** Adds a `pnpm stamp` script for local use           |
| `public/app.js`           | **Replace.** Reads it and renders it under Sign Out             |

```
mkdir scripts
copy /Y fixes\scripts\build-stamp.mjs scripts\build-stamp.mjs
copy /Y fixes\src\lib\buildStamp.ts src\lib\buildStamp.ts
copy /Y fixes\src\lib\buildInfo.ts src\lib\buildInfo.ts
copy /Y fixes\src\routes\health.ts src\routes\health.ts
copy /Y fixes\vercel.json vercel.json
copy /Y fixes\package.json package.json
copy /Y fixes\public\app.js public\app.js
pnpm stamp
pnpm typecheck
```

`pnpm stamp` before `pnpm typecheck` is worth doing once so you can see it working
locally; from then on Vercel runs it on every deploy.

## Answering the question directly

**Nothing updated the version before this.** That sidebar string was literal text in
`app.js`, so it read "build 50" regardless of what was deployed. There was no other
version marker anywhere in the app.

## Two decisions

**A generated TypeScript module, not a JSON file read at runtime.** Vercel's bundler
traces imports, not `readFileSync` calls, so a root-level `build-info.json` is not
guaranteed to reach the function — the stamp would silently vanish in production, which is
the only place it matters. An import cannot be missed. The committed placeholder is what
keeps a fresh checkout compiling before anyone has run the script.

**The commit date is shown, not the build date.** "Is my fix live?" is a question about
the push. The two differ only when a deploy is retried or a build is promoted later, and
both are in the tooltip for when that distinction matters. If the commit date cannot be
read — Vercel's checkout is shallow, and on rare occasions the tip commit's date is not
available — the build time is shown instead, and the tooltip labels each.

**`/build-info` is unauthenticated.** The shell asks for it while the login screen is
still up, which is exactly when knowing your build matters most. A commit sha and subject
line say what changed, not how anything works.

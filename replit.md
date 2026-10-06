# Email Chat

An email-first direct messaging app where people register, discover contacts by email, and send one-to-one messages.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API gateway and Flask chat service (port 8080)
- `pnpm --filter @workspace/email-chat run dev` — run the React + Tailwind app
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — PostgreSQL connection string; Clerk keys are managed by Replit.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Web: React, Vite, Tailwind CSS
- Auth and API gateway: Clerk + Express 5
- Chat API: Flask + Gunicorn + psycopg, started by the API gateway
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/email-chat/` — messenger UI, Clerk sign-in/sign-up, generated API hooks
- `artifacts/api-server/src/flask_backend/app.py` — chat, contact, and message endpoints
- `artifacts/api-server/src/routes/chatProxy.ts` — Clerk-gated gateway from `/api` to Flask
- `lib/api-spec/openapi.yaml` — API contract and generated client source
- `lib/db/src/schema/chat.ts` — PostgreSQL chat schema

## Architecture decisions

- Clerk handles email/password registration and account identity; Flask does not store passwords.
- Express resolves the Clerk session and passes identity to a loopback-only Flask process; Flask owns chat business logic.
- Conversations are unique per pair of participants, with ids sorted before insert.

## Product

- Register and sign in using email through Clerk.
- Find and add contacts by email address.
- Start direct conversations and send text messages.
- Review conversations and refresh new messages.

## User preferences

- Keep this product email-first; do not require or use mobile numbers for registration or contact discovery.

## Gotchas

- The API service starts Flask internally on `127.0.0.1:8000`; use public `/api` routes rather than exposing the Flask port.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details

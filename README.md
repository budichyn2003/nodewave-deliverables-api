# NodeWave Deliverables API

Backend sistem manajemen deliverables untuk NodeWave — REST API dibangun dengan **Bun + Hono + Prisma 7 (PostgreSQL) + Zod + `@nodewave/prisma-ezfilter`**, di-lint dengan **Biome**.

Frontend (Next.js) ada di **repo terpisah**; kontrak lengkapnya didokumentasikan di [`docs/API.md`](docs/API.md).

## Fitur

- **Auth** — register (selalu INTERNAL), login JWT, logout stateless (tokenVersion), `/auth/me`
- **Projects & membership** — CRUD, PM-only management, RBAC + ABAC (membership)
- **Tasks** — CRUD, state machine `TODO → IN_PROGRESS → DONE` (+ reopen), **permission berbasis status & role**
- **Dependencies** — acyclic, same-project; status **BLOCKED diturunkan** (tidak disimpan)
- **Optimistic locking** — `version` wajib di setiap write task; bentrok → `409 VERSION_CONFLICT`
- **Immutable audit trail** — diff per-field, transaksional, append-only dijamin trigger PostgreSQL
- **Soft delete** — semua model via Prisma extension (`delete` di-reroute ke update `deletedAt`), restore task
- **Client view** — masking server-side (allow-list per-field), tenant dari membership
- **Attachments & comments** — upload tervalidasi (whitelist mime/ekstensi/size), comment internal/publik
- **Standup report (bonus)** — `completedYesterday` dari audit trail, `blockedToday` live, timezone Asia/Jakarta
- **Query contract** — filter/search/range/order/pagination ter-whitelist di semua endpoint list

Dokumentasi: [docs/API.md](docs/API.md) (kontrak untuk FE) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (keputusan desain).

## Mulai Cepat

```bash
bun install
cp .env.example .env          # sesuaikan DATABASE_URL bila perlu
bun run db:migrate            # prisma migrate dev
bun run db:seed               # data demo (idempotent)
bun run dev                   # http://localhost:3001
```

> Database: PostgreSQL lokal (mis. container `deliverables-postgres` dari docker-compose yang ada di repo ini untuk convenience dev — aplikasi sendiri **tidak** memakai Docker untuk build/deploy).

### Scripts

| Script | Fungsi |
|---|---|
| `bun run dev` | Dev server (watch) di `PORT` (default 3001) |
| `bun run test` | Test suite (memakai `DATABASE_URL_TEST`) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` / `check` / `format` | Biome |
| `bun run db:migrate` / `db:deploy` | Migrate dev / deploy |
| `bun run db:seed` | Seed idempotent |
| `bun run db:generate` | Generate Prisma client (`generated/prisma`) |

## Environment

Lihat [.env.example](.env.example) — ter-validasi Zod saat boot (fail fast). Yang penting:

| Var | Default | Keterangan |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL utama |
| `DATABASE_URL_TEST` | — | DB test (dipakai otomatis oleh `bun test`) |
| `JWT_SECRET` | — | min 16 karakter |
| `JWT_EXPIRES_IN` | `12h` | Umur access token |
| `FRONTEND_ORIGIN` | `http://localhost:3000` | CORS (boleh beberapa, comma-separated) |
| `PORT` | `3001` | HTTP port |
| `STORAGE_DRIVER` | `local` | `local` (dev) / `s3` (placeholder) |
| `MAX_UPLOAD_SIZE_MB` | `10` | Batas upload |
| `SEED_*_PASSWORD` | lihat `.env.example` | Password akun seed |

## Kredensial Seed (dev)

`bun run db:seed` membuat data demo idempotent (re-run tanpa duplikat):

| Role | Email | Password default |
|---|---|---|
| PM | `pm@nodewave.test` | `Pm123456!` |
| INTERNAL | `uiux@nodewave.test`, `frontend@nodewave.test`, `backend@nodewave.test` | `Internal123!` |
| CLIENT | `client-a@nodewave.test` (Project A), `client-b@nodewave.test` (Project B) | `Client123!` |

Data demo:

- **Project A** "Website Revamp — PT Maju Jaya": `UI Design: Dashboard` (DONE), `Backend API Integration` (IN_PROGRESS), `Frontend Slicing` (**BLOCKED** — depends on keduanya), `Assets Cleanup` (internal-only). Comment internal/publik, attachment, dan audit history pra-ada — siap demo standup & audit.
- **Project B** "Mobile App — PT Sejahtera": untuk demo **isolasi tenant** (client-a tidak melihat project B).

## Testing

```bash
bun run test
```

106 test integrasi (HTTP level, app Hono in-memory) + unit test fungsi murni — mencakup auth, projects, tasks/state machine/dependencies, audit & optimistic locking, attachments/comments, client view, standup, dan query contract. Test memakai database `deliverables_test` (di-set oleh preload `tests/setup.ts`) dan di-reset per test.

## Health Check

```
GET /health  →  { "status": "ok", "service": "nodewave-deliverables-api", "time": "..." }
```

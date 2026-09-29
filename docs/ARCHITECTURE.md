# NodeWave Deliverables API — Architecture

Bun + Hono + Prisma 7 (PostgreSQL) + Zod + `@nodewave/prisma-ezfilter` + JWT + Biome. Monorepo tidak dipakai: repo ini backend-only; frontend (Next.js) ada di repo terpisah.

Dokumen ini menjelaskan **kenapa**, bukan tuntasnya endpoint (lihat `docs/API.md` untuk kontrak).

---

## 1. Layering & RBAC + ABAC

```
routes → (middleware auth) → service → policies/ → prisma (extended)
```

- **routes.ts** — parsing (Zod), envelope `ok/okList`, tidak ada logika izin.
- **service.ts** — aturan bisnis, transaksi, audit, optimistic locking.
- **policies/** — fungsi murni RBAC+ABAC (`canCreateTask`, `canManageMembers`, …) sehingga bisa di-unit-test dan dipakai ulang `allowedActions`.
- **middleware/auth.ts** — verifikasi JWT + load user fresh dari DB tiap request.

**RBAC** = peran global (`PM` / `INTERNAL` / `CLIENT`): siapa boleh create project/task, upload, lihat audit. **ABAC** = atribut: **membership project** (gate utama — bukan member → 404, disengaja sama dengan "tidak ada", agar tidak bocor keberadaan resource), department untuk matching task↔assignee, dan status/assignee task saat transisi.

Register publik selalu membuat **INTERNAL** — role PM/CLIENT tidak bisa dipilih publik (assumption, mencegah privilege escalation).

---

## 2. State-based Permissions

Status tersimpan hanya `TODO / IN_PROGRESS / DONE`. **BLOCKED tidak pernah disimpan** — selalu diturunkan dari dependency (`tasks/blocked.ts`: `effectiveStatus`, `isBlocked`, `blockedBy`). Satu sumber kebenaran, tidak ada status yang bisa basi.

Evaluasi transisi (`tasks/transitions.ts`, fungsi murni, urutan sesuai brief):

1. **membership (ABAC)** → `FORBIDDEN_TRANSITION / NOT_A_MEMBER`
2. **state machine** (`ALLOWED_TRANSITIONS`: TODO→IN_PROGRESS, IN_PROGRESS→DONE, reopen IN_PROGRESS→TODO & DONE→IN_PROGRESS) → `INVALID_TRANSITION`
3. **role (RBAC)** → hanya **assignee** boleh complete; PM tidak boleh complete task orang (`PM_CANNOT_COMPLETE` / `NOT_ASSIGNEE`)
4. **dependency rule** → mulai/reopen butuh semua prerequisite DONE → `TASK_BLOCKED` (+ `blockedBy[]`)
5. **optimistic lock** (di service, butuh DB) → `VERSION_CONFLICT`

`allowedActions` di response task dihitung dengan **fungsi policy yang sama**, jadi hint UI selalu konsisten dengan keputusan server.

---

## 3. Task Dependencies

- Edge `TaskDependency(taskId, dependsOnId)`, unique constraint, soft-deletable.
- Tambah dependency tervalidasi **DFS di graph seluruh project** (`dependencies-graph.ts`): menolak `SELF_DEPENDENCY`, `CROSS_PROJECT_DEPENDENCY`, dan `DEPENDENCY_CYCLE` (dengan `details.cycle` = path siklus).
- Efek ke status: turunan (BLOCKED) — lihat §2.
- Audit: `DEPENDENCY_ADD` / `DEPENDENCY_REMOVE` ditulis ke task yang terdampak (`column: "dependencies"`).

---

## 4. Concurrency — Optimistic Locking

Task membawa kolom `version` (increment tiap write sukses). Semua write (`PATCH /tasks/:id`, `POST /tasks/:id/status`) **wajib** `version` di body:

```ts
updateMany({ where: { id, version }, data: { ...changes, version: { increment: 1 } } })
// count === 0 -> 409 VERSION_CONFLICT + details.currentVersion + currentTask
```

Conditional write = atomic, tanpa lock eksplisit. PM yang menang race harus reload dulu — tidak ada overwrite diam-diam.

---

## 5. Audit Trail + Soft Delete

**Audit** (`TaskAuditLog`): baris per-field (`column`, `oldValue`, `newValue`, `action`), ditulis **dalam transaksi yang sama** dengan perubahan (`audit/writer.ts`) — atomic "tidak ada perubahan tanpa log". **Append-only dijamin DB**: migration raw SQL memasang **trigger PostgreSQL** yang menolak UPDATE/DELETE pada tabel ini — bahkan klien DB pun tidak bisa menghapus history.

**Soft delete**: semua model kecuali `TaskAuditLog` punya `deletedAt`. Implementasi sebagai **Prisma extension** (`lib/prisma.ts`): read/write otomatis difilter `deletedAt: null`; `delete`/`deleteMany` di-reroute ke `update` (stamp `deletedAt` di raw client) sehingga hard delete mustahil lewat kode aplikasi. Escape hatch eksplisit: `prisma.$includeDeleted()` (restore/seed/audit graveyard).

Kombinasi keduanya = history lengkap & dapat di-audit; data "hilang" sebenarnya masih ada dan bisa di-restore.

---

## 6. Client Isolation & Data Masking

- **Tenant derivation**: project klien diambil dari **membership row**, bukan parameter URL. CLIENT = tepat satu project (invariant di `addMember`).
- **Masking allow-list** (`client-view/serializers.ts`): response client **dibangun field-per-field**, bukan delete dari shape internal — field baru tidak bisa bocor by accident. Dilarang by design: assignee, department, email, comments, attachments, audit, dependency titles.
- `clientTitle` = teks client-safe dari PM; kalau kosong → literal `"(details pending)"` (bukan judul internal).
- CLIENT yang memanggil endpoint internal `/tasks/*` → 404 (identik dengan non-member).
- Metrik `/client/project` dihitung atas **semua** task (assumption, angka jujur), task list client hanya `clientVisible`.

---

## 7. Query Contract (ezfilter)

Semua list endpoint lewat `lib/ezfilter.ts` — adapter di atas `@nodewave/prisma-ezfilter` dengan whitelist per resource. Nilai tambah adapter:

- pre-parse JSON → `MALFORMED_JSON` 400 (ezfilter asli menelan JSON rusak),
- field di luar whitelist → 400 (bukan diabaikan),
- multi-kolom search beda tipe → `SEARCH_TYPE_MISMATCH`,
- cap `rows` 100,
- guard `Object.keys(orderBy).length > 0` (ezfilter selalu emit `orderBy: {}`; Prisma 7 menolak orderBy kosong),
- terima `orderKey` dan `orderkey`.

`searchableTypes` menjaga multi-column search tetap type-safe. Scope otorisasi (mis. `projectId`, `clientVisible`, membership) **di-AND di atas** filter user dan tidak bisa dioverride.

---

## 8. Auth & Session

JWT access token (HS256, `JWT_EXPIRES_IN` default 12h). **Logout stateless**: bump `tokenVersion` di user; middleware membandingkan claim vs DB tiap request → token lama = `TOKEN_REVOKED`. Dipilih daripada tabel RevokedToken: satu kolom, tanpa tabel tambahan, berlaku lintas device. Password = **argon2id** (19MB, t=2). Payload user **di-load fresh dari DB** tiap request — role/department yang di-downgrade langsung efektif.

---

## 9. Bonus: Standup Report

`GET /projects/:id/standup?date=YYYY-MM-DD` (default kemarin, **Asia/Jakarta** fixed UTC+7 — window `dayWindow` dihitung eksplisit; `defaultStandupDate` shift maju +7 jam lalu mundur 1 hari, terverifikasi unit test).

- **completedYesterday** = baris audit `column=status, newValue=DONE` dalam window hari — akurat historis karena audit append-only.
- **blockedToday** = live: task yang saat ini punya prerequisite belum DONE (shared `liveDependencies` dengan client-view).

Known limitation (dokumentasi disengaja): blockedToday adalah snapshot **sekarang**, bukan state historis jam standup kemarin — itu butuh event store terpisah (out of scope).

---

## 10. Assumptions & Decisions (ringkas)

1. Register publik → INTERNAL tanpa department; PM/CLIENT via seed. Department diisi PM (di luar scope endpoint).
2. Non-member → 404, bukan 403 (anti-enumeration).
3. Logout stateless via `tokenVersion`, bukan denylist.
4. BLOCKED derived, tidak disimpan.
5. Reopen path: `IN_PROGRESS→TODO` dan `DONE→IN_PROGRESS` (dependency rule tetap berlaku saat reopen).
6. Audit per-field dalam transaksi yang sama; immutable via trigger DB.
7. Local-disk storage driver (dev/demo); interface siap S3. File lokal **ephemeral** di kebanyakan host — production pakai `STORAGE_DRIVER=s3`.
8. Docker hanya untuk PostgreSQL lokal (docker-compose untuk dev convenience), **tidak** dipakai untuk build/deploy aplikasi (sesuai kebutuhan; no Dockerfile).
9. CLIENT satu project (invariant), metrik klien atas semua task.

## 11. Known Limitations

1. `blockedToday` standup = snapshot live, bukan historis.
2. Local storage tidak durable di PaaS; S3 driver masih placeholder.
3. Tidak ada pagination cursor (offset pagination standar, rows ≤ 100).
4. Tidak ada rate limiting / account lockout (di luar scope brief).
5. Frontend upload URL preview harus prepend base backend (URL relatif `/files/...`).

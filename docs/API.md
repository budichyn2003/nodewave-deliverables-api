# NodeWave Deliverables API — Frontend Reference

Base URL: `http://localhost:3001/api/v1` (dev). Semua response JSON.

Dokumen ini untuk tim **frontend**. Untuk keputusan desain internal backend lihat `docs/ARCHITECTURE.md`.

---

## 1. Response Envelope

**Sukses (single):**

```json
{ "success": true, "data": { "...": "..." } }
```

**Sukses (list)** — tambah `meta`:

```json
{
  "success": true,
  "data": [ "...", "..." ],
  "meta": { "page": 1, "rows": 20, "total": 57, "totalPages": 3 }
}
```

**Error** — semua error punya bentuk yang sama:

```json
{
  "success": false,
  "error": { "code": "TASK_BLOCKED", "message": "...", "details": { "blockedBy": [ /* ... */ ] } }
}
```

`code` adalah string stabil — **react ke `code`, jangan ke `message`**. Daftar lengkap di §8.

---

## 2. Authentication

**Bearer token** di header `Authorization: Bearer <token>`. Token JWT, expired sesuai `JWT_EXPIRES_IN` (default 12h). Tidak ada refresh token: login ulang saat `TOKEN_EXPIRED`.

| Endpoint | Method | Body | Catatan |
|---|---|---|---|
| `/auth/register` | POST | `{ email, name, password }` | Selalu membuat user **INTERNAL** (tanpa department). PM & CLIENT dibuat via seed. Password min 8. |
| `/auth/login` | POST | `{ email, password }` | → `{ token, user }`. Email/password salah = sama-sama `UNAUTHENTICATED`. |
| `/auth/logout` | POST | — | Auth. Membuang session: token lama jadi `TOKEN_REVOKED`. |
| `/auth/me` | GET | — | Auth. → `{ id, email, name, role, department, tokenVersion }`. |

Role: `PM` | `INTERNAL` | `CLIENT`. `department` hanya ada di INTERNAL: `UIUX` | `FRONTEND` | `BACKEND`.

### Contoh

```http
POST /api/v1/auth/login
Content-Type: application/json

{ "email": "pm@nodewave.test", "password": "Pm123456!" }
```

```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOi...",
    "user": { "id": "5f0c...", "email": "pm@nodewave.test", "name": "Project Manager", "role": "PM", "department": null, "tokenVersion": 0 }
  }
}
```

---

## 3. Projects

| Endpoint | Method | Akses | Catatan |
|---|---|---|---|
| `/projects` | GET | any member | List project tempat user jadi member. Query contract §7. |
| `/projects` | POST | PM | `{ name, description? }` → 201. Pembuat otomatis jadi member. |
| `/projects/:id` | GET | member | Detail + `members[]`. |
| `/projects/:id` | PATCH | PM (member) | `{ name?, description? }`. |
| `/projects/:id` | DELETE | PM (member) | Soft delete → `{ ok: true }`. |
| `/projects/:id/members` | POST | PM (member) | `{ userId }` → 201. CLIENT cuma boleh 1 project (`BUSINESS_RULE`). |
| `/projects/:id/members/:userId` | DELETE | PM (member) | Soft delete membership. |

Non-member selalu **404** (bukan 403) — jangan tampilkan apa-apa.

---

## 4. Tasks

### Endpoint

| Endpoint | Method | Akses | Catatan |
|---|---|---|---|
| `/projects/:id/tasks` | GET | member | Query contract §7. |
| `/projects/:id/tasks` | POST | PM (member) | Create → 201 `{ id }`. |
| `/projects/:id/board` | GET | member | Kanban groups (§4.3). |
| `/tasks/:id` | GET | internal member | Detail task (shape §4.1). CLIENT **404**. |
| `/tasks/:id` | PATCH | PM (member) | Update core fields — **wajib `version`** (§5). |
| `/tasks/:id/status` | POST | sesuai state machine | `{ status, version }` — **wajib `version`** (§5). |
| `/tasks/:id` | DELETE | PM (member) | Soft delete. |
| `/tasks/:id/restore` | POST | PM (member) | Restore. |
| `/tasks/:id/dependencies` | POST | PM (member) | `{ dependsOnId }` → 201. |
| `/tasks/:id/dependencies/:dependsOnId` | DELETE | PM (member) | Lepas dependency. |
| `/projects/:projectId/tasks/:taskId/audit` | GET | PM (member) | Audit trail, paginated. |

### 4.1 Shape task (internal — PM/INTERNAL)

```jsonc
{
  "id": "9e2b...",
  "projectId": "5f0c...",
  "title": "Backend API Integration",
  "description": "...",
  "status": "IN_PROGRESS",          // stored: TODO | IN_PROGRESS | DONE
  "effectiveStatus": "IN_PROGRESS", // stored ATAU "BLOCKED" (derived)
  "isBlocked": false,
  "blockedBy": [],                  // [{ id, title, status }] prerequisite yang belum DONE
  "priority": "URGENT",             // LOW | MEDIUM | HIGH | URGENT
  "dueDate": "2026-10-03T00:00:00.000Z",
  "department": "BACKEND",          // UIUX | FRONTEND | BACKEND | null
  "assignee": { "id": "3a1b...", "name": "Rina — Backend Engineer", "department": "BACKEND" },
  "assigneeId": "3a1b...",
  "clientVisible": true,
  "clientTitle": "API Integration",
  "clientSummary": "...",
  "version": 4,                     // optimistic lock — kirim balik ini untuk update
  "createdAt": "...",
  "updatedAt": "...",
  "allowedActions": { /* 4.2 */ }
}
```

List (`GET /projects/:id/tasks`) & board memakai subset ringan dengan field `allowedActions` yang sama.

### 4.2 `allowedActions` — hint permission untuk UI

Dihitung **dengan fungsi policy yang sama** yang dipakai endpoint write, jadi tombol yang disabled selalu match keputusan server. Tetap selalu handle error dari server sebagai guard sebenarnya.

```jsonc
{
  "canStart":              { "allowed": false, "reason": "TASK_BLOCKED", "blockedBy": [ { "id": "...", "title": "UI Design: Dashboard", "status": "DONE" } ] },
  "canComplete":           { "allowed": false, "reason": "PM_CANNOT_COMPLETE" },
  "canEdit":               { "allowed": true },
  "canUpload":             { "allowed": true },
  "canManageDependencies": { "allowed": true }
}
```

Nilai `reason` yang mungkin: `INVALID_TRANSITION`, `TASK_BLOCKED` (dengan `blockedBy`), `NOT_ASSIGNEE`, `PM_CANNOT_COMPLETE`, `NOT_A_MEMBER`.

Rule inti yang perlu diingat FE:
- Hanya **assignee** yang bisa complete task (DONE) — termasuk PM dilarang complete (kalau PM assignee-nya, boleh).
- **TASK_BLOCKED**: start/reopen butuh semua prerequisite DONE. `effectiveStatus: "BLOCKED"` adalah turunan — jangan minta user pilih status BLOCKED.
- Transisi valid: `TODO→IN_PROGRESS`, `IN_PROGRESS→DONE`, reopen `IN_PROGRESS→TODO`, `DONE→IN_PROGRESS`. Lainnya = `INVALID_TRANSITION`.

### 4.3 Board

`GET /projects/:id/board` →

```jsonc
{ "data": { "TODO": [ /* task lite */ ], "IN_PROGRESS": [ /* ... */ ], "DONE": [ /* ... */ ] } }
```

Task lite punya `id, title, status, effectiveStatus, isBlocked, blockedBy, priority, department, assignee, dueDate, version, allowedActions`.

### 4.4 Create task (PM)

```jsonc
POST /projects/:id/tasks
{
  "title": "Frontend Slicing",              // required, max 200
  "description": "...",                      // optional
  "priority": "HIGH",                        // optional, default MEDIUM
  "dueDate": "2026-10-09T00:00:00.000Z",     // optional, ISO datetime / null
  "department": "FRONTEND",                  // optional
  "assigneeId": "uuid",                      // optional
  "clientVisible": true,                     // optional, default false
  "clientTitle": "...",                      // optional — teks client-safe
  "clientSummary": "...",                    // optional
  "dependencyIds": ["uuid", "uuid"]          // optional, validasi cycle/cross-project tetap jalan
}
```

PATCH `/tasks/:id` menerima field yang sama **kecuali** `dependencyIds` & `status`, plus **wajib `version`**. `dependencyIds` tidak bisa diedit via PATCH — kelola via endpoint dependencies.

---

## 5. Optimistic Locking (version → 409)

Setiap write task (`PATCH /tasks/:id`, `POST /tasks/:id/status`) **wajib** mengirim `version` = angka `version` yang terakhir dilihat client.

**Kalau data sudah diubah orang lain** → **409**:

```jsonc
{
  "success": false,
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "...",
    "details": {
      "currentVersion": 7,
      "currentTask": { "status": "IN_PROGRESS", "assigneeId": "...", "title": "..." }
    }
  }
}
```

Pola FE yang disarankan: tampilkan dialog "data berubah di server" (bukan auto-overwrite), user pilih reload (`currentVersion`) atau force-retry dengan version terbaru.

---

## 6. Attachments & Comments

### Attachments

| Endpoint | Method | Akses |
|---|---|---|
| `/tasks/:id/attachments` | POST | PM/INTERNAL member — multipart/form-data, field `file`. CLIENT 403. |
| `/tasks/:id/attachments` | GET | member (internal) |

Validasi server: whitelist mime (gambar, pdf, txt, csv, json, zip, doc/x, xls/x, ppt/x), ekstensi harus match, max `MAX_UPLOAD_SIZE_MB` (default 10MB) → error `UNSUPPORTED_MEDIA_TYPE` / `PAYLOAD_TOO_LARGE` / `VALIDATION_ERROR`.

```jsonc
// 201
{ "success": true, "data": { "id": "...", "taskId": "...", "fileName": "spec.pdf", "url": "/files/<projectId>/<taskId>/<uuid>-spec.pdf", "mimeType": "application/pdf", "size": 2418, "uploadedBy": { "id": "...", "name": "..." }, "createdAt": "..." } }
```

`url` relatif terhadap origin backend — untuk preview, prepend base URL backend (bukan `/api/v1`).

List attachments & comments memakai query contract §7 (sortable `createdAt` dll).

### Comments

| Endpoint | Method | Akses |
|---|---|---|
| `/tasks/:id/comments` | POST | PM/INTERNAL member — `{ body, isInternal? }` (default `isInternal: true`). CLIENT 403. |
| `/tasks/:id/comments` | GET | PM/INTERNAL member. CLIENT 404 (endpoint internal). |

```jsonc
{ "id": "...", "body": "...", "isInternal": true, "author": { "id": "...", "name": "..." }, "createdAt": "..." }
```

Filter: `?filterFields=isInternal&filterValues=true` (atau `false`); search: `?search=kata&searchFields=body`.

---

## 7. Query Contract (list endpoints — ezfilter)

Semua endpoint list menerima parameter berikut. **Field di luar whitelist ditolak 400** (bukan diabaikan) — FE tidak akan silent-bug.

| Param | Format | Contoh |
|---|---|---|
| `page`, `rows` | integer, `rows` max 100 | `?page=1&rows=20` |
| `orderKey` (atau `orderkey`) + `orderDir` | `asc`/`desc` | `?orderKey=createdAt&orderDir=desc` |
| `search` + `searchFields` | comma-separated whitelist | `?search=dashboard&searchFields=title` |
| `filterFields` + `filterValues` | comma-separated, pasangan sejajar | `?filterFields=status,priority&filterValues=TODO,HIGH` |
| `rangeFields` + `rangeValues` | `field:start:end`, `start`/`end` boleh kosong | `?rangeFields=dueDate&rangeValues=dueDate:2026-10-01:2026-10-31` |

- JSON malformed di `filterValues`/`search` → **400 `MALFORMED_JSON`**.
- Multi-column `searchFields` beda tipe (mis. date vs string) → **400 `SEARCH_TYPE_MISMATCH`**.
- `filterValues` isinya JSON-ish value per kolom (mis. `TODO`, `true`, `"teks"`).

Whitelist per resource:

| Resource | filterable | searchable | rangable | sortable |
|---|---|---|---|---|
| `/projects` | name, description | name, description | createdAt, updatedAt | name, createdAt, updatedAt |
| `/projects/:id/tasks` | status, priority, department, assigneeId, clientVisible, projectId | title, description | dueDate, createdAt, updatedAt | title, status, priority, dueDate, createdAt, updatedAt |
| `/tasks/:id/attachments` | mimeType | fileName | createdAt, size | fileName, size, createdAt |
| `/tasks/:id/comments` | isInternal, authorId | body | createdAt | createdAt |
| `/client/tasks` | status, dueDate | clientTitle | dueDate, updatedAt | dueDate, updatedAt, status |
| `.../audit` | column, action, userId, taskId | column, oldValue, newValue | createdAt | createdAt, column, action |

---

## 8. Error Codes

| Code | HTTP | Arti & aksi FE |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Body/query invalid. `details.issues[]` = `{ path, message }` per field. |
| `MALFORMED_JSON` | 400 | Body/query JSON rusak. |
| `SEARCH_TYPE_MISMATCH` | 400 | Search multi-kolom beda tipe. |
| `UNAUTHENTICATED` | 401 | Belum login / token invalid → redirect login. |
| `TOKEN_EXPIRED` | 401 | Token kadaluarsa → login ulang. |
| `TOKEN_REVOKED` | 401 | Session dibuang (logout) → login ulang. |
| `FORBIDDEN` | 403 | Role tidak diizinkan. |
| `FORBIDDEN_TRANSITION` | 403 | Aturan peran transisi status. `details.reason`: `NOT_ASSIGNEE`, `PM_CANNOT_COMPLETE`, `NOT_A_MEMBER`. |
| `NOT_FOUND` | 404 | Tidak ada ATAU bukan hak akses (disengaja sama — jangan dibedakan). |
| `VERSION_CONFLICT` | 409 | Optimistic lock — `details.currentVersion` + `currentTask` (§5). |
| `EMAIL_ALREADY_USED` | 409 | Register dengan email terpakai. |
| `INVALID_TRANSITION` | 422 | Transisi status tidak legal (mis. TODO→DONE). |
| `TASK_BLOCKED` | 422 | Prerequisite belum DONE. `details.blockedBy[]` = `{ id, title, status }`. |
| `DEPENDENCY_CYCLE` | 422 | `details.cycle[]` = urutan task yang membentuk siklus. |
| `SELF_DEPENDENCY` | 422 | Task depends on dirinya sendiri. |
| `CROSS_PROJECT_DEPENDENCY` | 422 | Prerequisite beda project. |
| `BUSINESS_RULE` | 422 | Mis. CLIENT join 2 project. |
| `PAYLOAD_TOO_LARGE` | 413 | File > MAX_UPLOAD_SIZE_MB. |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Tipe file tidak di-whitelist. |

---

## 9. Client View (role CLIENT)

Endpoint khusus CLIENT. Internal user yang memanggil → 403. CLIENT memanggil endpoint internal `/tasks/*` → 404.

| Endpoint | Method | Catatan |
|---|---|---|
| `/client/project` | GET | Project + metrik agregat (§ di bawah). Tenant diambil dari membership — tidak ada parameter project. |
| `/client/tasks` | GET | Task `clientVisible` saja, whitelist field. Query contract §7. |

```jsonc
// GET /client/project
{ "success": true, "data": {
  "project": { "id": "...", "name": "...", "description": "...", "createdAt": "..." },
  "metrics": { "totalTasks": 6, "doneTasks": 2, "percentComplete": 33 }
} }

// GET /client/tasks
{ "id": "...", "title": "API Integration", "status": "IN_PROGRESS", "effectiveStatus": "IN_PROGRESS", "dueDate": "...", "updatedAt": "..." }
```

Masking yang sudah dijamin server (FE tidak perlu handle): tanpa assignee, department, email, comments, attachments, audit, dependency titles. `title` = `clientTitle`; kalau PM tidak mengisi → literal `"(details pending)"`.

---

## 10. Standup (daily auto-summary)

`GET /projects/:id/standup?date=YYYY-MM-DD` — PM/INTERNAL member. CLIENT 404.

`date` opsional; default **kemarin** di timezone `Asia/Jakarta` (UTC+7, fixed offset).

```jsonc
{
  "success": true,
  "data": {
    "date": "2026-09-28",
    "project": { "id": "...", "name": "Website Revamp — PT Maju Jaya" },
    "departments": [
      {
        "department": "UIUX",
        "completedYesterday": [ { "taskId": "...", "title": "UI Design: Dashboard", "completedBy": "Project Manager", "at": "..." } ],
        "blockedToday": []
      },
      {
        "department": "FRONTEND",
        "completedYesterday": [],
        "blockedToday": [ { "taskId": "...", "title": "Frontend Slicing", "blockedBy": [ { "id": "...", "title": "Backend API Integration", "status": "IN_PROGRESS" } ] } ]
      },
      { "department": "BACKEND", "completedYesterday": [], "blockedToday": [] }
    ]
  }
}
```

- `completedYesterday` dihitung dari **audit trail** (transisi ke DONE dalam window hari tsb) — history presisi.
- `blockedToday` live: task yang saat ini punya prerequisite belum DONE. Untuk "kemarin yang lalu" anggap ini snapshot sekarang (keterbatasan didokumentasikan).

---

## 11. Misc

- `GET /health` (tanpa auth) → `{ status: "ok", service, time }` — probe koneksi DB.
- CORS: origin dari env `FRONTEND_ORIGIN` (default `http://localhost:3000`).
- `X-Request-Id` di response header tiap request — sertakan saat lapor bug.
- Semua tanggal ISO-8601 UTC (`2026-10-03T00:00:00.000Z`).
- Soft delete: task/project yang di-DELETE tidak muncul lagi di list; restore via `POST /tasks/:id/restore` (PM).

### Kredensial seed (dev)

| Role | Email | Password (default) |
|---|---|---|
| PM | `pm@nodewave.test` | `Pm123456!` |
| INTERNAL | `uiux@` / `frontend@` / `backend@nodewave.test` | `Internal123!` |
| CLIENT | `client-a@nodewave.test` (Project A), `client-b@nodewave.test` (Project B) | `Client123!` |

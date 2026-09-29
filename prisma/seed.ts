/**
 * Idempotent seed — safe to run repeatedly (`bun run db:seed`).
 *
 * Users/projects/tasks are matched by natural keys (email, name, title) and
 * upserted, so a re-run updates nothing and creates no duplicates. Audit
 * history and attachment files are only written when the row is first
 * created by this seed.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { env } from "../src/config/env";

/** Raw client (no soft-delete extension): the seed must see and write freely. */
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

const now = Date.now();
const daysAgo = (n: number) => new Date(now - n * 24 * 60 * 60 * 1000);
const daysAhead = (n: number) => new Date(now + n * 24 * 60 * 60 * 1000);

async function upsertUser(input: {
  email: string;
  name: string;
  role: "PM" | "INTERNAL" | "CLIENT";
  department?: "UIUX" | "FRONTEND" | "BACKEND";
  password: string;
}) {
  const passwordHash = await Bun.password.hash(input.password);
  const user = await prisma.user.upsert({
    where: { email: input.email },
    update: { name: input.name, role: input.role, department: input.department ?? null },
    create: {
      email: input.email,
      name: input.name,
      role: input.role,
      department: input.department,
      passwordHash,
    },
  });
  return user;
}

async function upsertProject(name: string, description: string) {
  const existing = await prisma.project.findFirst({ where: { name } });
  if (existing) return existing;
  return prisma.project.create({ data: { name, description } });
}

async function upsertMembership(projectId: string, userId: string) {
  await prisma.projectMember.upsert({
    where: { projectId_userId: { projectId, userId } },
    update: {},
    create: { projectId, userId },
  });
}

/** Creates the task only when absent; returns it plus whether it was newly seeded. */
async function upsertTask(input: {
  projectId: string;
  title: string;
  description: string;
  status: "TODO" | "IN_PROGRESS" | "DONE";
  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  dueDate: Date | null;
  department: "UIUX" | "FRONTEND" | "BACKEND" | null;
  assigneeId: string | null;
  clientVisible: boolean;
  clientTitle: string | null;
  clientSummary: string | null;
}) {
  const existing = await prisma.task.findFirst({
    where: { projectId: input.projectId, title: input.title },
  });
  if (existing) return { task: existing, created: false as const };

  const task = await prisma.task.create({
    data: {
      projectId: input.projectId,
      title: input.title,
      description: input.description,
      status: input.status,
      priority: input.priority,
      dueDate: input.dueDate,
      department: input.department,
      assigneeId: input.assigneeId,
      clientVisible: input.clientVisible,
      clientTitle: input.clientTitle,
      clientSummary: input.clientSummary,
      // createdAt is left as now(); audit rows below carry the history.
    },
  });
  return { task, created: true as const };
}

async function upsertDependency(taskId: string, dependsOnId: string) {
  await prisma.taskDependency.upsert({
    where: { taskId_dependsOnId: { taskId, dependsOnId } },
    update: {},
    create: { taskId, dependsOnId },
  });
}

/** Comment deduplicated by (task, author, body). */
async function upsertComment(input: {
  taskId: string;
  authorId: string;
  body: string;
  isInternal: boolean;
  createdAt: Date;
}) {
  const existing = await prisma.comment.findFirst({
    where: { taskId: input.taskId, authorId: input.authorId, body: input.body },
  });
  if (existing) return existing;
  return prisma.comment.create({ data: input });
}

/** Attachment metadata + a small local file, deduplicated by (task, fileName). */
async function upsertAttachment(input: {
  taskId: string;
  projectId: string;
  uploadedById: string;
  fileName: string;
  mimeType: string;
  content: string;
  createdAt: Date;
}) {
  const existing = await prisma.attachment.findFirst({
    where: { taskId: input.taskId, fileName: input.fileName },
  });
  if (existing) return existing;

  const { LocalStorage } = await import("../src/lib/storage");
  const storage = new LocalStorage(env.STORAGE_LOCAL_DIR);
  const key = `${input.projectId}/${input.taskId}/seed-${input.fileName}`;
  await storage.save(key, Buffer.from(input.content), input.mimeType);

  return prisma.attachment.create({
    data: {
      taskId: input.taskId,
      uploadedById: input.uploadedById,
      fileName: input.fileName,
      url: `/files/${key}`,
      mimeType: input.mimeType,
      size: Buffer.byteLength(input.content),
      createdAt: input.createdAt,
    },
  });
}

/** Audit rows are only written when the task is first seeded by this script. */
async function seedAuditHistory(
  taskId: string,
  projectId: string,
  userId: string,
  rows: Array<{
    column: string;
    oldValue: string | null;
    newValue: string | null;
    action: "CREATE" | "UPDATE" | "DELETE";
    createdAt: Date;
  }>,
) {
  const marker = await prisma.taskAuditLog.findFirst({
    where: { taskId, action: "CREATE", column: "title" },
  });
  if (marker) return;
  await prisma.taskAuditLog.createMany({
    data: rows.map((r) => ({ taskId, projectId, userId, ...r })),
  });
}

async function main() {
  console.log("🌱 Seeding deliverables database...");

  // ---- Users -------------------------------------------------------------
  const pm = await upsertUser({
    email: "pm@nodewave.test",
    name: "Project Manager",
    role: "PM",
    password: env.SEED_PM_PASSWORD,
  });
  const uiux = await upsertUser({
    email: "uiux@nodewave.test",
    name: "Sari — UI/UX Designer",
    role: "INTERNAL",
    department: "UIUX",
    password: env.SEED_INTERNAL_PASSWORD,
  });
  const frontend = await upsertUser({
    email: "frontend@nodewave.test",
    name: "Budi — Frontend Engineer",
    role: "INTERNAL",
    department: "FRONTEND",
    password: env.SEED_INTERNAL_PASSWORD,
  });
  const backend = await upsertUser({
    email: "backend@nodewave.test",
    name: "Rina — Backend Engineer",
    role: "INTERNAL",
    department: "BACKEND",
    password: env.SEED_INTERNAL_PASSWORD,
  });
  const clientA = await upsertUser({
    email: "client-a@nodewave.test",
    name: "Client A — Maju Jaya",
    role: "CLIENT",
    password: env.SEED_CLIENT_PASSWORD,
  });
  const clientB = await upsertUser({
    email: "client-b@nodewave.test",
    name: "Client B — Sejahtera",
    role: "CLIENT",
    password: env.SEED_CLIENT_PASSWORD,
  });

  // ---- Project A (main demo project) --------------------------------------
  const projectA = await upsertProject(
    "Website Revamp — PT Maju Jaya",
    "Redesign dan implementasi ulang website company profile + dashboard internal.",
  );
  await upsertMembership(projectA.id, pm.id);
  await upsertMembership(projectA.id, uiux.id);
  await upsertMembership(projectA.id, frontend.id);
  await upsertMembership(projectA.id, backend.id);
  await upsertMembership(projectA.id, clientA.id);

  const task1 = await upsertTask({
    projectId: projectA.id,
    title: "UI Design: Dashboard",
    description: "Desain dashboard internal: layout, komponen, dan style guide.",
    status: "DONE",
    priority: "HIGH",
    dueDate: daysAgo(2),
    department: "UIUX",
    assigneeId: uiux.id,
    clientVisible: true,
    clientTitle: "Dashboard Design",
    clientSummary: "Final dashboard design delivered and approved.",
  });
  const task2 = await upsertTask({
    projectId: projectA.id,
    title: "Backend API Integration",
    description: "Integrasi endpoint deliverables + auth ke dashboard.",
    status: "IN_PROGRESS",
    priority: "URGENT",
    dueDate: daysAhead(4),
    department: "BACKEND",
    assigneeId: backend.id,
    clientVisible: true,
    clientTitle: "API Integration",
    clientSummary: "Connecting the dashboard to backend services.",
  });
  const task3 = await upsertTask({
    projectId: projectA.id,
    title: "Frontend Slicing",
    description: "Slicing desain dashboard menjadi komponen frontend.",
    status: "TODO",
    priority: "HIGH",
    dueDate: daysAhead(10),
    department: "FRONTEND",
    assigneeId: frontend.id,
    clientVisible: true,
    clientTitle: "Dashboard Implementation",
    clientSummary: "Building the dashboard pages from the approved design.",
  });
  const task4 = await upsertTask({
    projectId: projectA.id,
    title: "Assets Cleanup",
    description: "Rapikan aset desain lama sebelum handoff.",
    status: "IN_PROGRESS",
    priority: "LOW",
    dueDate: null,
    department: "UIUX",
    assigneeId: uiux.id,
    clientVisible: false,
    clientTitle: null,
    clientSummary: null,
  });

  // Task3 depends on Task1 & Task2 -> derived status BLOCKED (task2 belum DONE).
  await upsertDependency(task3.task.id, task1.task.id);
  await upsertDependency(task3.task.id, task2.task.id);

  if (task1.created) {
    await seedAuditHistory(task1.task.id, projectA.id, pm.id, [
      {
        column: "title",
        oldValue: null,
        newValue: task1.task.title,
        action: "CREATE",
        createdAt: daysAgo(12),
      },
      {
        column: "status",
        oldValue: null,
        newValue: "TODO",
        action: "CREATE",
        createdAt: daysAgo(12),
      },
      {
        column: "status",
        oldValue: "TODO",
        newValue: "IN_PROGRESS",
        action: "UPDATE",
        createdAt: daysAgo(9),
      },
      {
        column: "status",
        oldValue: "IN_PROGRESS",
        newValue: "DONE",
        action: "UPDATE",
        createdAt: daysAgo(2),
      },
    ]);
  }
  if (task2.created) {
    await seedAuditHistory(task2.task.id, projectA.id, pm.id, [
      {
        column: "title",
        oldValue: null,
        newValue: task2.task.title,
        action: "CREATE",
        createdAt: daysAgo(11),
      },
      {
        column: "status",
        oldValue: null,
        newValue: "TODO",
        action: "CREATE",
        createdAt: daysAgo(11),
      },
      {
        column: "status",
        oldValue: "TODO",
        newValue: "IN_PROGRESS",
        action: "UPDATE",
        createdAt: daysAgo(5),
      },
    ]);
  }
  if (task3.created) {
    await seedAuditHistory(task3.task.id, projectA.id, pm.id, [
      {
        column: "title",
        oldValue: null,
        newValue: task3.task.title,
        action: "CREATE",
        createdAt: daysAgo(10),
      },
      {
        column: "status",
        oldValue: null,
        newValue: "TODO",
        action: "CREATE",
        createdAt: daysAgo(10),
      },
      {
        column: "dependencies",
        oldValue: null,
        newValue: task1.task.title,
        action: "UPDATE",
        createdAt: daysAgo(10),
      },
      {
        column: "dependencies",
        oldValue: null,
        newValue: task2.task.title,
        action: "UPDATE",
        createdAt: daysAgo(10),
      },
    ]);
  }
  if (task4.created) {
    await seedAuditHistory(task4.task.id, projectA.id, pm.id, [
      {
        column: "title",
        oldValue: null,
        newValue: task4.task.title,
        action: "CREATE",
        createdAt: daysAgo(6),
      },
      {
        column: "status",
        oldValue: null,
        newValue: "TODO",
        action: "CREATE",
        createdAt: daysAgo(6),
      },
      {
        column: "status",
        oldValue: "TODO",
        newValue: "IN_PROGRESS",
        action: "UPDATE",
        createdAt: daysAgo(3),
      },
    ]);
  }

  // ---- Comments (mostly internal, one client-visible) ----------------------
  await upsertComment({
    taskId: task2.task.id,
    authorId: backend.id,
    body: "Auth endpoint sudah selesai, tinggal endpoint deliverables.",
    isInternal: true,
    createdAt: daysAgo(4),
  });
  await upsertComment({
    taskId: task2.task.id,
    authorId: pm.id,
    body: "Silakan, endpoint deliverables sudah stable di staging.",
    isInternal: true,
    createdAt: daysAgo(3),
  });
  await upsertComment({
    taskId: task1.task.id,
    authorId: pm.id,
    body: "Desain dashboard sudah disetujui klien, terima kasih!",
    isInternal: false,
    createdAt: daysAgo(1),
  });

  // ---- Attachment metadata (small local files) -----------------------------
  await upsertAttachment({
    taskId: task1.task.id,
    projectId: projectA.id,
    uploadedById: uiux.id,
    fileName: "dashboard-spec.txt",
    mimeType: "text/plain",
    content: "Dashboard design spec — spacing 8px grid, color tokens v2.\n",
    createdAt: daysAgo(11),
  });
  await upsertAttachment({
    taskId: task2.task.id,
    projectId: projectA.id,
    uploadedById: backend.id,
    fileName: "api-notes.txt",
    mimeType: "text/plain",
    content: "API integration notes — base URL, auth flow, error envelope.\n",
    createdAt: daysAgo(5),
  });

  // ---- Project B (tenant isolation demo) -----------------------------------
  const projectB = await upsertProject(
    "Mobile App — PT Sejahtera",
    "Aplikasi mobile loyalty untuk PT Sejahtera (untuk demo isolasi antar tenant).",
  );
  await upsertMembership(projectB.id, pm.id);
  await upsertMembership(projectB.id, frontend.id);
  await upsertMembership(projectB.id, clientB.id);

  const taskB1 = await upsertTask({
    projectId: projectB.id,
    title: "Splash Screen Design",
    description: "Desain splash screen + onboarding.",
    status: "DONE",
    priority: "MEDIUM",
    dueDate: daysAgo(1),
    department: "UIUX",
    assigneeId: null,
    clientVisible: true,
    clientTitle: "Splash Screen",
    clientSummary: "Splash screen design approved.",
  });
  const taskB2 = await upsertTask({
    projectId: projectB.id,
    title: "Auth API",
    description: "Endpoint login/register untuk aplikasi mobile.",
    status: "TODO",
    priority: "HIGH",
    dueDate: daysAhead(7),
    department: "BACKEND",
    assigneeId: null,
    clientVisible: false,
    clientTitle: null,
    clientSummary: null,
  });

  if (taskB1.created) {
    await seedAuditHistory(taskB1.task.id, projectB.id, pm.id, [
      {
        column: "title",
        oldValue: null,
        newValue: taskB1.task.title,
        action: "CREATE",
        createdAt: daysAgo(7),
      },
      {
        column: "status",
        oldValue: null,
        newValue: "TODO",
        action: "CREATE",
        createdAt: daysAgo(7),
      },
      {
        column: "status",
        oldValue: "TODO",
        newValue: "IN_PROGRESS",
        action: "UPDATE",
        createdAt: daysAgo(5),
      },
      {
        column: "status",
        oldValue: "IN_PROGRESS",
        newValue: "DONE",
        action: "UPDATE",
        createdAt: daysAgo(1),
      },
    ]);
  }
  if (taskB2.created) {
    await seedAuditHistory(taskB2.task.id, projectB.id, pm.id, [
      {
        column: "title",
        oldValue: null,
        newValue: taskB2.task.title,
        action: "CREATE",
        createdAt: daysAgo(6),
      },
      {
        column: "status",
        oldValue: null,
        newValue: "TODO",
        action: "CREATE",
        createdAt: daysAgo(6),
      },
    ]);
  }

  console.log("✅ Seed selesai (idempotent). Akun:");
  console.log(`   PM       : pm@nodewave.test        / ${env.SEED_PM_PASSWORD}`);
  console.log(`   INTERNAL : uiux@nodewave.test      / ${env.SEED_INTERNAL_PASSWORD}`);
  console.log(`              frontend@nodewave.test  / ${env.SEED_INTERNAL_PASSWORD}`);
  console.log(`              backend@nodewave.test   / ${env.SEED_INTERNAL_PASSWORD}`);
  console.log(`   CLIENT   : client-a@nodewave.test  / ${env.SEED_CLIENT_PASSWORD}  (Project A)`);
  console.log(`              client-b@nodewave.test  / ${env.SEED_CLIENT_PASSWORD}  (Project B)`);
}

main()
  .catch((e) => {
    console.error("❌ Seed gagal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

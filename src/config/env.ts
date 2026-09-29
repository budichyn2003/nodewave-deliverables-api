import { z } from "zod";

/**
 * Zod-validated environment. The app refuses to boot with a malformed env
 * (fail fast) instead of misbehaving later at request time.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_URL_TEST: z.string().optional(),

  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 chars"),
  JWT_EXPIRES_IN: z.string().default("12h"),

  // Comma-separated list of allowed CORS origins.
  FRONTEND_ORIGIN: z.string().default("http://localhost:3000"),

  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Seed credentials (defaults documented in README — override in production).
  SEED_PM_PASSWORD: z.string().default("Pm123456!"),
  SEED_INTERNAL_PASSWORD: z.string().default("Internal123!"),
  SEED_CLIENT_PASSWORD: z.string().default("Client123!"),

  // Storage
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default("./uploads"),
  MAX_UPLOAD_SIZE_MB: z.coerce.number().int().positive().default(10),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("❌ Invalid environment variables:");
  for (const issue of parsed.error.issues) {
    // eslint-disable-next-line no-console
    console.error(`   ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

const data = parsed.data;

export const env = {
  ...data,
  FRONTEND_ORIGINS: data.FRONTEND_ORIGIN.split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  IS_TEST: data.NODE_ENV === "test",
  IS_PROD: data.NODE_ENV === "production",
};

export type Env = typeof env;

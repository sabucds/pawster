import { defineConfig } from "drizzle-kit";

/**
 * `drizzle-kit generate` writes SQL here; `wrangler d1 migrations apply` reads it, and so
 * does `readD1Migrations` in the test seams. The two interoperate through the directory
 * layout alone, which is why `migrations_dir` in each Worker's Wrangler config points at
 * this same folder.
 */
export default defineConfig({
  dialect: "sqlite",
  driver: "d1-http",
  schema: "./src/schema.ts",
  out: "./migrations",
});

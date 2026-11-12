import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db.ts",
  out: "./migrations",
  casing: "snake_case",
});

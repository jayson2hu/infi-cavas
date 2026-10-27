import { migrateDatabase } from "./db/migrate";
import { seedDatabase } from "./db/seed";
import { ensureBucket } from "./lib/s3";

export async function bootstrap() {
  await migrateDatabase();
  await seedDatabase();
  await ensureBucket();
}

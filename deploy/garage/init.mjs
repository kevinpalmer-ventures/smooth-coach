// Container entry point for garage-init: reads settings from the environment and runs setup.
import { missingSetupVariables, runSetup } from "./setup.mjs";

const missing = missingSetupVariables(process.env);
if (missing.length) {
  console.error(`garage-init: missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

try {
  await runSetup({
    adminUrl: process.env.GARAGE_ADMIN_URL || "http://garage:3903",
    adminToken: process.env.GARAGE_ADMIN_TOKEN,
    bucket: process.env.S3_BUCKET,
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    capacity: process.env.GARAGE_CAPACITY || "10G"
  });
} catch (error) {
  console.error(`garage-init: ${error.message}`);
  process.exit(1);
}

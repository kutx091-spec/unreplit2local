import app from "./app";
import { logger } from "./lib/logger";
import { cleanupOrphanedTempFiles } from "./lib/convert/temp-files";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Prevent unhandled rejections from silently crashing the process.
// Log them so they are visible in server logs, then continue running.
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection — process kept alive");
});

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception — process kept alive");
});

const cleanup = cleanupOrphanedTempFiles();
logger.info(cleanup, "Cleaned temporary conversion files from previous process");

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

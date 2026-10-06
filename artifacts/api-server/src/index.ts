import app from "./app";
import { logger } from "./lib/logger";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

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

const chatBackendPort = Number(process.env.CHAT_BACKEND_PORT ?? 8000);
if (Number.isNaN(chatBackendPort) || chatBackendPort <= 0) {
  throw new Error("CHAT_BACKEND_PORT must be a valid port number.");
}

const chatBackendCandidates = [
  path.resolve(process.cwd(), "src/flask_backend/app.py"),
  path.resolve(process.cwd(), "artifacts/api-server/src/flask_backend/app.py"),
];
const chatBackendPath = chatBackendCandidates.find((candidate) =>
  existsSync(candidate),
);
if (!chatBackendPath) {
  throw new Error("Could not find the Flask chat API entry point.");
}

const chatBackend = spawn(
  process.env.PYTHON ?? "python",
  [
    "-m",
    "gunicorn",
    "--bind",
    `127.0.0.1:${chatBackendPort}`,
    "--workers",
    "2",
    "--threads",
    "4",
    "--access-logfile",
    "-",
    "--error-logfile",
    "-",
    "app:app",
  ],
  {
    cwd: path.dirname(chatBackendPath),
    env: {
      ...process.env,
      CHAT_BACKEND_PORT: String(chatBackendPort),
    },
    stdio: "inherit",
  },
);

let shuttingDown = false;
chatBackend.on("error", (err) => {
  logger.error({ err }, "Could not start the Flask chat API");
  process.exit(1);
});
chatBackend.on("exit", (code, signal) => {
  if (shuttingDown) return;
  logger.error(
    { code, signal },
    "The Flask chat API stopped unexpectedly",
  );
  process.exit(1);
});

async function waitForChatBackend(): Promise<void> {
  const healthUrl = `http://127.0.0.1:${chatBackendPort}/healthz`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        logger.info({ port: chatBackendPort }, "Flask chat API is ready");
        return;
      }
    } catch {
      // The Python process can take a moment to import Flask and bind its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  chatBackend.kill("SIGTERM");
  throw new Error("The Flask chat API did not become ready in time.");
}

const server = await waitForChatBackend().then(
  () =>
    new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
      const httpServer = app.listen(port, () => {
        logger.info({ port }, "Server listening");
        resolve(httpServer);
      });
      httpServer.on("error", reject);
    }),
);

function shutdown(signal: NodeJS.Signals): void {
  shuttingDown = true;
  logger.info({ signal }, "Stopping API services");
  chatBackend.kill(signal);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

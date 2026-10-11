/**
 * Runs the example server.
 *
 *   STORAGE=sqlite  npx tsx server.ts        # a file database (SQLITE_FILE, default ./data/example.db)
 *   STORAGE=mongodb npx tsx server.ts        # MONGODB_URL, or an in-memory MongoDB when it is not set
 *   PORT=0 prints the port it got; the URL of the API is the last line of the banner.
 */

import { createExampleServer, optionsFromEnv } from "./app.js";

const options = optionsFromEnv();
const app = await createExampleServer(options);
const port = Number(process.env.PORT ?? 4310);
const { url } = await app.listen(Number.isFinite(port) ? port : 4310, process.env.HOST ?? "127.0.0.1");

console.log(`agent-server example: storage ${options.storage ?? "sqlite"}, agents ${(await app.server.getAgentsFor()).map((a) => a.id).join(", ")}`);
console.log(`docs:  ${url}/docs`);
console.log(`api:   ${url}`);

const stop = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

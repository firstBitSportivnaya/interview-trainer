import { join } from "node:path";

import { openTrainer } from "./trainer.ts";
import { startWeb } from "./web.ts";

/** Каталог владельца. Он в .gitignore, вместе с секретами ключей. */
const ownerDirectory = join(process.cwd(), "data");

const server = await startWeb(openTrainer(ownerDirectory), 4173);
const address = server.address();
if (address && typeof address === "object") {
  console.log(`http://${address.address}:${address.port}`);
}

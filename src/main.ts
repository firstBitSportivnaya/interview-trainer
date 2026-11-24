import { join } from "node:path";

import { liveEncoder, localEmbeddings } from "./embeddings.ts";
import { liveModel } from "./model.ts";
import { openTrainer } from "./trainer.ts";
import { startWeb } from "./web.ts";

/** Каталог владельца. Он в .gitignore, вместе с секретами ключей. */
const ownerDirectory = join(process.cwd(), "data");

/** Веса multilingual-e5-small лежат на установке. Пока каталога нет, ход идёт без фрагмента и сеть не зовётся. */
const embeddings = localEmbeddings(liveEncoder(join(ownerDirectory, "models", "multilingual-e5-small")));

const server = await startWeb(openTrainer(ownerDirectory, liveModel(), embeddings), 4173);
const address = server.address();
if (address && typeof address === "object") {
  console.log(`http://${address.address}:${address.port}`);
}

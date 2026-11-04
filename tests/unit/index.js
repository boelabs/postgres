import { setTimeout as sleep } from "node:timers/promises";

import { t } from "../test.js";

t.ready = Promise.all(
  ["protocol", "socket", "types", "build", "errors", "pool", "options"].map(
    async (area) => {
      try {
        return await import(`./${area}.js`);
      } catch (error) {
        return t(`${area} loads`, () => {
          throw error;
        });
      }
    }
  )
).then(() => sleep(0));

import assert from "node:assert/strict";
import { test } from "node:test";
import { withoutPictures } from "./words.ts";

test("pictures in a quoted comment are counted where they stood, and their addresses kept in order (RSVA-652)", () => {
  assert.deepEqual(withoutPictures("See the header\n\n![image](/files/acme/aa)\n\n![shot](/files/acme/bb \"After\")\n\nand the footer ![](https://x.test/c.png) too"), {
    text: "See the header\n\n[2 images]\n\nand the footer [image] too",
    pictures: ["/files/acme/aa", "/files/acme/bb", "https://x.test/c.png"],
  });
  assert.deepEqual(withoutPictures(")\n\n![image](/files/acme/aa)"), { text: ")\n\n[image]", pictures: ["/files/acme/aa"] });
  assert.deepEqual(withoutPictures("A [link](https://x.test) and `code`"), { text: "A [link](https://x.test) and `code`", pictures: [] });
});

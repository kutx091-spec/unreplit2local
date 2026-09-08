import assert from "node:assert/strict";
import { test } from "node:test";
import { convertUnixEnvAssignmentsToBat } from "./convert/generate-output.js";

test("converts an exported Unix environment assignment to batch syntax", () => {
  assert.equal(
    convertUnixEnvAssignmentsToBat(
      "export NODE_ENV=development && pnpm run build && pnpm run start",
    ),
    "set NODE_ENV=development && pnpm run build && pnpm run start",
  );
});
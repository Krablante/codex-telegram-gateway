import test from "node:test";
import assert from "node:assert/strict";

import { parseJsonObjectResponse } from "../src/zoo/model-response.js";

test("parseJsonObjectResponse accepts raw JSON and fenced JSON", () => {
  assert.deepEqual(parseJsonObjectResponse('{"ok":true,"value":1}'), {
    ok: true,
    value: 1,
  });

  assert.deepEqual(
    parseJsonObjectResponse("```json\n{\n  \"ok\": true,\n  \"value\": 2\n}\n```"),
    {
      ok: true,
      value: 2,
    },
  );
});

test("parseJsonObjectResponse rejects replies without an object", () => {
  assert.throws(
    () => parseJsonObjectResponse("no json here"),
    /JSON object/u,
  );
});

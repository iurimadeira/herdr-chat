import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenMatches } from "../../host/peer.ts";

test("token: an empty or missing expected token matches nothing, not even an empty one", () => {
  assert.equal(tokenMatches("", ""), false);
  assert.equal(tokenMatches("x", ""), false);
  assert.equal(tokenMatches(undefined, ""), false);
  assert.equal(tokenMatches("abc", "abc"), true);
  assert.equal(tokenMatches("abd", "abc"), false);
});

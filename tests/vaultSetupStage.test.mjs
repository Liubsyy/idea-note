import assert from "node:assert/strict";
import test from "node:test";

import { vaultSetupStage } from "../src/lib/crypto/setupStage.ts";

test("keeps a newly generated recovery code visible after initialization refreshes", () => {
  assert.equal(vaultSetupStage(true, "ABCDEF-GHIJKL-MNOPQR-STUVWX"), "recovery");
});

test("selects the ordinary vault views when there is no pending recovery code", () => {
  assert.equal(vaultSetupStage(null, null), "loading");
  assert.equal(vaultSetupStage(false, null), "setup");
  assert.equal(vaultSetupStage(true, null), "ready");
});

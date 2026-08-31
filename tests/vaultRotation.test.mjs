import assert from "node:assert/strict";
import test from "node:test";

import { vaultRotationBlockReason } from "../src/lib/crypto/rotation.ts";

test("allows MK rotation only when every editor-owned buffer is clean", () => {
  assert.equal(
    vaultRotationBlockReason({
      isDirty: false,
      saving: false,
      pendingSecretEdits: false,
    }),
    null,
  );
  assert.match(
    vaultRotationBlockReason({
      isDirty: true,
      saving: false,
      pendingSecretEdits: false,
    }),
    /未保存/,
  );
  assert.match(
    vaultRotationBlockReason({
      isDirty: false,
      saving: false,
      pendingSecretEdits: true,
    }),
    /加密块草稿/,
  );
  assert.match(
    vaultRotationBlockReason({
      isDirty: false,
      saving: true,
      pendingSecretEdits: false,
    }),
    /保存中/,
  );
});

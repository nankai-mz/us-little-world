// Exercises the installed official SDK wrapper over an isolated transport double.
// No request is sent to Tencent; the driver is replaced before any database call.
const assert = require("node:assert/strict");
const cloud = require("../cloudfunctions/usApi/node_modules/wx-server-sdk");
const sdkPackage = require("../cloudfunctions/usApi/node_modules/wx-server-sdk/package.json");

function driver(tables = {}, transaction = false) {
  function collection(name) {
    const state = { where: {}, offset: 0, limit: 100 };
    const query = {
      where(value) {
        state.where = value;
        return query;
      },
      orderBy() {
        return query;
      },
      skip(value) {
        state.offset = value;
        return query;
      },
      limit(value) {
        state.limit = value;
        return query;
      },
      async get() {
        return {
          data: Object.values(tables[name] || {})
            .filter((row) =>
              Object.entries(state.where).every(
                ([key, value]) => row[key] === value,
              ),
            )
            .sort((a, b) => a._id.localeCompare(b._id))
            .slice(state.offset, state.offset + state.limit),
        };
      },
      doc(id) {
        return {
          async get() {
            const row = tables[name]?.[id] || null;
            return { data: transaction ? row : row ? [row] : [] };
          },
          async set(value) {
            (tables[name] ||= {})[id] = { ...structuredClone(value), _id: id };
            return { updated: 1, upsertedId: id };
          },
          async remove() {
            delete tables[name]?.[id];
            return { deleted: 1 };
          },
        };
      },
    };
    return query;
  }
  return {
    collection,
    async runTransaction(callback) {
      const staged = structuredClone(tables);
      const result = await callback(driver(staged, true));
      for (const key of Object.keys(tables)) delete tables[key];
      Object.assign(tables, staged);
      return result;
    },
  };
}

(async () => {
  cloud.init({ env: "us-offline-contract", throwOnNotFound: false });
  const db = cloud.database({ throwOnNotFound: false });
  for (const key of [
    "getWXContext",
    "uploadFile",
    "downloadFile",
    "deleteFile",
  ])
    assert.equal(typeof cloud[key], "function");
  const tables = {};
  db._db = driver(tables);
  assert.equal((await db.collection("records").doc("absent").get()).data, null);
  await db
    .collection("records")
    .doc("a")
    .set({ data: { id: "a", spaceId: "space-a", revision: 1 } });
  assert.equal(
    (await db.collection("records").doc("a").get()).data.revision,
    1,
  );
  await db.runTransaction(async (tx) => {
    const current = (await tx.collection("records").doc("a").get()).data;
    assert.equal(current.id, "a");
    await tx
      .collection("records")
      .doc("a")
      .set({ data: { ...current, revision: 2 } });
  });
  assert.equal(
    (await db.collection("records").doc("a").get()).data.revision,
    2,
  );
  await assert.rejects(
    db.runTransaction(async (tx) => {
      await tx
        .collection("records")
        .doc("a")
        .set({ data: { id: "a", revision: 99 } });
      throw new Error("rollback fixture");
    }),
  );
  assert.equal(
    (await db.collection("records").doc("a").get()).data.revision,
    2,
  );
  const result = await db
    .collection("records")
    .where({ spaceId: "space-a" })
    .orderBy("_id", "asc")
    .skip(0)
    .limit(100)
    .get();
  assert.equal(result.data.length, 1);
  await db.collection("records").doc("a").remove();
  assert.equal((await db.collection("records").doc("a").get()).data, null);
  process.stdout.write(
    JSON.stringify({
      success: true,
      sdkVersion: sdkPackage.version,
      checks: [
        "public exports",
        "not-found handling",
        "document round trip",
        "transaction result",
        "transaction rollback",
        "query pagination",
        "delete",
      ],
      network: "not used",
      limitation:
        "SDK wrapper contract only; real CloudBase and devices remain unverified",
    }) + "\n",
  );
  process.exit(0);
})().catch(() => {
  process.stderr.write(
    "Cloud SDK contract failed; no live cloud request was made.\n",
  );
  process.exit(1);
});

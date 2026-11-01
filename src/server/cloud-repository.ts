import type { Repository, Tx } from "./api";

export function cloudRepository(db: any): Repository {
  function adapter(client: any): Tx {
    return {
      async get(collection, id) {
        try {
          const response = await client.collection(collection).doc(id).get();
          const data = Array.isArray(response.data)
            ? response.data[0]
            : response.data;
          if (!data) return null;
          const { _id, ...value } = data;
          return value;
        } catch (error: any) {
          if (
            (error.errCode === -1 &&
              /not exist|不存在|not found/i.test(
                error.errMsg || error.message || "",
              )) ||
            /DOCUMENT_NOT_EXIST|DATABASE_DOCUMENT_NOT_EXIST/.test(
              String(error.code),
            )
          )
            return null;
          throw error;
        }
      },
      async put(collection, id, data) {
        await client.collection(collection).doc(id).set({ data });
      },
      async remove(collection, id) {
        await client.collection(collection).doc(id).remove();
      },
    };
  }
  return {
    ...adapter(db),
    transaction: (fn) => db.runTransaction((tx: any) => fn(adapter(tx))),
    async list(collection, where, offset, limit) {
      const response = await db
        .collection(collection)
        .where(where)
        .orderBy("_id", "asc")
        .skip(offset)
        .limit(limit)
        .get();
      return response.data.map(({ _id, ...value }: any) => value);
    },
  };
}

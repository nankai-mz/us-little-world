import type { Repository, Tx } from "./api";

export function cloudRepository(db: any, prefix = ""): Repository {
  const collectionRef = (client: any, name: string) =>
    client.collection(prefix + name);
  function adapter(client: any): Tx {
    return {
      async get(collection, id) {
        try {
          const response = await collectionRef(client, collection).doc(id).get();
          const data = Array.isArray(response.data)
            ? response.data[0]
            : response.data;
          if (!data) return null;
          const { _id, ...value } = data;
          return value;
        } catch (error: any) {
          const message = error.errMsg || error.message || "";
          const code = String(error.code ?? error.errCode ?? "");
          if (
            ((error.errCode === -1 || code === "-501001" || error.errCode === -501001) &&
              /not exist|不存在|not found/i.test(message)) ||
            /DOCUMENT_NOT_EXIST|DATABASE_DOCUMENT_NOT_EXIST/.test(code)
          )
            return null;
          throw error;
        }
      },
      async put(collection, id, data) {
        await collectionRef(client, collection).doc(id).set({ data });
      },
      async remove(collection, id) {
        await collectionRef(client, collection).doc(id).remove();
      },
    };
  }
  return {
    ...adapter(db),
    transaction: (fn) => db.runTransaction((tx: any) => fn(adapter(tx))),
    async list(collection, where, offset, limit) {
      const response = await collectionRef(db, collection)
        .where(where)
        .orderBy("_id", "asc")
        .skip(offset)
        .limit(limit)
        .get();
      return response.data.map(({ _id, ...value }: any) => ({
        ...value,
        id: value.id || _id,
      }));
    },
  };
}

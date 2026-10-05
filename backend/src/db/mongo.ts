import { MongoClient, type Db } from 'mongodb';

export interface Mongo {
  client: MongoClient;
  db: Db;
}

export async function connectMongo(url: string, dbName: string): Promise<Mongo> {
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 5_000 });
  await client.connect();
  return { client, db: client.db(dbName) };
}

export async function pingMongo(db: Db): Promise<void> {
  await db.command({ ping: 1 });
}

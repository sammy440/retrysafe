import { drizzle } from "drizzle-orm/node-postgres";
import knexFactory from "knex";
import mongoose from "mongoose";

export const db = drizzle(process.env.DATABASE_URL!);
export const knex = knexFactory({ client: "pg" });
export const Order = mongoose.model("Order", new mongoose.Schema({}));
export const ProcessedEvent = mongoose.model("ProcessedEvent", new mongoose.Schema({ _id: String }));
export const orders = {} as any;
export const processedEvents = {} as any;

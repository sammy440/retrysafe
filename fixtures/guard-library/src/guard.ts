import { Pool } from "pg";
import Redis from "ioredis";
import { PrismaClient } from "@prisma/client";
import { postgresGuard, prismaGuard, redisGuard } from "@retrysafe/guard";

export const pool = new Pool();
export const prisma = new PrismaClient();
export const dbGuard = postgresGuard(pool);
export const txGuard = prismaGuard(prisma);
export const leaseGuard = redisGuard(new Redis(), { ttlSeconds: 7 * 24 * 3600 });

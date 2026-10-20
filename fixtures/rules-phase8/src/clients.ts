import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";
import Redis from "ioredis";

export const prisma = new PrismaClient();
export const stripe = new Stripe("sk");
export const redis = new Redis();

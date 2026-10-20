import aws from "../../catalog/aws.json";
import email from "../../catalog/email.json";
import flutterwave from "../../catalog/flutterwave.json";
import github from "../../catalog/github.json";
import http from "../../catalog/http.json";
import messaging from "../../catalog/messaging.json";
import paystack from "../../catalog/paystack.json";
import prisma from "../../catalog/prisma.json";
import providers from "../../catalog/providers.json";
import queues from "../../catalog/queues.json";
import redis from "../../catalog/redis.json";
import shopify from "../../catalog/shopify.json";
import sql from "../../catalog/sql.json";
import stripe from "../../catalog/stripe.json";
import type { EffectKind, KeySpec } from "../types";

/**
 * How to decide idempotency beyond a fixed value:
 * - "prisma-write": inspect `data` for increment/decrement/push, `skipDuplicates`
 * - "sql": inspect the SQL text (INSERT without ON CONFLICT, `x = x + 1`, ...)
 * - "graphql": mutation vs query, and Shopify's @idempotent directive
 * - "http": method, URL host (providers.json), and idempotency headers or body keys
 * - "dynamo": conditional puts and relative update expressions
 */
export type Classifier = "prisma-write" | "sql" | "graphql" | "http" | "dynamo";

export interface EffectCatalogEntry {
  match: {
    module: string | string[];
    /** Dot-separated member chain matched against the end of the call's chain. `*` matches one segment; `()` matches calling the module itself. */
    callee: string;
  };
  kind: EffectKind;
  idempotent: boolean | "unknown";
  acceptsKey?: KeySpec;
  classify?: Classifier;
  /** Documentation backing the idempotency/key facts. */
  source?: string;
}

export interface VerifyCatalogEntry {
  match: { module: string | string[]; callee: string };
  provider?: string;
}

/** One provider or library pack, as stored in catalog/*.json. */
export interface Pack {
  pack: string;
  source: string;
  notes?: string;
  effects: EffectCatalogEntry[];
  verify: VerifyCatalogEntry[];
}

export interface AwsCommandFact {
  kind: EffectKind;
  idempotent: boolean | "unknown";
  acceptsKey?: { field: string };
  classify?: Classifier;
  note?: string;
}

export interface ProviderFact {
  name: string;
  retryWindowHours?: number;
  source?: string;
  notes?: string;
  dedupeKey?: string;
}

export interface HostFact {
  kind: EffectKind;
  idempotencyHeader?: string;
  bodyKey?: string;
}

export const PACKS = [stripe, paystack, flutterwave, prisma, sql, redis, email, messaging, queues, github, shopify, http] as Pack[];

export const EFFECT_CATALOG: EffectCatalogEntry[] = PACKS.flatMap((p) => p.effects.map((e) => ({ source: p.source, ...e })));
export const VERIFY_CATALOG: VerifyCatalogEntry[] = PACKS.flatMap((p) => p.verify);
export const AWS_COMMANDS = aws.commands as Record<string, AwsCommandFact>;

const { hosts, ...providerFacts } = providers;
export const PROVIDERS = providerFacts as Record<string, ProviderFact>;
export const HTTP_HOSTS = hosts as Record<string, HostFact>;

/** Models and tables whose names suggest they record processed events. */
export const DEDUPE_NAME = /processed|dedup|idempot|webhook_?events?|inbox|seen_?events?/i;

export function chainMatches(pattern: string, chain: string[]): boolean {
  if (pattern === "()") return chain.length === 0;
  const parts = pattern.split(".");
  if (chain.length < parts.length) return false;
  const tail = chain.slice(chain.length - parts.length);
  return parts.every((p, i) => p === "*" || p === tail[i]);
}

export function moduleMatches(m: string | string[], module: string): boolean {
  return Array.isArray(m) ? m.includes(module) : m === module;
}

export function findEntry<T extends { match: { module: string | string[]; callee: string } }>(
  catalog: T[],
  module: string,
  chain: string[],
): T | undefined {
  return catalog.find((e) => moduleMatches(e.match.module, module) && chainMatches(e.match.callee, chain));
}

export const REDIS_MODULES = (redis as Pack).effects[0]!.match.module as string[];
export const SQL_MODULES = (sql as Pack).effects[0]!.match.module as string[];
export const PRISMA_MODULE = "@prisma/client";

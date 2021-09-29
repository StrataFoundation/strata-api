import Fastify, { FastifyReply, FastifyRequest } from 'fastify'
import mercurius, { IResolvers, MercuriusLoaders } from 'mercurius'
import mercuriusCodegen, { gql } from 'mercurius-codegen'
import redis from "redis";
import { promisify } from 'util';
import axios from "axios";
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { auth0 } from './auth0';
import { twitterClient } from './twitter';
import { createVerifiedTwitterRegistry } from './nameServiceTwitter';
import { NAME_PROGRAM_ID } from '@bonfida/spl-name-service';

const connection = new Connection(process.env.SOLANA_URL!);
const twitterServiceAccount = Keypair.fromSecretKey(new Uint8Array(JSON.parse(process.env.TWITTER_SERVICE_ACCOUNT!)));
const twitterTld = new PublicKey(process.env.TWITTER_TLD!)

export const redisClient = redis.createClient({
  host: process.env["REDIS_HOST"] || "localhost",
  port: Number(process.env["REDIS_PORT"] || "6379")
})

export const app = Fastify()

app.register(require('fastify-cors'), {
  origin: (origin: any, cb: any) => {
    cb(null, true)
  }
})

const buildContext = async (req: FastifyRequest, _reply: FastifyReply) => {
  return {
    authorization: req.headers.authorization,
  }
}

type PromiseType<T> = T extends PromiseLike<infer U> ? U : T

declare module 'mercurius' {
  interface MercuriusContext
    extends PromiseType<ReturnType<typeof buildContext>> {}
}

const schema = gql`
  type Account {
    publicKey: String!
  }

  type Query {
    totalWumLocked: Float
    wumHeld(wallet: String!): Float
    accountRank(mint: String!, publicKey: String!): Int
    topHolders(mint: String!, startRank: Int!, stopRank: Int!): [Account!]!
    wumRank(publicKey: String!): Int
    topWumHolders(startRank: Int!, stopRank: Int!): [Account!]!
    tokenRank(tokenBondingKey: String!): Int
    topTokens(startRank: Int!, stopRank: Int!): [Account!]!
  }
`

function accountsByBalanceKey(mint: string): string {
  return `accounts-by-balance-${mint}`
}

const resolvers: IResolvers = {
  Query: {
    async totalWumLocked() {
      return Number(await promisify(redisClient.get).bind(redisClient, "total-wum-locked")())
    },
    async wumHeld(_, { wallet }) {
      return Number(await promisify(redisClient.zscore).bind(redisClient, "wum-locked", wallet)())
    },
    async accountRank(_, { mint, publicKey }) {
      const rank = await promisify(redisClient.zrevrank).bind(redisClient, accountsByBalanceKey(mint), publicKey)()
      return rank
    },
    async topHolders(_, { mint, startRank, stopRank }) {
      const keys: string[] = (await promisify(redisClient.zrevrange).bind(redisClient, accountsByBalanceKey(mint), startRank, stopRank)()) as string[];
      return keys.map(publicKey => ({ publicKey }));
    },
    async wumRank(_, { publicKey }) {
      const rank = await promisify(redisClient.zrevrank).bind(redisClient, "wum-locked", publicKey)()
      return rank
    },
    async topWumHolders(_, { startRank, stopRank }) {
      const keys: string[] = (await promisify(redisClient.zrevrange).bind(redisClient, "wum-locked", startRank, stopRank)()) as string[];
      return keys.map(publicKey => ({ publicKey }));
    },
    async tokenRank(_, { tokenBondingKey }) {
      const rank = await promisify(redisClient.zrevrank).bind(redisClient, "top-tokens", tokenBondingKey)()
      return rank
    },
    async topTokens(_, { startRank, stopRank }) {
      const keys: string[] = (await promisify(redisClient.zrevrange).bind(redisClient, "top-tokens", startRank, stopRank)()) as string[];
      return keys.map(publicKey => ({ publicKey }));
    }
  }
}

const loaders: MercuriusLoaders = {
}

app.register(mercurius, {
  schema,
  resolvers,
  loaders,
  context: buildContext,
  subscription: true,
  graphiql: true
})

app.post<{ Body: { pubkey: string, code: string, redirectUri: string, twitterHandle: string } }>('/registrar/twitter-oauth', async (req) => {
  const { pubkey, code, redirectUri, twitterHandle } = req.body;

  const { access_token: accessToken } =
    (await auth0.oauth?.authorizationCodeGrant({
      code,
      redirect_uri: redirectUri,
    }) || {});
  const user = await auth0.users?.getInfo(accessToken!);
  // @ts-ignore
  const { sub } = user;
  const twitterUser: any = await twitterClient.get("users/show", {
    user_id: sub.replace("twitter|", ""),
  });

  if (twitterUser.screen_name != twitterHandle) {
    throw new Error(`Screen name does ${twitterUser.screen_name} not match the screen name provided ${twitterHandle}`);
  }

  const pubKey = new PublicKey(pubkey)
  const instructions = await createVerifiedTwitterRegistry(
    connection,
    twitterHandle,
    pubKey,
    1000,
    pubKey,
    NAME_PROGRAM_ID,
    twitterServiceAccount.publicKey,
    twitterTld
  );

  const transaction = new Transaction({ recentBlockhash: (await connection.getRecentBlockhash()).blockhash, feePayer: pubKey })
  transaction.add(...instructions);
  transaction.partialSign(twitterServiceAccount);

  return transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toJSON()
})

app.get('/', async () => {
  return { healthy: 'true' }
})

mercuriusCodegen(app, {
  targetPath: './src/graphql/generated.ts',
  operationsGlob: './src/graphql/operations/*.gql',
}).catch(console.error)

app.listen(Number(process.env["PORT"] || "8080"), '0.0.0.0')

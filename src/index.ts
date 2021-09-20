import Fastify, { FastifyReply, FastifyRequest } from 'fastify'
import mercurius, { IResolvers, MercuriusLoaders } from 'mercurius'
import mercuriusCodegen, { gql } from 'mercurius-codegen'
import redis from "redis";
import { promisify } from 'util';

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

app.get('/', async () => {
  return { healthy: 'true' }
})

mercuriusCodegen(app, {
  targetPath: './src/graphql/generated.ts',
  operationsGlob: './src/graphql/operations/*.gql',
}).catch(console.error)

app.listen(Number(process.env["PORT"] || "8080"), '0.0.0.0')

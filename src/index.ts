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
    holderRank(tokenBonding: String!, account: String!): Int
    topHolders(tokenBonding: String!, startRank: Int!, stopRank: Int!): [Account!]!
    tokenRank(baseMint: String!, tokenBonding: String!): Int
    topTokens(baseMint: String!, startRank: Int!, stopRank: Int!): [Account!]!
  }
`

function accountsByBalanceKey(tokenBonding: string): string {
  return `accounts-by-balance-${tokenBonding}`
}

function bondingByTvlKey(mint: string): string {
  return `bonding-by-tvl-${mint}`
}

const resolvers: IResolvers = {
  Query: {
    async holderRank(_, { tokenBonding, account }) {
      const rank = await promisify(redisClient.zrevrank).bind(redisClient, accountsByBalanceKey(tokenBonding), account)()
      return rank
    },
    async topHolders(_, { tokenBonding, startRank, stopRank }) {
      const keys: string[] = (await promisify(redisClient.zrevrange).bind(redisClient, accountsByBalanceKey(tokenBonding), startRank, stopRank)()) as string[];
      return keys.map(publicKey => ({ publicKey }));
    },
    async tokenRank(_, { baseMint, tokenBonding }) {
      const rank = await promisify(redisClient.zrevrank).bind(redisClient, bondingByTvlKey(baseMint), tokenBonding)()
      return rank
    },
    async topTokens(_, { baseMint, startRank, stopRank }) {
      const keys: string[] = (await promisify(redisClient.zrevrange).bind(redisClient, bondingByTvlKey(baseMint), startRank, stopRank)()) as string[];
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

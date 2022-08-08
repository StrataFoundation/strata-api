import { BorshAccountsCoder } from "@project-serum/anchor";
import { accelerator } from "./accelerator";
import { NATIVE_MINT } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { SplTokenBonding } from "@strata-foundation/spl-token-bonding";
import axios from "axios";
import bs58 from "bs58";
import Fastify, { FastifyReply, FastifyRequest } from "fastify";
import mercurius, { IResolvers, MercuriusLoaders } from "mercurius";
import mercuriusCodegen, { gql } from "mercurius-codegen";
import { messageFetcher } from "./messageFetcher";
import { pool } from "./postgres";
import { provider } from "./solana";

export const app = Fastify();

app.register(require("fastify-cors"), {
  origin: (origin: any, cb: any) => {
    cb(null, true);
  },
});

const buildContext = async (req: FastifyRequest, _reply: FastifyReply) => {
  return {
    authorization: req.headers.authorization,
  };
};

type PromiseType<T> = T extends PromiseLike<infer U> ? U : T;

declare module "mercurius" {
  interface MercuriusContext
    extends PromiseType<ReturnType<typeof buildContext>> {}
}

const schema = gql`
  type Account {
    publicKey: String!
  }

  type Chat {
    publicKey: String!
    name: String!
    dailyActiveUsers: Int!
    identifierCertificateMint: String!
  }

  type Query {
    holderRank(tokenBonding: String!, account: String!): Int
    topHolders(
      tokenBonding: String!
      startRank: Int!
      stopRank: Int!
    ): [Account!]!
    tokenRank(baseMint: String!, tokenBonding: String!): Int
    topTokens(baseMint: String!, startRank: Int!, stopRank: Int!): [Account!]!

    chats(pubkeys: [String]): [Chat!]!
  }
`;

type Truthy<T> = T extends false | "" | 0 | null | undefined ? never : T; // from lodash

const truthy = <T>(value: T): value is Truthy<T> => !!value;

function getReserve(data: Buffer): PublicKey {
  const firstOptionOffset = data[0] * 32 + 1;
  const secondOptionOffset =
    firstOptionOffset + data[firstOptionOffset] * 32 + 1;
  const thirdOptionOffset =
    secondOptionOffset + data[secondOptionOffset] * 32 + 1;

  return new PublicKey(data.slice(thirdOptionOffset, thirdOptionOffset + 32));
}

let tokenBondingSdk: SplTokenBonding;
async function getBondingSdk() {
  if (tokenBondingSdk) {
    return tokenBondingSdk;
  }

  tokenBondingSdk = await SplTokenBonding.init(provider);

  return tokenBondingSdk;
}

interface ITopToken {
  tokenBonding: string;
  amount: number;
}
const topTokensCache: Map<string, { date: Date, tokens: ITopToken[] }> = new Map();
async function populateTopTokens(baseMint: PublicKey): Promise<ITopToken[]> {
  const tokenBondingSdk = await getBondingSdk();
  const state = await tokenBondingSdk.getState();
  if (baseMint.equals(NATIVE_MINT)) {
    baseMint = state!.wrappedSolMint;
  }
  const descriminator =
    BorshAccountsCoder.accountDiscriminator("tokenBondingV0");
  const filters = [
    {
      memcmp: {
        offset: 0,
        bytes: bs58.encode(
          Buffer.concat([descriminator, baseMint?.toBuffer()].filter(truthy))
        ),
      },
    },
    {
      // All royalties should be 0 and curve should be fixed and mint cap + purchase cap not defined
      memcmp: {
        offset:
          descriminator.length,
        bytes: bs58.encode(
          baseMint.toBuffer()
        ),
      },
    },
  ];
  const reserves = await provider.connection.getProgramAccounts(
    tokenBondingSdk.programId,
    {
      dataSlice: {
        length:
          32 + // base storage
          3 * 32 +
          3, // Optional authorities
        offset:
          2 * 32 + // base, target mints
          descriminator.length,
      },
      filters,
    }
  );

  const amounts = (await Promise.all(
    reserves.map(async (reserve) => {
      const acc = getReserve(reserve.account.data);
      try {
        return {
          tokenBonding: reserve.pubkey.toBase58(),
          amount:
            (await provider.connection.getTokenAccountBalance(acc)).value
              .uiAmount || 0,
        };
      } catch (e: any) {
        console.error(`Failed on ${acc.toBase58()}`, e);
      }
    })
  )).filter(truthy);
  
  const topTokens = amounts.sort((a1, a2) => a2.amount - a1.amount);
  topTokensCache.set(baseMint.toBase58(), {
    date: new Date(),
    tokens: topTokens
  });

  return topTokens;
}

function minutesAgo(minutes: number): Date {
  var currentDate = new Date();
  return  new Date(currentDate.getTime() - minutes*60000);
}

async function getTopTokens(baseMint: PublicKey): Promise<ITopToken[]> {
  if (!topTokensCache.has(baseMint.toBase58()) || topTokensCache.get(baseMint.toBase58())!.date < minutesAgo(30)) {
    return populateTopTokens(baseMint);
  }

  return topTokensCache.get(baseMint.toBase58())!.tokens
}

async function getTopHolders(tokenBonding: PublicKey, start: number, stop: number): Promise<PublicKey[]> {
  const tokenBondingSdk = await getBondingSdk();
  const bonding = (await tokenBondingSdk.getTokenBonding(tokenBonding))!
  const holders = await axios.get(
    `https://api.solscan.io/token/holders`, {
      params: {
        token: bonding.targetMint.toBase58(),
        offset: start,
        size: stop - start
      }
    }
  );


  return holders.data.data.result.map((h: any) => new PublicKey(h.address));
}

const resolvers: IResolvers = {
  Query: {
    async holderRank(_, { tokenBonding, account }) {
      const keys: string[] = (
        await getTopHolders(new PublicKey(tokenBonding), 0, 10000)
      ).map((p) => p.toBase58());
      const rank = keys.indexOf(account);
      return rank;
    },
    async topHolders(_, { tokenBonding, startRank, stopRank }) {
      const keys: string[] = (await getTopHolders(new PublicKey(tokenBonding), startRank, stopRank)).map(p => p.toBase58())
      return keys.map((publicKey) => ({ publicKey }));
    },
    async tokenRank(_, { baseMint, tokenBonding }) {
      const tokens = (await getTopTokens(new PublicKey(baseMint)));
      const rank = tokens
        .findIndex(i => i.tokenBonding == tokenBonding)
      console.log(tokens);

      return rank;
    },
    async topTokens(_, { baseMint, startRank, stopRank }) {
      const keys = (await getTopTokens(new PublicKey(baseMint))).slice(startRank, stopRank).map(k => k.tokenBonding);
      return keys.map((publicKey) => ({ publicKey }));
    },

    async chats(_, { pubkeys }) {
      const client = await pool.connect();
      try {
        const values = pubkeys ? [pubkeys] : [];
        const query = `
        SELECT pubkey as "publicKey", name, "identifierCertificateMint", "dailyActiveUsers" 
        FROM acc_78
        LEFT OUTER JOIN (
          select chat, count(distinct(sender)) as "dailyActiveUsers"
          FROM events_message_part_event_v_0_55
          WHERE blocktime > 1659894862.773 -- ${
            new Date().valueOf() / 1000 - 24 * 60 * 60
          }
          GROUP BY chat
        ) unique_senders ON unique_senders.chat = acc_78.pubkey 
        WHERE "dailyActiveUsers" > 0 ${pubkeys ? `AND pubkey IN $pubkeys` : ``}
        ORDER BY slot DESC
        LIMIT 50
      `;
        const data = await client.query(query, values);

        return data.rows;
      } finally {
        client.release(true);
      }
    }
  },
};

const loaders: MercuriusLoaders = {};

app.register(mercurius, {
  schema,
  resolvers,
  loaders,
  context: buildContext,
  subscription: true,
  graphiql: true,
});

app.get("/", async () => {
  return { healthy: "true" };
});

mercuriusCodegen(app, {
  targetPath: "./src/graphql/generated.ts",
  operationsGlob: "./src/graphql/operations/*.gql",
}).catch(console.error);

accelerator(app);
messageFetcher(app);

app.listen(Number(process.env["PORT"] || "8080"), "0.0.0.0");

import { SocketStream } from "@fastify/websocket";
import { FastifyInstance, FastifyRequest } from "fastify";
import {
  Account,
  Connection,
  RpcResponseAndContext,
  SimulatedTransactionResponse,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import { v4 as uuid } from "uuid";
import amqp from "amqplib";

let conn;
let channel: amqp.Channel;
let queue: amqp.Replies.AssertQueue;
const exchange = "accelerator";

enum Cluster {
  Devnet = "devnet",
  Mainnet = "mainnet-beta",
  Testnet = "testnet",
  Localnet = "localnet",
}

function getRpc(cluster: Cluster) {
  if (cluster === "localnet") {
    return "http://127.0.0.1:8899";
  } else if (cluster === "devnet") {
    return "https://devnet.genesysgo.net/";
  } else {
    return "https://strataprotocol.genesysgo.net";
  }
}

enum PayloadType {
  Transaction = "transaction",
  Subscribe = "subscribe",
  Unsubscribe = "unsubscribe",
}

enum ResponseType {
  Error = "error",
  Transaction = "transaction",
  Unsubscribe = "unsubscribe",
  Subscribe = "subscribe",
}

interface Payload {
  type: PayloadType;
  cluster: Cluster;
}

interface TransactionPayload extends Payload {
  transactionBytes: number[];
}

interface ValidTransactionPayload extends TransactionPayload {
  blockTime: number;
  txid: string;
}

type StringPublicKey = string;

interface SubscribePayload extends Payload {
  account: StringPublicKey;
}

interface UnsubscribePayload extends Payload {
  id: string;
}

// cluster + txid => subsription id => handler
const subscriptions: Record<
  string,
  Record<string, (tx: TransactionPayload) => void>
> = {};
const subsForSubscriptionId: Record<string, string> = {};

function handleValidTx(payload: ValidTransactionPayload): void {
  const tx = Transaction.from(new Uint8Array(payload.transactionBytes));
  const accounts = tx.compileMessage().accountKeys;

  accounts.map((account) => {
    const sub = payload.cluster + account.toBase58();
    if (subscriptions[sub]) {
      Object.values(subscriptions[sub]).map((handler) => handler(payload));
    }
  });
}

function publishTx(payload: ValidTransactionPayload): Promise<boolean[]> {
  const tx = Transaction.from(new Uint8Array(payload.transactionBytes));
  const accounts = tx.compileMessage().accountKeys;

  return Promise.all(
    accounts.map((account) => {
      const sub = payload.cluster + account.toBase58();
      return channel.publish(
        exchange,
        sub,
        Buffer.from(JSON.stringify(payload))
      );
    })
  );
}

function getSub(payload: SubscribePayload): string {
  return payload.cluster + payload.account;
}

async function subscribe(
  payload: SubscribePayload,
  handler: (tx: TransactionPayload) => void
): Promise<string> {
  const id = uuid();
  const sub = getSub(payload);

  if (Object.keys(subscriptions[sub] || {}).length == 0) {
    await channel.bindQueue(queue.queue, exchange, sub);
  }
  subscriptions[sub] = subscriptions[sub] || {};
  subscriptions[sub][id] = handler;
  subsForSubscriptionId[id] = sub;

  return id;
}

async function unsubscribe(payload: UnsubscribePayload): Promise<void> {
  const sub = subsForSubscriptionId[payload.id];
  const currentSub = subscriptions[sub];
  const numSubs = Object.keys(currentSub || {}).length;
  if (currentSub) {
    delete currentSub[payload.id];
  }
  delete subsForSubscriptionId[payload.id];
  if (numSubs == 0) {
    await channel.unbindQueue(queue.queue, exchange, sub);
  }
}

export function accelerator(app: FastifyInstance) {
  (async () => {
    try {
      conn = await amqp.connect({
        protocol: process.env.RABBIT_PROTOCOL || "amqp",
        hostname: process.env.RABBIT_HOSTNAME!,
        port: process.env.RABBIT_PORT ? Number(process.env.RABBIT_PORT) : 5672,
        username: process.env.RABBIT_USERNAME,
        password: process.env.RABBIT_PASSWORD,
      });
      channel = await conn.createChannel();
      await channel.assertExchange(exchange, "direct", {
        durable: true,
      });
      queue = await channel.assertQueue("", { exclusive: true });
      await channel.consume(
        queue.queue,
        function (msg) {
          if (msg) {
            const content = JSON.parse(msg.content.toString());
            handleValidTx(content);
          }
        },
        {
          noAck: true,
        }
      );
    } catch (e: any) {
      console.error(e);
      process.exit(1)
    }
  })();

  app.register(require("@fastify/websocket"));
  app.register(async function (fastify) {
    fastify.get(
      "/accelerator",
      { websocket: true },
      (connection: SocketStream, req: FastifyRequest) => {
        let ids: { id: string; cluster: Cluster }[] = [];

        connection.socket.on("close", async () => {
          await Promise.all(
            Array.from(ids).map(({ cluster, id }) =>
              unsubscribe({
                type: PayloadType.Unsubscribe,
                cluster,
                id,
              })
            )
          );
        });

        connection.socket.on("message", async (message) => {
          const payload: Payload = JSON.parse(message.toString());
          const alreadySubscribedAccounts: Record<string, string> = {};

          switch (payload.type) {
            case PayloadType.Transaction:
              const transactionPayload = payload as TransactionPayload;
              const tx = Transaction.from(
                new Uint8Array(transactionPayload.transactionBytes)
              );
              const solConnection = new Connection(getRpc(payload.cluster));

              const resp = await retryBlockhashNotFound(solConnection, tx);
              const err = resp.value.err;
              if (err) {
                connection.socket.send(
                  JSON.stringify({
                    type: ResponseType.Error,
                    error: err,
                  })
                );
                return;
              }
              const blockTime = (await solConnection.getAccountInfo(
                SYSVAR_CLOCK_PUBKEY
              ))!.data.readBigInt64LE(8 * 4);
              const txid = await solConnection.sendRawTransaction(
                tx.serialize(),
                {
                  skipPreflight: true,
                }
              );

              await publishTx({
                ...transactionPayload,
                blockTime: Number(blockTime),
                txid,
              });
              break;

            case PayloadType.Subscribe:
              const subscribePayload = payload as SubscribePayload;
              let id: string;
              if (
                !alreadySubscribedAccounts[
                  subscribePayload.account + subscribePayload.cluster
                ]
              ) {
                id = await subscribe(subscribePayload, (txPayload) =>
                  connection.socket.send(JSON.stringify(txPayload))
                );
                alreadySubscribedAccounts[
                  subscribePayload.account + subscribePayload.cluster
                ] = id;
                ids.push({
                  id,
                  cluster: payload.cluster,
                });
              } else {
                id =
                  alreadySubscribedAccounts[
                    subscribePayload.account + subscribePayload.cluster
                  ];
              }

              connection.socket.send(
                JSON.stringify({
                  type: ResponseType.Subscribe,
                  id,
                })
              );
              break;

            case PayloadType.Unsubscribe:
              const unsubscribePayload = payload as UnsubscribePayload;
              await unsubscribe(unsubscribePayload);
              ids = ids.filter((i) => i.id !== unsubscribePayload.id);
              connection.socket.send(
                JSON.stringify({
                  type: ResponseType.Unsubscribe,
                  successful: true,
                })
              );
              break;
          }
        });
      }
    );
  });
}

async function retryBlockhashNotFound(
  solConnection: Connection,
  tx: Transaction,
  tries: number = 0
): Promise<RpcResponseAndContext<SimulatedTransactionResponse>> {
  const resp = await solConnection.simulateTransaction(tx);
  const err = resp.value.err;
  if (err === "BlockhashNotFound" && tries < 5) {
    await sleep(300);
    return retryBlockhashNotFound(solConnection, tx, tries + 1);
  }

  return resp;
}

function sleep(arg0: number): Promise<void> {
  return new Promise((resolve) => setTimeout(() => resolve(), arg0));
}

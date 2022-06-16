import { SocketStream } from "@fastify/websocket";
import { FastifyInstance, FastifyRequest } from "fastify";
import { Connection, RpcResponseAndContext, SimulatedTransactionResponse, SYSVAR_CLOCK_PUBKEY, Transaction } from "@solana/web3.js";
import { v4 as uuid } from "uuid";

enum Cluster {
  Devnet = "devnet",
  Mainnet = "mainnet-beta",
  Testnet = "testnet",
  Localnet = "localnet",
};


function getRpc(cluster: Cluster) {
  if (cluster === "localnet") {
    return "http://127.0.0.1:8899"
  } else if (cluster === "devnet") {
    return "https://psytrbhymqlkfrhudd.dev.genesysgo.net:8899/"
  } else {
    return "https://strataprotocol.genesysgo.net"
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
  id: string
}

// cluster + txid => subsription id => handler
const subscriptions: Record<string, Record<string, (tx: TransactionPayload) => void>> = {};
const subsForSubscriptionId: Record<string, string> = {};

function handleValidTx(payload: ValidTransactionPayload): void {
  const tx = Transaction.from(new Uint8Array(payload.transactionBytes));
  const accounts = tx.compileMessage().accountKeys

  accounts.map(account => {
    const sub = payload.cluster + account.toBase58();
    if (subscriptions[sub]) {
      Object.values(subscriptions[sub]).map(handler => handler(payload))
    }
  })
}

function getSub(payload: SubscribePayload): string {
  return payload.cluster + payload.account
}

function subscribe(
  payload: SubscribePayload,
  handler: (tx: TransactionPayload) => void
): string {
  const id = uuid();
  const sub = getSub(payload);

  subscriptions[sub] = subscriptions[sub] || {};
  subscriptions[sub][id] = handler;
  subsForSubscriptionId[id] = sub;

  return id;
}

function unsubscribe(payload: UnsubscribePayload): void {
  const sub = subsForSubscriptionId[payload.id];
  delete subscriptions[sub][payload.id];
  delete subsForSubscriptionId[payload.id];
}

export function accelerator(app: FastifyInstance) {
  app.register(require("@fastify/websocket"));
  app.register(async function (fastify) {
    fastify.get(
      "/accelerator",
      { websocket: true },
      (connection: SocketStream, req: FastifyRequest) => {
        let ids: { id: string, cluster: Cluster }[] = [];

        connection.socket.on("close", () => {
          Array.from(ids).map(({ cluster, id }) => unsubscribe({
            type: PayloadType.Unsubscribe,
            cluster,
            id
          }));
        })
        
        connection.socket.on("message", async (message) => {
          const payload: Payload = JSON.parse(message.toString());
          const alreadySubscribedAccounts: Record<string, string> = {}

          switch (payload.type) {
            case PayloadType.Transaction:
              const transactionPayload = payload as TransactionPayload;
              const tx = Transaction.from(new Uint8Array(transactionPayload.transactionBytes));
              const solConnection = new Connection(getRpc(payload.cluster));

              const resp = await retryBlockhashNotFound(solConnection, tx)
              const err = resp.value.err;
              if (err) {
                connection.socket.send(JSON.stringify({
                  type: ResponseType.Error,
                  error: err,
                }));
                return;
              }
              const blockTime = (
                await solConnection.getAccountInfo(SYSVAR_CLOCK_PUBKEY)
              )!.data.readBigInt64LE(8 * 4);
              const txid = await solConnection.sendRawTransaction(
                tx.serialize(),
                {
                  skipPreflight: true,
                }
              );

              handleValidTx({ ...transactionPayload, blockTime: Number(blockTime), txid });
              break;

            case PayloadType.Subscribe:
              const subscribePayload = payload as SubscribePayload;
              let id: string;
              if (!alreadySubscribedAccounts[subscribePayload.account + subscribePayload.cluster]) {
                id = subscribe(subscribePayload, (txPayload) =>
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
                id = alreadySubscribedAccounts[subscribePayload.account + subscribePayload.cluster]
              }
              
              connection.socket.send(JSON.stringify({
                type: ResponseType.Subscribe,
                id,
              }));
              break;

            case PayloadType.Unsubscribe:
              const unsubscribePayload = payload as UnsubscribePayload;
              unsubscribe(unsubscribePayload);
              ids = ids.filter(i => i.id !== unsubscribePayload.id);
              connection.socket.send(JSON.stringify({
                type: ResponseType.Unsubscribe,
                successful: true,
              }));
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
    await sleep(300)
    return retryBlockhashNotFound(solConnection, tx, tries + 1);
  }

  return resp;
}

function sleep(arg0: number): Promise<void> {
  return new Promise((resolve) => setTimeout(() => resolve(), arg0))
}


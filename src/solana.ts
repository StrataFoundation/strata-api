import { Connection, Keypair } from "@solana/web3.js";
import { Provider } from "@project-serum/anchor";
import Wallet from "@project-serum/anchor/dist/cjs/nodewallet";

export const connection = new Connection(
  process.env["SOLANA_URL"] || "https://wumbo.devnet.rpcpool.com/"
);

export const provider = new Provider(connection, new Wallet(Keypair.generate()), {
  commitment: "confirmed",
});

import { FastifyInstance } from "fastify";
import { pool } from "./postgres";

export function messageFetcher(app: FastifyInstance) {
  app.post<{
    Body: {
      chat: string,
      maxBlockTime: number,
      minBlockTime: number,
      limit: number,
      offset: number
    }
  }>("/messages", async (req, res) => {
    const event = req.body;
    const client = await pool.connect();
    try {
      const values = [
        event.chat,
        event.maxBlockTime,
        event.minBlockTime,
        Math.min(event.limit, 1000),
        event.offset,
      ];
      const data = await client.query(
        `
      SELECT *, "id_1" as "id" from events_message_part_event_v_0_55
      WHERE "chat" = $1 AND 
            "blocktime" <= $2 AND 
            "blocktime" > $3
      ORDER BY blocktime DESC
      LIMIT $4
      OFFSET $5
      `,
        values
      );
      return data.rows;
    } finally {
      client.release(true);
    }
  });
}

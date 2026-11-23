const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.PGHOST || "127.0.0.1",
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "",
  database: process.env.PGDATABASE || "save_share",
  max: 10,
});

async function queryWith(client, sql, values = []) {
  let parameterIndex = 0;
  const statement = sql
    .replace(/`([^`]+)`/g, '"$1"')
    .replace(/\?/g, () => `$${++parameterIndex}`);
  const isInsert = /^\s*INSERT\b/i.test(statement);
  const result = await client.query(
    isInsert && !/\bRETURNING\b/i.test(statement)
      ? `${statement} RETURNING id`
      : statement,
    values,
  );

  if (isInsert) result.rows.insertId = result.rows[0]?.id;
  return [result.rows];
}

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error);
});

module.exports = {
  query: (sql, values) => queryWith(pool, sql, values),
  async getConnection() {
    const client = await pool.connect();
    return {
      query: (sql, values) => queryWith(client, sql, values),
      beginTransaction: () => client.query("BEGIN"),
      commit: () => client.query("COMMIT"),
      rollback: () => client.query("ROLLBACK"),
      release: () => client.release(),
    };
  },
  close: () => pool.end(),
};

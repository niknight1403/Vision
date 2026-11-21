import net from "node:net";

const raw = process.env.DATABASE_URL;
if (!raw) {
  console.error("PostgreSQL integration gate: DATABASE_URL is required; no database evidence claimed.");
  process.exit(2);
}
let url;
try { url = new URL(raw); } catch {
  console.error("PostgreSQL integration gate: DATABASE_URL is invalid.");
  process.exit(2);
}
if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
  console.error("PostgreSQL integration gate: DATABASE_URL must use postgresql:// or postgres://.");
  process.exit(2);
}
const port = Number(url.port || 5432);
const host = url.hostname;
const socket = net.createConnection({ host, port });
const timer = setTimeout(() => socket.destroy(new Error("timeout")), 3000);
socket.once("connect", () => {
  clearTimeout(timer);
  socket.end();
  console.log(`PostgreSQL integration gate: TCP endpoint reachable at ${host}:${port}; migrations and tests are required next.`);
});
socket.once("error", (error) => {
  clearTimeout(timer);
  console.error(`PostgreSQL integration gate: endpoint unavailable (${error.code ?? "connection error"}); no green result claimed.`);
  process.exit(2);
});

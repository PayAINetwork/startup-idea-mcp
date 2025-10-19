import fs from "node:fs";
import path from "node:path";

const file = path.join(process.cwd(), "node_modules", "mcpay", "dist", "client.js");
try {
  let src = fs.readFileSync(file, "utf8");
  const before = src;
  src = src.replace("./client/with-x402-client", "./client/with-x402-client.js");
  if (src !== before) {
    fs.writeFileSync(file, src, "utf8");
    console.log("Patched mcpay/dist/client.js to use explicit .js extension.");
  }
} catch (e) {
  console.warn("Skipping mcpay client patch:", e?.message || e);
}



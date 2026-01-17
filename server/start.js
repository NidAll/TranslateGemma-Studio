process.env.NEXT_TELEMETRY_DISABLED =
  process.env.NEXT_TELEMETRY_DISABLED || "1";

import("./index.js").catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

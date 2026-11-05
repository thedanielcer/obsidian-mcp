import { createApp } from "./app.ts";
import { loadConfig } from "./config/env.ts";
import { createLogger } from "./logger.ts";

const config = loadConfig();
const logger = createLogger(config);
const app = createApp(config, logger);
const { host, port } = config;

app.listen(port, host, () => {
	logger.info({ host, port }, "Obsidian MCP server listening");
});

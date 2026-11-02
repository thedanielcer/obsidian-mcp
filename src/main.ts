import { createApp } from "./app.ts";
import { loadConfig } from "./config/env.ts";

const config = loadConfig();
const app = createApp(config);
const { host, port } = config;

app.listen(port, host, () => {
	console.log(`Obsidian MCP server listening at http://${host}:${port}/`);
});

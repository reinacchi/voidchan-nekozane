import { config } from "../src/config.ts";
import { slashCommands } from "../src/commands.js";

async function main() {
  const response = await fetch(`https://discord.com/api/v10/applications/${config.applicationId}/guilds/${config.guildId}/commands`, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${config.discordToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(slashCommands)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Command registration failed (${response.status}): ${text}`);
  }

  console.log("Guild commands registered.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

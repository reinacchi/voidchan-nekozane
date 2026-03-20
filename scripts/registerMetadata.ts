import { config } from "../src/config.ts";

async function main() {
  const response = await fetch(`https://discord.com/api/v10/applications/${config.applicationId}/role-connections/metadata`, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${config.discordToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify([
      {
        type: 7,
        key: "has_contributed",
        name: "Has contributed",
        description: `Has contributed at least once to ${config.repoOwner}/${config.repoName}`
      }
    ])
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Metadata registration failed (${response.status}): ${text}`);
  }

  console.log("Linked role metadata registered.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

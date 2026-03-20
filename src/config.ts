import dotenv from "dotenv";

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  discordToken: requireEnv("DISCORD_TOKEN"),
  applicationId: requireEnv("DISCORD_APPLICATION_ID"),
  discordClientId: requireEnv("DISCORD_CLIENT_ID"),
  discordClientSecret: requireEnv("DISCORD_CLIENT_SECRET"),
  guildId: requireEnv("DISCORD_GUILD_ID"),
  contributorRoleId: requireEnv("CONTRIBUTOR_ROLE_ID"),
  discordRedirectUri: requireEnv("DISCORD_REDIRECT_URI"),
  githubClientId: requireEnv("GITHUB_CLIENT_ID"),
  githubClientSecret: requireEnv("GITHUB_CLIENT_SECRET"),
  githubRedirectUri: requireEnv("GITHUB_REDIRECT_URI"),
  sessionSecret: requireEnv("SESSION_SECRET"),
  port: Number(process.env.PORT ?? 3000),
  repoOwner: process.env.REPO_OWNER ?? "reinacchi",
  repoName: process.env.REPO_NAME ?? "voidchan",
  baseUrl: requireEnv("BASE_URL")
};

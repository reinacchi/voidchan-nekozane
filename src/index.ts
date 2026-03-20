import express from "express";
import { ActivityTypes, Client, CommandInteraction, Intents, InteractionTypes } from "oceanic.js";
import { config } from "./config.ts";
import { exchangeDiscordCode, getDiscordUser, updateRoleConnection } from "./discordOAuth.ts";
import { exchangeGithubCode, getGithubUser, hasContributedToRepo } from "./github.ts";
import { getOrCreateSession, randomState, saveSession } from "./sessionStore.ts";

const client = new Client({
  auth: `Bot ${config.discordToken}`,
  gateway: { intents: [Intents.GUILDS, Intents.GUILD_MEMBERS] }
});

client.once("ready", () => {
  client.editStatus("online", [{ name: "your smile (ღゝ◡╹)ノ♡", type: ActivityTypes.WATCHING }])

  console.log(`Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.type !== InteractionTypes.APPLICATION_COMMAND || !interaction.isChatInputCommand()) return;

    if (interaction.data.name === "ping") {
      await interaction.createMessage({ content: `pong! ${client.shards.get(0)?.latency ?? 0}ms`, flags: 64 });
      return;
    }

    if (interaction.data.name === "about") {
      await interaction.createMessage({
        embeds: [{
          title: `${client.user.username}`,
          description: "i am a discord bot to help within the VoidChan ecosystem!",
        }],
        flags: 64
      });
    }
  } catch (error) {
    console.error("interactionCreate error", error);
    if (!interaction.acknowledged) {
      await (interaction as CommandInteraction).createMessage({ content: "something went wrong.", flags: 64 });
    }
  }
});

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use((req, res, next) => {
  const rawCookie = req.headers.cookie ?? "";
  const existing = rawCookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("sid="))
    ?.slice(4);

  const session = getOrCreateSession(existing);
  saveSession(session.id, session.record);
  res.cookie("sid", session.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 1000 * 60 * 60 * 24
  });
  (req as express.Request & { sessionId: string; session: ReturnType<typeof getOrCreateSession>["record"] }).sessionId = session.id;
  (req as express.Request & { sessionId: string; session: ReturnType<typeof getOrCreateSession>["record"] }).session = session.record;
  next();
});

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
  <html><body style="font-family: sans-serif; max-width: 720px; margin: 40px auto; line-height: 1.5;">
    <h1>Nekozane</h1>
    <p>This is VoidChan's Nekozane. This app links a Discord account with GitHub and checks whether the GitHub user has contributed to <strong>${config.repoOwner}/${config.repoName}</strong>.</p>
    <p><a href="/linked-roles">Start Linked Roles Verification</a></p>
  </body></html>`);
});

app.get("/linked-roles", (req, res) => {
  const state = randomState();
  const typedReq = req as express.Request & { sessionId: string; session: Record<string, string> };
  typedReq.session.discordState = state;
  saveSession(typedReq.sessionId, typedReq.session);

  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", config.discordClientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.discordRedirectUri);
  url.searchParams.set("scope", "identify role_connections.write");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "consent");
  res.redirect(url.toString());
});

app.get("/auth/discord/callback", async (req, res) => {
  try {
    const typedReq = req as express.Request & { sessionId: string; session: Record<string, string> };
    if (req.query.state !== typedReq.session.discordState) {
      res.status(400).send("Invalid Discord OAuth state.");
      return;
    }

    const code = String(req.query.code ?? "");
    const token = await exchangeDiscordCode(code);
    const user = await getDiscordUser(token.access_token);
    typedReq.session.discordAccessToken = token.access_token;
    typedReq.session.discordRefreshToken = token.refresh_token;
    typedReq.session.discordUserId = user.id;
    typedReq.session.discordUsername = user.global_name ?? user.username;
    saveSession(typedReq.sessionId, typedReq.session);

    const githubState = randomState();
    typedReq.session.githubState = githubState;
    saveSession(typedReq.sessionId, typedReq.session);

    const githubUrl = new URL("https://github.com/login/oauth/authorize");
    githubUrl.searchParams.set("client_id", config.githubClientId);
    githubUrl.searchParams.set("redirect_uri", config.githubRedirectUri);
    githubUrl.searchParams.set("scope", "read:user");
    githubUrl.searchParams.set("state", githubState);
    res.redirect(githubUrl.toString());
  } catch (error) {
    console.error(error);
    res.status(500).send("Discord authentication failed.");
  }
});

app.get("/auth/github/callback", async (req, res) => {
  try {
    const typedReq = req as express.Request & { sessionId: string; session: Record<string, string> };
    if (req.query.state !== typedReq.session.githubState) {
      res.status(400).send("Invalid GitHub OAuth state.");
      return;
    }

    const code = String(req.query.code ?? "");
    const githubAccessToken = await exchangeGithubCode(code);
    const githubUser = await getGithubUser(githubAccessToken);
    const isContributor = await hasContributedToRepo(githubUser.login);

    typedReq.session.githubAccessToken = githubAccessToken;
    typedReq.session.githubLogin = githubUser.login;
    saveSession(typedReq.sessionId, typedReq.session);

    if (!typedReq.session.discordAccessToken || !typedReq.session.discordUserId) {
      res.status(400).send("Discord session missing. Please restart the linking flow.");
      return;
    }

    await updateRoleConnection(typedReq.session.discordAccessToken, githubUser.login, isContributor);

    if (isContributor) {
      try {
        await client.rest.guilds.addMemberRole(config.guildId, typedReq.session.discordUserId, config.contributorRoleId, "Verified via linked roles GitHub contribution check");
      } catch (roleError) {
        console.error("Failed to add contributor role directly", roleError);
      }
    }

    res.type("html").send(`<!doctype html>
    <html><body style="font-family: sans-serif; max-width: 720px; margin: 40px auto; line-height: 1.5;">
      <h1>Verification complete</h1>
      <p>Discord user: <strong>${typedReq.session.discordUsername ?? typedReq.session.discordUserId}</strong></p>
      <p>GitHub user: <strong>${githubUser.login}</strong></p>
      <p>Repository: <strong>${config.repoOwner}/${config.repoName}</strong></p>
      <p>Status: <strong>${isContributor ? "Contributor verified ✅" : "No contribution found ❌"}</strong></p>
    </body></html>`);
  } catch (error) {
    console.error(error);
    res.status(500).send("GitHub verification failed.");
  }
});

async function start() {
  await client.connect();
  app.listen(config.port, () => {
    console.log(`Web server listening on ${config.baseUrl}`);
  });
}

start().catch((error) => {
  console.error("Startup failure", error);
  process.exit(1);
});

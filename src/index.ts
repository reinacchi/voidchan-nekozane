import express from "express";
import {
  ActivityTypes,
  ChannelTypes,
  Client,
  CommandInteraction,
  ComponentInteraction,
  Intents,
  InteractionTypes
} from "oceanic.js";
import { config } from "./config.ts";
import { exchangeDiscordCode, getDiscordUser, updateRoleConnection } from "./discordOAuth.ts";
import { exchangeGithubCode, getGithubUser, hasContributedToRepo } from "./github.ts";
import {
  closeThreadByChannelId,
  getOpenThreadByChannelId,
  getOpenThreadByUserId,
  initializeModmailStore,
  nextThreadId,
  saveOpenThread
} from "./modmailStore.ts";
import { getOrCreateSession, randomState, saveSession } from "./sessionStore.ts";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const CONFIRM_ACCEPT_ID = "modmail_accept";
const CONFIRM_DENY_ID = "modmail_deny";

type PendingDmMessage = {
  userId: string;
  username: string;
  messages: Array<{
    content: string;
    attachments: Array<{ url: string; filename: string }>;
  }>;
};

const pendingConfirmations = new Map<string, PendingDmMessage>();

const client = new Client({
  auth: `Bot ${config.discordToken}`,
  gateway: {
    intents: [
      Intents.GUILDS,
      Intents.GUILD_MEMBERS,
      Intents.GUILD_MESSAGES,
      Intents.DIRECT_MESSAGES,
      Intents.MESSAGE_CONTENT
    ]
  }
});

function createEmbed(title: string, description: string) {
  return {
    title,
    description,
    color: 0x9b87f5,
    timestamp: new Date().toISOString()
  };
}

async function discordRequest(path: string, init: RequestInit): Promise<Response> {
  return fetch(`${DISCORD_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${config.discordToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });
}

async function createDmChannel(userId: string): Promise<string> {
  const response = await discordRequest("/users/@me/channels", {
    method: "POST",
    body: JSON.stringify({ recipient_id: userId })
  });

  if (!response.ok) {
    throw new Error(`Failed to create DM channel (${response.status}): ${await response.text()}`);
  }

  const json = (await response.json()) as { id: string };
  return json.id;
}

async function sendChannelMessage(channelId: string, body: Record<string, unknown>): Promise<void> {
  const response = await discordRequest(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Failed to send message (${response.status}): ${await response.text()}`);
  }
}

async function sendUserEmbed(userId: string, title: string, description: string): Promise<void> {
  const dmChannelId = await createDmChannel(userId);
  await sendChannelMessage(dmChannelId, { embeds: [createEmbed(title, description)] });
}

async function createModmailChannel(userId: string, username: string, threadNumber: number): Promise<string> {
  const safeName = username.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 30) || "user";
  const channelName = `thread-${String(threadNumber).padStart(4, "0")}-${safeName}`;

  const response = await discordRequest(`/guilds/${config.guildId}/channels`, {
    method: "POST",
    body: JSON.stringify({
      name: channelName,
      type: ChannelTypes.GUILD_TEXT,
      parent_id: config.modmailCategoryId,
      topic: `Modmail thread #${threadNumber} | User ID: ${userId}`
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to create thread channel (${response.status}): ${await response.text()}`);
  }

  const json = (await response.json()) as { id: string };
  return json.id;
}

function buildForwardEmbed(authorTag: string, userId: string, content: string, attachments: Array<{ url: string; filename: string }>) {
  const attachmentText = attachments.length > 0
    ? attachments.map((file) => `[${file.filename}](${file.url})`).join("\n")
    : "None";

  return {
    ...createEmbed(`Message from ${authorTag}`, content || "(no text content)"),
    fields: [
      { name: "User ID", value: userId, inline: true },
      { name: "Attachments", value: attachmentText, inline: false }
    ]
  };
}

function buildStaffReplyEmbed(content: string) {
  return createEmbed("Staff Reply", content);
}

async function forwardUserMessageToThread(userId: string, username: string, content: string, attachments: Array<{ url: string; filename: string }>) {
  let thread = await getOpenThreadByUserId(userId);

  if (!thread) {
    const threadId = await nextThreadId();
    const channelId = await createModmailChannel(userId, username, threadId);
    thread = await saveOpenThread(userId, channelId, threadId);

    await sendChannelMessage(channelId, {
      embeds: [createEmbed("New Modmail Thread", `Thread #${thread.id} opened for <@${userId}> (${username}).`)]
    });
  }

  await sendChannelMessage(thread.channelId, {
    embeds: [buildForwardEmbed(username, userId, content, attachments)]
  });
}

async function handleReplyCommand(interaction: CommandInteraction): Promise<void> {

  const thread = await getOpenThreadByChannelId(interaction.channelID);
  if (!thread) {
    await interaction.createMessage({ embeds: [createEmbed("Modmail", "This command can only be used inside an open modmail channel.")], flags: 64 });
    return;
  }

  const reply = interaction.data.options.getString("message");
  if (!reply) {
    await interaction.createMessage({ embeds: [createEmbed("Modmail", "Please provide a reply message.")], flags: 64 });
    return;
  }

  await sendUserEmbed(thread.userId, "Staff Reply", reply);
  await interaction.createMessage({ embeds: [createEmbed("Reply Sent", "Your reply has been delivered to the user.")], flags: 64 });
  await sendChannelMessage(interaction.channelID, { embeds: [buildStaffReplyEmbed(reply)] });
}

async function handleCloseCommand(interaction: CommandInteraction): Promise<void> {
  const thread = await getOpenThreadByChannelId(interaction.channelID);
  if (!thread) {
    await interaction.createMessage({ embeds: [createEmbed("Modmail", "This command can only be used inside an open modmail channel.")], flags: 64 });
    return;
  }

  await closeThreadByChannelId(interaction.channelID);
  await sendUserEmbed(thread.userId, "Thread Closed", "Your modmail thread has been closed. If you need anything else, feel free to DM me again.");

  await interaction.createMessage({ embeds: [createEmbed("Thread Closed", `Thread #${thread.id} has been closed and the user has been notified. \n\n⚠ This channel will be deleted in 60 seconds.`)] });

  setInterval(async () => {
    await interaction.channel.delete();
  }, 60000);
}

client.once("ready", () => {
  client.editStatus("online", [{ name: "your smile (ღゝ◡╹)ノ♡", type: ActivityTypes.WATCHING }]);
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot || message.webhookID) return;

    const isDm = !message.guildID;
    if (!isDm) return;

    const attachments = Array.from(message.attachments.values()).map((attachment) => ({
      url: attachment.url,
      filename: attachment.filename
    }));

    const openThread = await getOpenThreadByUserId(message.author.id);
    if (openThread) {
      await forwardUserMessageToThread(message.author.id, message.author.tag, message.content ?? "", attachments);
      return;
    }

    const existingPending = pendingConfirmations.get(message.author.id);
    if (existingPending) {
      existingPending.messages.push({ content: message.content ?? "", attachments });
      await message.author.createDM().then(channel => {
        channel.createMessage({
          embeds: [createEmbed("Pending Confirmation", "Your message is queued, but you still need to press **Accept** before it is sent to the staff team.")]
        })
      });
      return;
    }

    pendingConfirmations.set(message.author.id, {
      userId: message.author.id,
      username: message.author.tag,
      messages: [{ content: message.content ?? "", attachments }]
    });

    await message.author.createDM().then(channel => {
      channel.createMessage({
        embeds: [createEmbed("Contact Staff Team", "You are about to contact the staff team. Press **Accept** to create a modmail thread or **Deny** to cancel.")],
        components: [
          {
            type: 1,
            components: [
              { type: 2, style: 3, label: "Accept", customID: CONFIRM_ACCEPT_ID },
              { type: 2, style: 4, label: "Deny", customID: CONFIRM_DENY_ID }
            ]
          }
        ]
      })
    });

  } catch (error) {
    console.error("messageCreate error", error);
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.type === InteractionTypes.MESSAGE_COMPONENT) {
      const componentInteraction = interaction as ComponentInteraction;
      if (!componentInteraction.isButtonComponentInteraction()) return;

      const pending = pendingConfirmations.get(componentInteraction.user.id);
      if (!pending) {
        await componentInteraction.createMessage({ embeds: [createEmbed("Modmail", "This confirmation is no longer valid. Please DM me again.")], flags: 64 });
        return;
      }

      if (componentInteraction.data.customID === CONFIRM_DENY_ID) {
        pendingConfirmations.delete(componentInteraction.user.id);
        await componentInteraction.message.edit({
          components: [
            {
              type: 1,
              components: [
                { type: 2, style: 3, label: "Accept", customID: CONFIRM_ACCEPT_ID, disabled: true },
                { type: 2, style: 4, label: "Deny", customID: CONFIRM_DENY_ID, disabled: true }
              ]
            }
          ]
        });
        await componentInteraction.createMessage({ embeds: [createEmbed("Thread Cancelled", "Your modmail thread has been cancelled.")] });
        return;
      }

      if (componentInteraction.data.customID === CONFIRM_ACCEPT_ID) {
        pendingConfirmations.delete(componentInteraction.user.id);
        for (const queuedMessage of pending.messages) {
          await forwardUserMessageToThread(pending.userId, pending.username, queuedMessage.content, queuedMessage.attachments);
        }
        await componentInteraction.message.edit({
          components: [
            {
              type: 1,
              components: [
                { type: 2, style: 3, label: "Accept", customID: CONFIRM_ACCEPT_ID, disabled: true },
                { type: 2, style: 4, label: "Deny", customID: CONFIRM_DENY_ID, disabled: true }
              ]
            }
          ]
        });
        await componentInteraction.createMessage({ embeds: [createEmbed("Thread Created", "Your modmail thread has been created. Please continue chatting here and the staff team will receive your messages.")] });
        return;
      }

      return;
    }

    if (interaction.type !== InteractionTypes.APPLICATION_COMMAND || !interaction.isChatInputCommand()) return;

    if (interaction.data.name === "ping") {
      await interaction.createMessage({ embeds: [createEmbed("Pong!", `${client.shards.get(0)?.latency ?? 0}ms`)], flags: 64 });
      return;
    }

    if (interaction.data.name === "about") {
      await interaction.createMessage({
        embeds: [{
          title: `${client.user.username}`,
          description: "i am a discord bot to help within the VoidChan ecosystem!",
          color: 0x9b87f5
        }],
        flags: 64
      });
      return;
    }

    if (interaction.data.name === "reply") {
      await handleReplyCommand(interaction);
      return;
    }

    if (interaction.data.name === "close") {
      await handleCloseCommand(interaction);
      return;
    }
  } catch (error) {
    console.error("interactionCreate error", error);
    if (!interaction.acknowledged) {
      await (interaction as CommandInteraction).createMessage({ embeds: [createEmbed("Error", "Something went wrong.")], flags: 64 });
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
  await initializeModmailStore();
  await client.connect();
  app.listen(config.port, () => {
    console.log(`Web server listening on ${config.baseUrl}`);
  });
}

start().catch((error) => {
  console.error("Startup failure", error);
  process.exit(1);
});

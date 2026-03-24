import { Permissions } from "oceanic.js";

export const slashCommands = [
  {
    name: "ping",
    description: "Check whether the bot is alive."
  },
  {
    name: "about",
    description: "Show information about this bot."
  },
  {
    name: "reply",
    description: "Reply to the user in this modmail thread.",
    default_member_permissions: Permissions.KICK_MEMBERS.toString(),
    options: [
      {
        type: 3,
        name: "message",
        description: "The message you want to send to the user.",
        required: true
      }
    ]
  },
  {
    name: "close",
    description: "Close the current modmail thread.",
    default_member_permissions: Permissions.KICK_MEMBERS.toString(),
  }
] as const;

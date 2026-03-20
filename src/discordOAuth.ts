import { config } from "./config.ts";

async function formPost<T>(url: string, body: URLSearchParams): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord OAuth request failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<T>;
}

export async function exchangeDiscordCode(code: string) {
  return formPost<{
    access_token: string;
    refresh_token: string;
    token_type: string;
    scope: string;
    expires_in: number;
  }>("https://discord.com/api/oauth2/token", new URLSearchParams({
    client_id: config.discordClientId,
    client_secret: config.discordClientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: config.discordRedirectUri
  }));
}

export async function getDiscordUser(accessToken: string) {
  const response = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord user request failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<{ id: string; username: string; global_name?: string | null }>;
}

export async function updateRoleConnection(accessToken: string, platformUsername: string, hasContributed: boolean) {
  const response = await fetch(`https://discord.com/api/users/@me/applications/${config.applicationId}/role-connection`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      platform_name: "GitHub",
      platform_username: platformUsername,
      metadata: {
        has_contributed: hasContributed ? 1 : 0
      }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord role connection update failed (${response.status}): ${text}`);
  }

  return response.json();
}

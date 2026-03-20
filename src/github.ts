import { config } from "./config.ts";

const contributorCache = new Map<string, { expiresAt: number; isContributor: boolean }>();

async function githubRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Accept": "application/vnd.github+json",
      "User-Agent": "voidchan-linked-roles-bot",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub request failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<T>;
}

export async function exchangeGithubCode(code: string) {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      client_id: config.githubClientId,
      client_secret: config.githubClientSecret,
      code,
      redirect_uri: config.githubRedirectUri
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub token exchange failed (${response.status}): ${text}`);
  }

  const data = await response.json() as { access_token?: string; error?: string; error_description?: string };
  if (!data.access_token) {
    throw new Error(data.error_description ?? data.error ?? "GitHub did not return an access token.");
  }

  return data.access_token;
}

export async function getGithubUser(accessToken: string) {
  return githubRequest<{ login: string; id: number; html_url: string }>("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
}

export async function hasContributedToRepo(login: string): Promise<boolean> {
  const cacheKey = login.toLowerCase();
  const cached = contributorCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.isContributor;

  let page = 1;
  while (page <= 20) {
    const contributors = await githubRequest<Array<{ login?: string }>>(
      `https://api.github.com/repos/${config.repoOwner}/${config.repoName}/contributors?per_page=100&page=${page}`
    );

    if (contributors.length === 0) break;
    const found = contributors.some((user) => user.login?.toLowerCase() === cacheKey);
    if (found) {
      contributorCache.set(cacheKey, { isContributor: true, expiresAt: Date.now() + 1000 * 60 * 60 });
      return true;
    }

    if (contributors.length < 100) break;
    page += 1;
  }

  contributorCache.set(cacheKey, { isContributor: false, expiresAt: Date.now() + 1000 * 60 * 15 });
  return false;
}

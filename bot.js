import "dotenv/config";
import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder } from "discord.js";

const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID || "1552458677821382656";
const ownerUserId = process.env.JOINDEV_OWNER_ID || "1459373221756538923";
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const discordApiBase = "https://discord.com/api/v10";
const orderPollMs = Number(process.env.JOINDEV_ORDER_POLL_MS || 30_000);
const verificationPollMs = Number(process.env.JOINDEV_VERIFY_POLL_MS || 10 * 60_000);
const retentionMs = Number(process.env.JOINDEV_RETENTION_MS || 3 * 24 * 60 * 60 * 1000);

if (!token) {
  throw new Error("Missing DISCORD_BOT_TOKEN. Save it as an environment secret before starting the bot.");
}

const hasSupabase = Boolean(supabaseUrl && supabaseServiceRoleKey);

if (!hasSupabase) {
  console.warn(
    "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing. The bot will still come online and DM the owner, but .Join and automatic orders will not work until Supabase is configured.",
  );
}

const commands = [
  new SlashCommandBuilder().setName("joindev").setDescription("Show JoinDev growth help and OAuth setup info"),
  new SlashCommandBuilder().setName("serverlimit").setDescription("Explain Discord's 100-server account limit"),
].map((command) => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log("JoinDev slash commands registered.");
}

function requireSupabase() {
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error(
      "Supabase is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to the bot host environment, then restart the bot.",
    );
  }
}

function supabaseHeaders(extra = {}) {
  requireSupabase();
  return {
    apikey: supabaseServiceRoleKey,
    Authorization: `Bearer ${supabaseServiceRoleKey}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

function isoFromNow(ms) {
  return new Date(Date.now() + ms).toISOString();
}

async function supabaseFetch(path, options = {}) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase request failed: ${res.status} ${text}`);
  }
  return res;
}

async function fetchAuthorizedUsers(limit) {
  const maxRows = Math.max(1, Math.min(Number(limit) || 1, 1000));
  const url = new URL(`${supabaseUrl}/rest/v1/users`);
  url.searchParams.set("select", "id,discord_id,username,access_token,guild_count");
  url.searchParams.set("order", "created_at.asc");
  url.searchParams.set("limit", String(maxRows));

  const res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) throw new Error(`Could not load authorized users: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function countAuthorizedUsers() {
  const url = new URL(`${supabaseUrl}/rest/v1/users`);
  url.searchParams.set("select", "id");

  const res = await fetch(url, {
    method: "HEAD",
    headers: supabaseHeaders({ Prefer: "count=exact" }),
  });

  if (!res.ok) return 0;

  const range = res.headers.get("content-range") || "0-0/0";
  return Number(range.split("/")[1] || 0);
}

async function fetchPendingMemberRequests(limit = 3) {
  const url = new URL(`${supabaseUrl}/rest/v1/member_requests`);
  url.searchParams.set("select", "id,user_id,guild_id,requested_members,cost,status,created_at");
  url.searchParams.set("status", "eq.pending");
  url.searchParams.set("order", "created_at.asc");
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) throw new Error(`Could not load pending member requests: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function claimMemberRequest(requestId) {
  const url = new URL(`${supabaseUrl}/rest/v1/member_requests`);
  url.searchParams.set("id", `eq.${requestId}`);
  url.searchParams.set("status", "eq.pending");

  const res = await fetch(url, {
    method: "PATCH",
    headers: supabaseHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify({ status: "processing" }),
  });

  if (!res.ok) throw new Error(`Could not claim member request ${requestId}: ${res.status} ${await res.text()}`);

  const rows = await res.json();
  return rows[0] || null;
}

async function updateMemberRequestStatus(requestId, status) {
  const url = new URL(`${supabaseUrl}/rest/v1/member_requests`);
  url.searchParams.set("id", `eq.${requestId}`);

  const res = await fetch(url, {
    method: "PATCH",
    headers: supabaseHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify({ status }),
  });

  if (!res.ok) throw new Error(`Could not update member request ${requestId}: ${res.status} ${await res.text()}`);
}

async function insertTrackedAdds(rows) {
  if (rows.length === 0) return;

  await supabaseFetch("member_request_adds", {
    method: "POST",
    headers: supabaseHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify(rows),
  });
}

async function fetchRequestAdds(requestId) {
  const url = new URL(`${supabaseUrl}/rest/v1/member_request_adds`);
  url.searchParams.set("select", "id,request_id,user_id,discord_id,guild_id,status,joined_at,verify_after,checked_at");
  url.searchParams.set("request_id", `eq.${requestId}`);
  url.searchParams.set("status", "eq.monitoring");
  url.searchParams.set("order", "created_at.asc");

  const res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) throw new Error(`Could not load tracked adds for ${requestId}: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function fetchDueMonitoringRequests(limit = 5) {
  const now = new Date().toISOString();
  const url = new URL(`${supabaseUrl}/rest/v1/member_requests`);
  url.searchParams.set("select", "id,user_id,guild_id,requested_members,cost,status,created_at");
  url.searchParams.set("status", "eq.monitoring");
  url.searchParams.set("order", "created_at.asc");
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) throw new Error(`Could not load monitoring requests: ${res.status} ${await res.text()}`);

  const requests = await res.json();
  const due = [];

  for (const request of requests) {
    const adds = await fetchRequestAdds(request.id);
    if (adds.length > 0 && adds.every((add) => new Date(add.verify_after).getTime() <= new Date(now).getTime())) {
      due.push({ ...request, adds });
    }
  }

  return due;
}

async function updateTrackedAddStatus(addId, status) {
  const url = new URL(`${supabaseUrl}/rest/v1/member_request_adds`);
  url.searchParams.set("id", `eq.${addId}`);

  const res = await fetch(url, {
    method: "PATCH",
    headers: supabaseHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify({ status, checked_at: new Date().toISOString() }),
  });

  if (!res.ok) throw new Error(`Could not update tracked add ${addId}: ${res.status} ${await res.text()}`);
}

async function addUserToGuild(guildId, discordUserId, accessToken) {
  const res = await fetch(`${discordApiBase}/guilds/${guildId}/members/${discordUserId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ access_token: accessToken }),
  });

  if (res.status === 201 || res.status === 204) {
    return { ok: true, status: res.status };
  }

  return {
    ok: false,
    status: res.status,
    error: await res.text(),
  };
}

async function isMemberStillInGuild(guildId, discordUserId) {
  const res = await fetch(`${discordApiBase}/guilds/${guildId}/members/${discordUserId}`, {
    headers: {
      Authorization: `Bot ${token}`,
    },
  });

  if (res.status === 200) return true;
  if (res.status === 404) return false;

  throw new Error(`Could not check guild member ${discordUserId}: ${res.status} ${await res.text()}`);
}

async function leaveGuild(guildId) {
  const res = await fetch(`${discordApiBase}/users/@me/guilds/${guildId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bot ${token}`,
    },
  });

  if (res.status === 204) return true;

  console.warn(`Could not leave guild ${guildId}: ${res.status} ${await res.text()}`);
  return false;
}

async function sendOwnerStartupDm(client) {
  const totalAuthorized = hasSupabase ? await countAuthorizedUsers().catch(() => 0) : null;
  const owner = await client.users.fetch(ownerUserId);

  await owner.send(
    [
      `JoinDev is online as ${client.user?.tag}.`,
      hasSupabase ? `Authorized users available: ${totalAuthorized}` : "Supabase is not configured yet, so `.Join` is not ready.",
      hasSupabase
        ? "Automatic orders are enabled: I add paid member requests, monitor added members for 3 days, then mark the order complete/partial/failed and leave the server."
        : "Automatic website order processing is disabled until Supabase is configured.",
      "Owner command:",
      "`.Join <server_id> <amount|a|all>`",
      "Example: `.Join 123456789012345678 25`",
      "Use `a` or `all` to attempt every authorized user.",
    ].join("\n"),
  );
}

function parseJoinCommand(content) {
  const parts = content.trim().split(/\s+/);

  if (parts[0]?.toLowerCase() !== ".join") return null;

  const guildId = parts[1];
  const amountText = parts[2];

  if (!guildId || !/^\d{15,25}$/.test(guildId)) {
    return {
      error: "Usage: `.Join <server_id> <amount|a|all>` — server ID must be numeric.",
    };
  }

  if (!amountText) {
    return {
      error: "Usage: `.Join <server_id> <amount|a|all>` — include a number, `a`, or `all`.",
    };
  }

  if (["a", "all"].includes(amountText.toLowerCase())) {
    return {
      guildId,
      all: true,
      amount: 1000,
    };
  }

  const amount = Number(amountText);

  if (!Number.isInteger(amount) || amount <= 0) {
    return {
      error: "Amount must be a positive number, `a`, or `all`.",
    };
  }

  return {
    guildId,
    all: false,
    amount: Math.min(amount, 1000),
  };
}

async function runAddMembersJob(guildId, amount, requestId = null) {
  const users = await fetchAuthorizedUsers(amount);
  let joined = 0;
  let alreadyOrSkipped = 0;
  const failures = [];
  const trackedAdds = [];

  for (const user of users) {
    if (!user.discord_id || !user.access_token) {
      alreadyOrSkipped += 1;
      continue;
    }

    const result = await addUserToGuild(guildId, user.discord_id, user.access_token);

    if (result.ok) {
      joined += 1;

      if (requestId) {
        trackedAdds.push({
          request_id: requestId,
          user_id: user.id,
          discord_id: user.discord_id,
          guild_id: guildId,
          status: "monitoring",
          verify_after: isoFromNow(retentionMs),
        });
      }
    } else {
      failures.push({
        discordId: user.discord_id,
        status: result.status,
        error: result.error,
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  if (trackedAdds.length > 0) {
    await insertTrackedAdds(trackedAdds);
  }

  return {
    attempted: users.length,
    joined,
    alreadyOrSkipped,
    failures,
    trackedAdds: trackedAdds.length,
  };
}

function formatJobSummary(guildId, result) {
  const failurePreview = result.failures
    .slice(0, 5)
    .map((failure) => `- ${failure.discordId}: ${failure.status}`)
    .join("\n");

  return [
    `JoinDev job finished for server \`${guildId}\`.`,
    `Attempted: ${result.attempted}`,
    `Joined/new or accepted: ${result.joined}`,
    `Monitoring for 3 days: ${result.trackedAdds || 0}`,
    `Skipped: ${result.alreadyOrSkipped}`,
    `Failed: ${result.failures.length}`,
    failurePreview ? `First failures:\n${failurePreview}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function handleOwnerJoinCommand(message, parsed) {
  if (parsed.error) {
    await message.reply(parsed.error);
    return;
  }

  if (!hasSupabase) {
    await message.reply("Supabase is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then restart me.");
    return;
  }

  await message.reply(
    `Starting manual JoinDev add-members job for server \`${parsed.guildId}\` with ${
      parsed.all ? "all authorized users" : `${parsed.amount} authorized users`
    }...`,
  );

  const result = await runAddMembersJob(parsed.guildId, parsed.amount, null);

  if (result.attempted === 0) {
    await message.channel.send("No authorized users found yet. Users must log in through the website first.");
    ret

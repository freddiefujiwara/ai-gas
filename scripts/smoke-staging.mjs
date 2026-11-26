// Manual smoke check for the ai-gas STAGING deployment.
//
// Why this is a manual script and not a CI step: the staging API token
// is an Apps Script script property, not a GitHub secret, and the
// staging /exec URL is likewise only kept in the owner's local secret
// file. Wiring this into CI would mean registering new GitHub secrets,
// which is a deliberate, separate decision. Until then, run this by
// hand after a staging deploy when rename/delete behaviour changes.
//
// Usage (values come from the owner's mode-600 staging.env, whose keys
// are STAGING_EXEC / STAGING_API_TOKEN; AI_GAS_STAGING_* also work):
//
//   set -a; . /path/to/staging.env; set +a
//   node scripts/smoke-staging.mjs            # read-only: list
//   node scripts/smoke-staging.mjs --write    # ask -> rename -> clear -> delete
//
// The --write cycle creates one dummy conversation on staging. "ask"
// sends a real email to Muse, so the dummy text is kept to a single
// short line, and the conversation is deleted again before the script
// exits (sheet rows only; the mail thread itself is not deleted).
// No token or URL is ever printed.

const EXEC_URL = process.env.AI_GAS_STAGING_EXEC || process.env.STAGING_EXEC || "";
const TOKEN = process.env.AI_GAS_STAGING_TOKEN || process.env.STAGING_API_TOKEN || "";
const WRITE = process.argv.includes("--write");

if (!EXEC_URL || !TOKEN) {
  console.error(
    "Missing staging exec URL / API token. Set STAGING_EXEC and STAGING_API_TOKEN " +
      "(or AI_GAS_STAGING_EXEC / AI_GAS_STAGING_TOKEN) in the environment first.",
  );
  process.exit(2);
}

async function get(params) {
  const res = await fetch(`${EXEC_URL}?${new URLSearchParams(params)}`);
  return res.json();
}

async function post(body) {
  const res = await fetch(EXEC_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body),
  });
  return res.json();
}

function check(label, cond) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
  return cond;
}

const list = await get({ token: TOKEN, action: "list" });
check("list returns ok", list.ok === true);
const first = Array.isArray(list.requests) ? list.requests[0] : null;
if (first) {
  check("list items carry title and preview fields", "title" in first && "preview" in first);
} else {
  console.log("SKIP list field check (no conversations on staging yet)");
}

if (!WRITE) {
  console.log("Read-only smoke done. Pass --write for the ask/rename/delete cycle.");
  process.exit(process.exitCode || 0);
}

const asked = await post({ token: TOKEN, action: "ask", prompt: "スモーク確認テスト" });
if (!check("ask creates a conversation", asked.ok === true && typeof asked.id === "string")) {
  process.exit(1);
}
const id = asked.id;
console.log(`INFO test conversation id: ${id}`);
try {
  const renamed = await post({ token: TOKEN, action: "rename", id, title: "スモーク確認テスト用" });
  check("rename sets the title", renamed.ok === true && renamed.title === "スモーク確認テスト用");

  const result = await get({ token: TOKEN, action: "result", id });
  check("result returns the renamed title", result.ok === true && result.title === "スモーク確認テスト用");

  const cleared = await post({ token: TOKEN, action: "rename", id, title: "" });
  check("rename with an empty title clears it", cleared.ok === true && cleared.title === "");
} finally {
  const deleted = await post({ token: TOKEN, action: "delete", id });
  check("delete removes the test conversation", deleted.ok === true);
}

const after = await get({ token: TOKEN, action: "result", id });
check("result after delete is an error", after.ok === false);
const listAfter = await get({ token: TOKEN, action: "list" });
check(
  "list after delete no longer contains the test conversation",
  Array.isArray(listAfter.requests) && !listAfter.requests.some((r) => r.id === id),
);

console.log(process.exitCode ? "Smoke FAILED" : "Smoke passed (test conversation deleted)");

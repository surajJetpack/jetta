/**
 * Does CONSOLE_USER_<NAME> add one login without disturbing the lists?
 *
 *   npx tsx scripts/console-user-vars-test.ts
 *
 * No network, no model. The lists (CONSOLE_USERS, CONSOLE_USERS_EXTRA) are
 * write-only on Vercel, so a colleague could only be added by retyping every
 * password already there. A variable per person avoids that, and this holds
 * it to the three things that matter: the login works, it is a general user
 * unless named an admin, and the existing logins are untouched.
 */
export {};

// Before ANY import: lib/config.ts snapshots process.env on first load.
process.env.STUB_MODE = "true";
for (const k of Object.keys(process.env)) if (k.startsWith("CONSOLE_")) delete process.env[k];
process.env.CONSOLE_USERS = "boss:pw-boss,agent:pw-agent";
process.env.CONSOLE_USERS_EXTRA = "extra:pw:with:colons";
process.env.CONSOLE_ADMINS = "boss";
process.env.SESSION_SECRET = "user-vars-test-secret-do-not-use-in-prod";
process.env.CONSOLE_USER_NIRANJAN = "pw-niranjan";
process.env.CONSOLE_USER_MARY_ANN = "pw:mary";
process.env.CONSOLE_USER_AGENT = "pw-agent-new";
process.env.CONSOLE_USER_COMMA = "half,other:injected";
process.env.CONSOLE_USER_EMPTY = "";
process.env["CONSOLE_USER_lower"] = "pw-lower";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  if (!ok || process.argv.includes("--verbose")) {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${!ok && detail ? `\n        ${detail}` : ""}`);
  }
}

async function main() {
  const { perPersonLogins } = await import("../lib/config");
  const { parseUsers, createSession, verifySession } = await import("../lib/console-auth");
  const { roleOf } = await import("../lib/roles");
  const users = parseUsers();
  const names = [...users.keys()].sort().join(",");

  check("a per-person variable is a login, named in lower case", users.get("niranjan") === "pw-niranjan", names);
  check("an underscore in the name is kept", users.get("mary_ann") === "pw:mary", names);
  check("the list logins still work", users.get("boss") === "pw-boss" && users.get("extra") === "pw:with:colons", names);
  check("a name in both uses the per-person password", users.get("agent") === "pw-agent-new");
  check("a password with a comma adds no login at all", !users.has("comma") && !users.has("other"), names);
  check("an empty variable adds no login", !users.has("empty"), names);
  check("a lower-case variable name is not a login", !users.has("lower"), names);
  check("the list variables are not read as people", !users.has("s") && !users.has("s_extra"), names);
  check("the new login is a general user", roleOf("niranjan") === "general");
  check("an admin stays an admin", roleOf("boss") === "admin");
  check("a session for the new login verifies", verifySession(createSession("niranjan")) === "niranjan");
  check("nothing set means nothing added", perPersonLogins({ CONSOLE_USERS: "a:b" }) === undefined);

  if (failures) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("console-user-vars: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

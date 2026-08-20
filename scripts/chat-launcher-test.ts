/**
 * The launcher's branding, pinned.
 *
 * The launcher is the one part of the widget the embedding page owns, and for
 * a long time it was hardcoded near-black with a generic speech bubble — so a
 * brand could set a colour and a logo in the console, see them in the preview,
 * and still ship a black circle to its customers. It ignored accentColor,
 * avatarUrl, launcherLabel and launcherPosition alike, and nothing failed.
 *
 * There is no browser and no DOM library in this repo, so the loader is run
 * against a hand-rolled stub in node:vm. That is enough to answer the only
 * questions that matter here: does it paint from the cached brand before the
 * frame has said anything, and does it repaint when the frame does?
 *
 *   npx tsx scripts/chat-launcher-test.ts
 */
export {};

import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

let failures = 0;
function check(name: string, pass: boolean, detail?: string) {
  console.log(`${pass ? "  ok  " : "FAIL  "}${name}${!pass && detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
}

interface El {
  tagName: string;
  style: Record<string, string> & { cssText: string };
  children: El[];
  attrs: Record<string, string>;
  dataset: Record<string, string>;
  innerHTML: string;
  textContent?: string;
  title?: string;
  src?: string;
  appendChild(c: El): El;
  setAttribute(k: string, v: string): void;
  addEventListener(): void;
  onerror?: () => void;
}

function makeEl(tagName: string): El {
  const style = new Proxy({ cssText: "" } as Record<string, string>, {
    set(t, k: string, v: string) {
      t[k] = v;
      return true;
    },
  });
  return {
    tagName,
    style: style as El["style"],
    children: [],
    attrs: {},
    dataset: {},
    innerHTML: "",
    appendChild(c: El) {
      this.children.push(c);
      return c;
    },
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    },
    addEventListener() {},
  };
}

/** Run the loader against a stub DOM and hand back the pieces worth asserting on. */
function boot(
  cachedBrand: Record<string, unknown> | null,
  innerWidth = 1280,
  jettaConfig: Record<string, unknown> | undefined = undefined,
) {
  const created: El[] = [];
  const store: Record<string, string> = {};
  if (cachedBrand) store["jettachat.brand"] = JSON.stringify(cachedBrand);
  let onMessage: ((e: { origin: string; source: unknown; data: Record<string, unknown> }) => void) | null = null;

  const script = makeEl("script");
  script.src = "https://jetta.example.com/jettachat.js";
  const body = makeEl("body");
  const doc = {
    currentScript: script,
    readyState: "complete",
    body,
    createElement: (t: string) => {
      const el = makeEl(t);
      created.push(el);
      return el;
    },
    addEventListener: () => {},
  };
  const frameWindow = { postMessage: () => {} };
  const sandbox = {
    window: {
      addEventListener: (type: string, fn: typeof onMessage) => {
        if (type === "message") onMessage = fn;
      },
      innerWidth,
      parent: {},
      JettaChatConfig: jettaConfig,
    },
    document: doc,
    localStorage: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    },
    location: { href: "https://getsign.io/pricing", hostname: "getsign.io" },
    URL,
    JSON,
    Date,
    Number,
    String,
    Math,
    console,
    requestAnimationFrame: (fn: () => void) => fn(),
    setTimeout,
    clearTimeout,
    encodeURIComponent,
  };
  (sandbox.window as Record<string, unknown>).window = sandbox.window;
  const ctx = createContext(sandbox);
  runInContext(readFileSync("public/jettachat.js", "utf8"), ctx);

  const frame = created.find((e) => e.tagName === "iframe")!;
  (frame as unknown as { contentWindow: unknown }).contentWindow = frameWindow;
  const launcher = created.find((e) => e.tagName === "button")!;
  // The button is a pill: a 56px mark and a label beside it, in that DOM order
  // regardless of which side the launcher sits on (flex-direction does the
  // swapping, so the reading order never depends on the setting).
  const [icon, label] = launcher.children;
  const root = created.find((e) => e.attrs["data-jettachat"] !== undefined)!;
  const send = (data: Record<string, unknown>) =>
    onMessage?.({ origin: "https://jetta.example.com", source: frameWindow, data });
  return { launcher, icon, label, root, frame, send, store };
}

function main() {
  // ── Cold start, nothing cached ────────────────────────────────────
  const cold = boot(null);
  check("the frame is pointed at the brand it was installed for", cold.frame.src?.includes("product=getsign") === true, cold.frame.src);
  check("with no brand yet, the launcher shows the speech bubble", cold.icon.innerHTML.includes("<svg"));
  check("and stays on the default colour", cold.launcher.style.background === undefined || cold.launcher.style.background === "");
  check("and shows no label, because none has been reported yet", cold.label.style.display === "none");

  // ── The frame reports the live brand ──────────────────────────────
  cold.send({
    type: "jettachat:brand",
    brand: {
      accentColor: "#2563eb",
      avatarUrl: "data:image/png;base64,AAAA",
      launcherLabel: "Chat to GetSign",
      launcherPosition: "left",
    },
  });
  check("the launcher takes the brand colour", cold.launcher.style.background === "#2563eb", cold.launcher.style.background);
  check("the logo replaces the speech bubble", cold.icon.children.some((c) => c.tagName === "img" && c.src === "data:image/png;base64,AAAA"));
  check("the label becomes the button's tooltip", cold.launcher.title === "Chat to GetSign");
  check(
    "and, the point of all this, becomes text the visitor can read",
    cold.label.textContent === "Chat to GetSign" && cold.label.style.display === "block",
    `text=${JSON.stringify(cold.label.textContent)} display=${cold.label.style.display}`,
  );
  check(
    "the pill grows inward from the edge it is anchored to",
    cold.launcher.style.flexDirection === "row",
    cold.launcher.style.flexDirection,
  );
  check("a left-side launcher moves the whole widget", cold.root.style.left === "20px" && cold.root.style.right === "auto");
  check("the brand is cached for the next page view", !!cold.store["jettachat.brand"]);

  // ── A junk colour must not be applied ─────────────────────────────
  cold.send({ type: "jettachat:brand", brand: { accentColor: "red; background:url(x)" } });
  check(
    "a colour that isn't a hex value is ignored",
    cold.launcher.style.background === "#2563eb",
    `became ${cold.launcher.style.background}`,
  );

  // ── Warm start: the cache paints before the frame speaks ──────────
  const warm = boot({
    accentColor: "#2563eb",
    avatarUrl: "data:image/png;base64,AAAA",
    launcherLabel: "Chat to GetSign",
    launcherPosition: "left",
  });
  check("a cached brand paints immediately — no black flash", warm.launcher.style.background === "#2563eb");
  check("a cached logo shows immediately", warm.icon.children.some((c) => c.tagName === "img"));
  check("so does a cached label", warm.label.style.display === "block");
  check(
    "opening the panel retracts the label",
    (() => {
      warm.send({ type: "jettachat:autoopen" });
      return warm.label.style.display === "none";
    })(),
    `display=${warm.label.style.display}`,
  );

  // ── The embedding page can move the launcher out of the way ───────
  //
  // Inside a monday app view the corner is already taken and the collision is
  // with the PARENT page, which no z-index of ours can win — the widget is in
  // an iframe. Moving is the only fix, and the console's side setting can't
  // make it: that value is per brand, so it would move GetSign's website too.
  const moved = boot({ accentColor: "#2563eb", launcherPosition: "right" }, 1280, {
    surface: "monday",
    launcher: { position: "left", offsetY: 88 },
  });
  check(
    "the page's side wins over the brand setting",
    moved.root.style.left === "20px" && moved.root.style.right === "auto",
    `left=${moved.root.style.left} right=${moved.root.style.right}`,
  );
  check(
    "and the launcher lifts clear of whatever sits along the bottom",
    moved.root.style.cssText.includes("bottom:88px"),
    moved.root.style.cssText,
  );

  // A repaint must not quietly hand the position back to the brand setting —
  // the frame reports the brand a moment after load, which is exactly when a
  // launcher that has been moved would jump back under the thing it was moved
  // out from under.
  moved.send({ type: "jettachat:brand", brand: { accentColor: "#2563eb", launcherPosition: "right" } });
  check(
    "and it stays put when the frame reports the brand",
    moved.root.style.left === "20px" && moved.root.style.right === "auto",
    `left=${moved.root.style.left} right=${moved.root.style.right}`,
  );

  // The first view in a browser has no cached brand, so nothing has told the
  // loader which side the brand wants. The placement must still apply — if it
  // only landed on the brand repaint, the launcher would sit in the occupied
  // corner until the frame answered, which is where anyone reporting "it's
  // still on the right" would be looking.
  const coldMoved = boot(null, 1280, { surface: "monday", launcher: { position: "left" } });
  check(
    "placement applies on a first view, before any brand is known",
    coldMoved.root.style.left === "20px" && coldMoved.root.style.right === "auto",
    `left=${coldMoved.root.style.left} right=${coldMoved.root.style.right}`,
  );

  // Nothing passed = nothing changed, or every existing embed moves.
  const untouched = boot({ accentColor: "#2563eb", launcherPosition: "right" });
  check(
    "an embed that asks for nothing keeps the 20px corner it always had",
    untouched.root.style.cssText.includes("bottom:20px") && untouched.root.style.right === "20px",
    untouched.root.style.cssText,
  );

  // A page meaning 88 and passing "88px" must not park the launcher off-screen.
  const junk = boot({ accentColor: "#2563eb" }, 1280, { launcher: { offsetY: "88px", offsetX: 9999 } });
  check(
    "an unusable offset falls back rather than hiding the widget",
    junk.root.style.cssText.includes("bottom:20px") && junk.root.style.cssText.includes("right:240px"),
    junk.root.style.cssText,
  );

  // ── A phone gets the circle, not a pill across the page ───────────
  const narrow = boot({ accentColor: "#2563eb", launcherLabel: "Chat to GetSign" }, 390);
  check("on a narrow viewport the label stays folded away", narrow.label.style.display === "none");

  // The loader can only paint what the frame tells it. That half lives in
  // React and cannot be booted here, so it is asserted against its source —
  // deleting the post() call would otherwise leave every check above green.
  const frameSrc = readFileSync("app/chat/page.tsx", "utf8");
  check(
    "the frame publishes the brand to the embedding page",
    /post\("jettachat:brand"/.test(frameSrc),
    "without this the launcher only ever shows cached or default branding",
  );

  console.log(failures ? `\n${failures} failed.` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
}

main();
